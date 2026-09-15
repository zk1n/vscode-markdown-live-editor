import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { findMarkdownLinks, headingOffset } from "../../core/markdown/markdownLinks.js";
import { PROTOCOL_VERSION, type NavigateToHeadingMessage } from "../../protocol/messages.js";
import { getDocumentWriteCapability } from "./documentCapabilities.js";
import type {
  MarkdownEditorSessionHandle,
  MarkdownEditorSessionRegistry,
} from "./MarkdownEditorSessionRegistry.js";
import {
  MAX_IMAGE_BYTES,
  type RichRequest,
  type RichResponse,
} from "../../protocol/richMessages.js";

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Opaque target revision that cannot collide after a close/reopen version reset. */
export function linkedDocumentRevision(document: vscode.TextDocument, text: string): string {
  return createHash("sha256")
    .update(document.uri.toString())
    .update("\0")
    .update(String(document.version))
    .update("\0")
    .update(text)
    .digest("hex");
}

/**
 * Returns only the initial webview roots that are safe for this document.
 * Individual resolved image files are added by the session after realpath
 * validation.  A document directly under a filesystem root must not turn that
 * whole drive into a webview resource root.
 */
export function resourceRootsForDocument(document: vscode.TextDocument): readonly vscode.Uri[] {
  if (document.isUntitled || document.uri.scheme !== "file") return [];
  const workspace = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
  if (workspace?.scheme === "file" && isWithin(workspace.fsPath, document.uri.fsPath))
    return [workspace];
  const parent = path.dirname(document.uri.fsPath);
  return path.parse(parent).root === parent ? [document.uri] : [vscode.Uri.file(parent)];
}

interface LocalResourceScope {
  readonly documentPath: string;
  readonly rootPath: string;
  readonly standaloneFilesystemRoot: boolean;
}
function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

export function localMarkdownTarget(
  documentPath: string,
  rootPath: string,
  target: string,
): { path: string; fragment: string } {
  if (
    hasControlCharacters(target) ||
    /^[a-z][a-z\d+.-]*:/iu.test(target) ||
    /^(?:\\|\/\/)/u.test(target)
  )
    throw new Error("このリンク形式は許可されていません。");
  const fragmentAt = target.indexOf("#");
  const encodedPath = fragmentAt < 0 ? target : target.slice(0, fragmentAt);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    throw new Error("パスのURLエンコードが不正です。");
  }
  if (
    hasControlCharacters(decoded) ||
    /^[a-z][a-z\d+.-]*:/iu.test(decoded) ||
    /^(?:\\|\/\/)/u.test(decoded)
  )
    throw new Error("このパスは許可されていません。");
  const resolved =
    decoded === ""
      ? documentPath
      : decoded.startsWith("/")
        ? path.resolve(rootPath, `.${decoded}`)
        : path.resolve(path.dirname(documentPath), decoded);
  if (!isWithin(rootPath, resolved))
    throw new Error("ワークスペース外のファイルは参照できません。");
  return { path: resolved, fragment: fragmentAt < 0 ? "" : target.slice(fragmentAt + 1) };
}

export function imageExtension(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
  )
    return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  const header = new TextDecoder("ascii").decode(bytes.slice(0, 12));
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return ".gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return ".webp";
  return undefined;
}

interface PendingLinkNavigation {
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly targetOffset: number;
  readonly highlightFrom: number;
  readonly highlightTo: number;
  lifecycle: vscode.Disposable;
}

/**
 * Opens local links through VS Code's public default-editor resolver. A
 * selection reaches a text editor through `vscode.open`; a Live Editor needs
 * its existing, controller-bound presentation message after it becomes ready.
 */
export class MarkdownLinkNavigator {
  private readonly pending = new Map<string, PendingLinkNavigation>();

  public constructor(private readonly sessions?: MarkdownEditorSessionRegistry) {}

  public async open(
    document: vscode.TextDocument,
    selection: vscode.Range,
    navigation: Omit<PendingLinkNavigation, "documentUri" | "documentVersion" | "lifecycle">,
  ): Promise<void> {
    const pending: PendingLinkNavigation = {
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      ...navigation,
      lifecycle: vscode.Disposable.from(),
    };
    // A newer explicit navigation supersedes any still-opening destination.
    for (const previous of this.pending.values()) this.remove(previous);
    this.pending.set(pending.documentUri, pending);
    try {
      await vscode.commands.executeCommand("vscode.open", document.uri, {
        preview: true,
        selection,
      });
    } catch (error) {
      this.removeIfCurrent(pending);
      throw error;
    }
    this.deliverToActiveOrDiscard(pending);
  }

  /** Called after a current controller reports its state, not merely registration. */
  public deliverWhenReady(
    document: vscode.TextDocument,
    session: MarkdownEditorSessionHandle,
    active: boolean,
  ): void {
    if (!active || session.documentUri !== document.uri.toString()) return;
    const pending = this.pending.get(document.uri.toString());
    if (pending === undefined) return;
    if (pending.documentVersion !== document.version) {
      this.remove(pending);
      return;
    }
    if (!this.isCurrent(pending)) return;
    this.deliver(session, pending);
  }

  private deliverToActiveOrDiscard(pending: PendingLinkNavigation): void {
    if (!this.isCurrent(pending)) return;
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const activeInput = activeTab?.input;
    if (
      activeInput instanceof vscode.TabInputText &&
      activeInput.uri.toString() === pending.documentUri
    ) {
      this.remove(pending);
      return;
    }
    if (
      !(activeInput instanceof vscode.TabInputCustom) ||
      activeInput.uri.toString() !== pending.documentUri ||
      activeTab === undefined
    ) {
      this.remove(pending);
      return;
    }
    pending.lifecycle = vscode.window.tabGroups.onDidChangeTabs((): void => {
      if (!this.isCurrent(pending)) return;
      if (vscode.window.tabGroups.activeTabGroup.activeTab !== activeTab) this.remove(pending);
    });
    const ready = this.sessions?.activeStatusSession;
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === pending.documentUri,
    );
    if (
      ready?.handle.documentUri === pending.documentUri &&
      ready.editorState.documentVersion === pending.documentVersion &&
      document?.version === pending.documentVersion
    )
      this.deliver(ready.handle, pending);
  }

  private deliver(session: MarkdownEditorSessionHandle, pending: PendingLinkNavigation): void {
    if (!this.isCurrent(pending)) return;
    this.remove(pending);
    const message: NavigateToHeadingMessage = {
      kind: "navigate-to-heading",
      protocolVersion: PROTOCOL_VERSION,
      documentUri: pending.documentUri,
      documentVersion: pending.documentVersion,
      sessionId: session.sessionId,
      targetOffset: pending.targetOffset,
      highlightFrom: pending.highlightFrom,
      highlightTo: pending.highlightTo,
    };
    void Promise.resolve(session.postMessage(message)).catch((): void => undefined);
  }

  private isCurrent(pending: PendingLinkNavigation): boolean {
    return this.pending.get(pending.documentUri) === pending;
  }

  private removeIfCurrent(pending: PendingLinkNavigation): void {
    if (this.isCurrent(pending)) this.remove(pending);
  }

  private remove(pending: PendingLinkNavigation | undefined): void {
    if (pending === undefined) return;
    pending.lifecycle.dispose();
    if (this.pending.get(pending.documentUri) === pending) this.pending.delete(pending.documentUri);
  }
}

/** File writes occur only for an explicit picker/paste/drop request. */
export async function storeAttachment(
  documentPath: string,
  rootPath: string,
  directory: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("画像は8 MiB以下にしてください。");
  const extension = imageExtension(bytes);
  if (extension === undefined) throw new Error("PNG / JPEG / GIF / WebP画像を選んでください。");
  if (!/^[\p{L}\p{N}_.-]{1,80}$/u.test(directory) || directory === "." || directory === "..")
    throw new Error("添付先は文書に隣接する単一フォルダー名を指定してください。");
  const rootReal = await realpath(rootPath);
  const documentReal = await realpath(documentPath);
  const parentReal = await realpath(path.dirname(documentPath));
  if (!isWithin(rootReal, documentReal) || !isWithin(rootReal, parentReal))
    throw new Error("文書がワークスペース外を参照しています。");
  const folder = path.join(parentReal, directory);
  await mkdir(folder, { recursive: true });
  const folderReal = await realpath(folder);
  if (!isWithin(rootReal, folderReal))
    throw new Error("添付先がワークスペース外を参照しています。");
  const stem =
    path
      .parse(path.basename(name.replace(/\\/gu, "/")))
      .name.replace(/[^\p{L}\p{N}_.-]/gu, "-")
      .slice(0, 60) || "image";
  const fileName = `${stem}-${randomUUID().slice(0, 8)}${extension}`;
  const target = path.join(folderReal, fileName);
  // wx is exclusive; neither same-name files nor symlinks can be overwritten.
  const file = await open(target, "wx");
  try {
    // Check the opened file, not only its parent before the asynchronous open.
    // A replaced directory must never receive the imported image contents.
    const targetReal = await realpath(target);
    if (!isWithin(rootReal, targetReal)) throw new Error("添付先が操作中に変更されました。");
    const opened = await file.stat();
    const resolved = await stat(targetReal);
    if (opened.dev !== resolved.dev || opened.ino !== resolved.ino)
      throw new Error("添付先が操作中に置き換えられました。");
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  return [directory, fileName].map((part) => encodeURIComponent(part)).join("/");
}

function requireTrustedWorkspace(): void {
  if (!vscode.workspace.isTrusted)
    throw new Error("画像の取り込みにはワークスペースの信頼が必要です。");
}

export class MarkdownResourceSession {
  private disposed = false;
  private importBusy = false;
  private resourceRevision = 0;
  private readonly imageWatches = new Map<string, vscode.Disposable & { targets: Set<string> }>();
  public constructor(
    private readonly document: vscode.TextDocument,
    private readonly webview: vscode.Webview,
    private readonly isCurrent: (request: RichRequest) => boolean,
    private readonly allowRemoteImages = false,
    private readonly onImagesChanged?: () => void,
    private readonly linkNavigator = new MarkdownLinkNavigator(),
  ) {}
  public dispose(): void {
    this.disposed = true;
    // An authorized vscode.open can dispose its source preview tab. The
    // destination navigation belongs to that open operation and stays valid.
    this.clearImageWatches();
  }
  private clearImageWatches(): void {
    for (const watcher of this.imageWatches.values()) watcher.dispose();
    this.imageWatches.clear();
  }
  public invalidateImages(): void {
    if (this.disposed) return;
    this.resourceRevision += 1;
    this.clearImageWatches();
    this.onImagesChanged?.();
  }
  public pruneImageWatches(source: string): void {
    const targets = new Set(
      findMarkdownLinks(source)
        .filter((link) => link.image)
        .map((link) => link.target),
    );
    for (const [filePath, watch] of this.imageWatches) {
      for (const target of watch.targets) if (!targets.has(target)) watch.targets.delete(target);
      if (watch.targets.size === 0) {
        watch.dispose();
        this.imageWatches.delete(filePath);
      }
    }
  }
  private watchImage(filePath: string, target: string): void {
    if (this.onImagesChanged === undefined) return;
    const existing = this.imageWatches.get(filePath);
    if (existing !== undefined) {
      existing.targets.add(target);
      return;
    }
    // Watch only the resolved image's directory; filter exact paths before
    // invalidation. No additional webview read permission is granted here.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(filePath)), "*"),
    );
    const changed = (uri: vscode.Uri): void => {
      if (path.relative(filePath, uri.fsPath) === "") this.invalidateImages();
    };
    const events = [
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
    ];
    this.imageWatches.set(filePath, {
      targets: new Set([target]),
      dispose: () => {
        for (const event of events) event.dispose();
        watcher.dispose();
      },
    });
  }
  private active(request: RichRequest): boolean {
    return !this.disposed && this.isCurrent(request);
  }

  public async receive(request: RichRequest): Promise<void> {
    if (!this.active(request)) return;
    const revision = this.resourceRevision;
    try {
      const result = await this.execute(request, revision);
      if (
        this.active(request) &&
        (request.operation !== "image-resolve" || revision === this.resourceRevision)
      )
        await this.webview.postMessage({
          ...request,
          kind: "rich-response",
          data: undefined,
          name: undefined,
          target: undefined,
          ok: true,
          ...result,
        });
    } catch (error) {
      if (this.active(request))
        await this.webview.postMessage({
          kind: "rich-response",
          protocolVersion: request.protocolVersion,
          documentUri: request.documentUri,
          sessionId: request.sessionId,
          controllerId: request.controllerId,
          requestId: request.requestId,
          documentVersion: request.documentVersion,
          ok: false,
          note: error instanceof Error ? error.message : "ファイル操作に失敗しました。",
        });
    }
  }

  private async execute(request: RichRequest, revision: number): Promise<Partial<RichResponse>> {
    if (request.operation === "image-pick" || request.operation === "image-import")
      return this.importImage(request);
    const target = request.target ?? "";
    if (/^https?:/iu.test(target)) {
      const url = new URL(target);
      if (url.username !== "" || url.password !== "")
        throw new Error("認証情報を含むURLは扱えません。");
      if (request.operation === "image-resolve") {
        if (url.protocol !== "https:" || !this.allowRemoteImages || !vscode.workspace.isTrusted)
          throw new Error("外部画像は無効です。必要な場合は設定でHTTPS画像を許可してください。");
        return { url: url.href };
      }
      if (request.operation === "link-open") {
        this.requireVersion(request);
        if (!(await vscode.env.openExternal(vscode.Uri.parse(url.href))))
          throw new Error("リンクを開けませんでした。");
        return {};
      }
      return {
        title: url.hostname,
        text: "外部ページは自動取得しません。Ctrl+クリックでブラウザーを開きます。",
      };
    }
    const scope = this.localResourceScope();
    if (
      scope.standaloneFilesystemRoot &&
      (request.operation === "image-resolve" || request.operation === "link-preview")
    )
      throw new Error(
        "ドライブまたは共有ルート直下の単体文書では、ローカル資源の自動読込は利用できません。対象を明示的に開いてください。",
      );
    const resolved = localMarkdownTarget(scope.documentPath, scope.rootPath, target);
    const rootReal = await realpath(scope.rootPath);
    const fileReal = await realpath(resolved.path);
    if (!isWithin(rootReal, fileReal))
      throw new Error("リンク先がワークスペース外を参照しています。");
    if (request.operation === "image-resolve") {
      if (!/\.(?:png|jpe?g|gif|webp|bmp|svg)$/iu.test(fileReal))
        throw new Error("対応する画像ファイルではありません。");
      const info = await stat(fileReal);
      if (!info.isFile() || info.size > 32 * 1024 * 1024)
        throw new Error("画像を読み込めません（上限32 MiB）。");
      if (!this.active(request) || revision !== this.resourceRevision)
        throw new Error("画像の表示先が変更されました。");
      const uri = vscode.Uri.file(fileReal);
      const roots = this.webview.options.localResourceRoots ?? [];
      // A file already covered by an allowed root needs no new grant. Updating
      // options here reloads some hosts and can interrupt the pending Paste.
      if (
        !roots.some(
          (candidate) => candidate.scheme === "file" && isWithin(candidate.fsPath, fileReal),
        )
      )
        this.webview.options = { ...this.webview.options, localResourceRoots: [...roots, uri] };
      this.watchImage(resolved.path, target);
      if (fileReal !== resolved.path) this.watchImage(fileReal, target);
      const version = [
        info.dev,
        info.ino,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
        this.resourceRevision,
      ].join("-");
      return {
        url: `${this.webview.asWebviewUri(uri).toString()}?v=${encodeURIComponent(version)}`,
      };
    }
    const markdown = /\.(?:md|markdown)$/iu.test(fileReal);
    if (!markdown) {
      if (request.operation === "link-preview")
        throw new Error("プレビューの対象はMarkdown文書です。");
      this.requireVersion(request);
      if (resolved.fragment !== "") throw new Error("見出し移動の対象はMarkdown文書です。");
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(resolved.path), {
        preview: true,
      });
      return {};
    }
    const info = await stat(fileReal);
    if (!info.isFile() || info.size > 2 * 1024 * 1024)
      throw new Error("リンク先文書が大きすぎます（上限2 MiB）。");
    // Uri uses the logical path so an already-open dirty TextDocument is reused.
    const targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.path));
    const text = targetDocument.getText();
    const targetVersion = linkedDocumentRevision(targetDocument, text);
    const offset = headingOffset(text, resolved.fragment);
    if (offset === undefined) throw new Error("指定された見出しが見つかりません。");
    if (request.operation === "link-preview") {
      if (request.targetVersion === targetVersion) return { targetVersion, unchanged: true };
      return {
        title: path.basename(resolved.path),
        text: text.slice(offset, offset + 12000),
        targetVersion,
      };
    }
    this.requireVersion(request);
    if (targetDocument.uri.toString() === this.document.uri.toString())
      return { offset: text.slice(0, offset).replace(/\r\n/gu, "\n").length };
    const heading = targetDocument.lineAt(targetDocument.positionAt(offset).line).range;
    const selection = new vscode.Range(heading.start, heading.end);
    const normalizedOffset = (rawOffset: number): number =>
      text.slice(0, rawOffset).replace(/\r\n/gu, "\n").length;
    await this.linkNavigator.open(targetDocument, selection, {
      targetOffset: normalizedOffset(offset),
      highlightFrom: normalizedOffset(targetDocument.offsetAt(heading.start)),
      highlightTo: normalizedOffset(targetDocument.offsetAt(heading.end)),
    });
    return {};
  }

  private localResourceScope(): LocalResourceScope {
    if (this.document.isUntitled)
      throw new Error("画像やローカル参照を使う前に、文書の保存先を指定してください。");
    if (this.document.uri.scheme !== "file")
      throw new Error("この種類の文書ではローカル資源を利用できません。");
    const workspace = vscode.workspace.getWorkspaceFolder(this.document.uri)?.uri;
    const documentPath = this.document.uri.fsPath;
    const standalone = workspace?.scheme !== "file" || !isWithin(workspace.fsPath, documentPath);
    const documentDirectory = path.dirname(documentPath);
    return {
      documentPath,
      rootPath: standalone ? documentDirectory : workspace.fsPath,
      standaloneFilesystemRoot:
        standalone && path.parse(documentDirectory).root === documentDirectory,
    };
  }
  private requireVersion(request: RichRequest): void {
    if (
      this.disposed ||
      !this.isCurrent(request) ||
      this.document.isClosed ||
      request.documentVersion !== this.document.version
    )
      throw new Error("文書が更新されました。もう一度操作してください。");
  }
  private async importImage(request: RichRequest): Promise<Partial<RichResponse>> {
    if (this.importBusy) throw new Error("画像の取り込み中です。");
    this.requireVersion(request);
    const scope = this.localResourceScope();
    if (scope.standaloneFilesystemRoot)
      throw new Error("ドライブまたは共有ルート直下の単体文書では、添付画像を作成できません。");
    requireTrustedWorkspace();
    this.importBusy = true;
    try {
      const capability = await getDocumentWriteCapability(this.document);
      if (!capability.writable) throw new Error(capability.reason ?? "この文書へ書き込めません。");
      this.requireVersion(request);
      let bytes: Uint8Array;
      let name = request.name ?? "image";
      if (request.operation === "image-pick") {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: false,
          canSelectFiles: true,
          canSelectFolders: false,
          title: "Markdownへ画像を挿入",
          filters: { 画像: ["png", "jpg", "jpeg", "gif", "webp"] },
        });
        const file = files?.[0];
        if (file === undefined) return {};
        if (file.scheme !== "file") throw new Error("ローカルの画像を選んでください。");
        const info = await stat(file.fsPath);
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES)
          throw new Error("画像は8 MiB以下にしてください。");
        bytes = await readFile(file.fsPath);
        name = path.basename(file.fsPath);
      } else {
        if (
          request.data === undefined ||
          !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(request.data)
        )
          throw new Error("画像データが不正です。");
        bytes = Buffer.from(request.data, "base64");
      }
      const currentCapability = await getDocumentWriteCapability(this.document);
      if (!currentCapability.writable)
        throw new Error(currentCapability.reason ?? "この文書へ書き込めません。");
      requireTrustedWorkspace();
      this.requireVersion(request);
      const directory = vscode.workspace
        .getConfiguration("vscodeMarkdownLiveEditor", this.document.uri)
        .get<string>("attachmentFolder", "attachments");
      const relative = await storeAttachment(
        scope.documentPath,
        scope.rootPath,
        directory,
        name,
        bytes,
      );
      this.requireVersion(request);
      const alt = path.parse(name).name.replace(/[[\]\\\r\n]/gu, "");
      return { markdown: `![${alt}](${relative})` };
    } finally {
      this.importBusy = false;
    }
  }
}
