import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { headingOffset } from "../../core/markdown/markdownLinks.js";
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

export class MarkdownResourceSession {
  private disposed = false;
  private importBusy = false;
  public constructor(
    private readonly document: vscode.TextDocument,
    private readonly webview: vscode.Webview,
    private readonly isCurrent: (request: RichRequest) => boolean,
    private readonly allowRemoteImages = false,
  ) {}
  public dispose(): void {
    this.disposed = true;
  }
  private active(request: RichRequest): boolean {
    return !this.disposed && this.isCurrent(request);
  }

  public async receive(request: RichRequest): Promise<void> {
    if (!this.active(request)) return;
    try {
      const result = await this.execute(request);
      if (this.active(request))
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

  private async execute(request: RichRequest): Promise<Partial<RichResponse>> {
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
    const root = this.workspaceRoot();
    const resolved = localMarkdownTarget(this.document.uri.fsPath, root.fsPath, target);
    const rootReal = await realpath(root.fsPath);
    const fileReal = await realpath(resolved.path);
    if (!isWithin(rootReal, fileReal))
      throw new Error("リンク先がワークスペース外を参照しています。");
    if (request.operation === "image-resolve") {
      if (!/\.(?:png|jpe?g|gif|webp|bmp|svg)$/iu.test(fileReal))
        throw new Error("対応する画像ファイルではありません。");
      const info = await stat(fileReal);
      if (!info.isFile() || info.size > 32 * 1024 * 1024)
        throw new Error("画像を読み込めません（上限32 MiB）。");
      const uri = vscode.Uri.file(fileReal);
      const roots = this.webview.options.localResourceRoots ?? [];
      if (!roots.some((candidate) => candidate.toString() === uri.toString()))
        this.webview.options = { ...this.webview.options, localResourceRoots: [...roots, uri] };
      return { url: this.webview.asWebviewUri(uri).toString() };
    }
    if (!/\.(?:md|markdown)$/iu.test(fileReal))
      throw new Error("プレビュー・移動の対象はMarkdown文書です。");
    const info = await stat(fileReal);
    if (!info.isFile() || info.size > 2 * 1024 * 1024)
      throw new Error("リンク先文書が大きすぎます（上限2 MiB）。");
    // Uri uses the logical path so an already-open dirty TextDocument is reused.
    const targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.path));
    const text = targetDocument.getText();
    const offset = headingOffset(text, resolved.fragment);
    if (offset === undefined) throw new Error("指定された見出しが見つかりません。");
    if (request.operation === "link-preview")
      return { title: path.basename(resolved.path), text: text.slice(offset, offset + 12000) };
    this.requireVersion(request);
    if (targetDocument.uri.toString() === this.document.uri.toString())
      return { offset: text.slice(0, offset).replace(/\r\n/gu, "\n").length };
    const position = targetDocument.positionAt(offset);
    await vscode.window.showTextDocument(targetDocument, {
      preview: true,
      selection: new vscode.Range(position, position),
    });
    return {};
  }

  private workspaceRoot(): vscode.Uri {
    const root = vscode.workspace.getWorkspaceFolder(this.document.uri)?.uri;
    if (this.document.isUntitled || this.document.uri.scheme !== "file" || root?.scheme !== "file")
      throw new Error("ワークスペース内に保存済みのMarkdown文書で利用してください。");
    return root;
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
    const root = this.workspaceRoot();
    if (!vscode.workspace.isTrusted)
      throw new Error("画像の取り込みにはワークスペースの信頼が必要です。");
    this.importBusy = true;
    try {
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
      this.requireVersion(request);
      const directory = vscode.workspace
        .getConfiguration("vscodeMarkdownLiveEditor", this.document.uri)
        .get<string>("attachmentFolder", "attachments");
      const relative = await storeAttachment(
        this.document.uri.fsPath,
        root.fsPath,
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
