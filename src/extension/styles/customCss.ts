/** Maximum UTF-8 byte length accepted from one custom CSS source. */
export const MAX_CUSTOM_CSS_SOURCE_BYTES = 64 * 1024;

/** Maximum UTF-8 byte length accepted after the two sources are composed. */
export const MAX_CUSTOM_CSS_COMBINED_BYTES = 2 * MAX_CUSTOM_CSS_SOURCE_BYTES;

export type CustomCssSourceName = "workspace" | "user";

export type CustomCssSourceStatus = "accepted" | "disabled" | "missing" | "read-error" | "invalid";

export interface CustomCssSourceResult {
  readonly css: string | undefined;
  readonly reason: string | undefined;
  readonly status: CustomCssSourceStatus;
}

export interface CustomCssSnapshot {
  /** Monotonically increasing only for snapshots published by a session. */
  readonly revision: number;
  /** Workspace rules have lower precedence than the user literal. */
  readonly workspaceCss: string | undefined;
  readonly userCss: string | undefined;
  /** Ready for an atomic dedicated-style replacement in the webview. */
  readonly css: string;
  readonly workspace: CustomCssSourceResult;
  readonly user: CustomCssSourceResult;
}

export interface CustomCssUri {
  readonly scheme: string;
  toString(): string;
}

export interface CustomCssWorkspaceFolder {
  readonly uri: CustomCssUri;
}

export interface CustomCssDisposable {
  dispose(): void;
}

export interface CustomCssWatcher {
  readonly onDidChange: (listener: () => void) => CustomCssDisposable;
  readonly onDidCreate: (listener: () => void) => CustomCssDisposable;
  readonly onDidDelete: (listener: () => void) => CustomCssDisposable;
  dispose(): void;
}

/** Minimal host boundary; the VS Code adapter deliberately belongs at integration time. */
export interface CustomCssHost {
  readonly isWorkspaceTrusted: () => boolean;
  readonly getWorkspaceFolder: (documentUri: CustomCssUri) => CustomCssWorkspaceFolder | undefined;
  readonly joinPath: (base: CustomCssUri, ...pathSegments: readonly string[]) => CustomCssUri;
  readonly readFile: (uri: CustomCssUri) => Promise<Uint8Array>;
  readonly createWatcher: (uri: CustomCssUri) => CustomCssWatcher;
  readonly isFileNotFound: (error: unknown) => boolean;
}

export interface CustomCssSessionOptions {
  readonly documentUri: CustomCssUri;
  /** Return undefined to disable the user-level literal for this resolution. */
  readonly getUserCss: () => unknown;
  readonly onDidUpdate: (snapshot: CustomCssSnapshot) => void;
}

const utf8Encoder = new TextEncoder();

export function validateCustomCss(css: string): CustomCssSourceResult {
  const byteLength = utf8Encoder.encode(css).byteLength;
  if (byteLength > MAX_CUSTOM_CSS_SOURCE_BYTES) {
    return invalid(`CSS exceeds the ${String(MAX_CUSTOM_CSS_SOURCE_BYTES)} byte source limit.`);
  }
  if (css.includes("\0")) {
    return invalid("CSS contains a NUL character.");
  }
  // CSS escapes can obfuscate resource-loading tokens (for example `u\\72l`).
  // The v0.1 surface intentionally rejects escapes instead of implementing a
  // second, security-sensitive CSS tokenizer.
  if (css.includes("\\")) {
    return invalid("CSS escape sequences are not allowed.");
  }
  if (/(?:https?|file|data|vscode-resource|vscode-webview-resource):/iu.test(css)) {
    return invalid("CSS external resource schemes are not allowed.");
  }

  const syntaxError = findForbiddenOrUnbalancedCss(css);
  return syntaxError === undefined
    ? { css, reason: undefined, status: "accepted" }
    : invalid(syntaxError);
}

/**
 * Resolves only the user literal and the fixed CSS file in the owning trusted
 * workspace. Failures are represented in the snapshot and never throw into an
 * editor lifecycle.
 */
export async function loadCustomCss(
  host: CustomCssHost,
  documentUri: CustomCssUri,
  userCssValue: unknown,
): Promise<Omit<CustomCssSnapshot, "revision">> {
  const user = loadUserCss(userCssValue);
  if (!host.isWorkspaceTrusted()) {
    return composeWithUnavailableWorkspace(user, "Workspace is not trusted.");
  }

  const folder = host.getWorkspaceFolder(documentUri);
  if (folder === undefined) {
    return composeWithUnavailableWorkspace(user, "Document does not belong to a workspace folder.");
  }

  const workspaceUri = host.joinPath(folder.uri, ".vscode", "markdown-live-editor.css");
  const workspace = await loadWorkspaceCss(host, workspaceUri);
  const composed = composeCss(workspace, user);

  return {
    css: composed.css,
    user: composed.user,
    userCss: composed.user.css,
    workspace: composed.workspace,
    workspaceCss: composed.workspace.css,
  };
}

/**
 * Owns exactly one document's style watcher. Each request gets an epoch before
 * reading, so a slower stale read cannot publish over a later create/change/delete.
 */
export class CustomCssSession implements CustomCssDisposable {
  private readonly watcher: CustomCssWatcher | undefined;
  private readonly watcherDisposables: readonly CustomCssDisposable[];
  private disposed = false;
  private nextRevision = 1;
  private readEpoch = 0;

  public constructor(
    private readonly host: CustomCssHost,
    private readonly options: CustomCssSessionOptions,
  ) {
    const folder = host.isWorkspaceTrusted()
      ? host.getWorkspaceFolder(options.documentUri)
      : undefined;
    if (folder === undefined) {
      this.watcher = undefined;
      this.watcherDisposables = [];
      return;
    }

    const workspaceUri = host.joinPath(folder.uri, ".vscode", "markdown-live-editor.css");
    const watcher = host.createWatcher(workspaceUri);
    const reload = (): void => {
      void this.reload();
    };
    this.watcher = watcher;
    this.watcherDisposables = [
      watcher.onDidChange(reload),
      watcher.onDidCreate(reload),
      watcher.onDidDelete(reload),
    ];
  }

  public async start(): Promise<void> {
    await this.reload();
  }

  public async reload(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const epoch = this.readEpoch + 1;
    this.readEpoch = epoch;
    const snapshot = await loadCustomCss(
      this.host,
      this.options.documentUri,
      this.options.getUserCss(),
    );
    if (epoch !== this.readEpoch) {
      return;
    }
    this.options.onDidUpdate({ ...snapshot, revision: this.nextRevision });
    this.nextRevision += 1;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.readEpoch += 1;
    for (const disposable of this.watcherDisposables) {
      disposable.dispose();
    }
    this.watcher?.dispose();
  }
}

async function loadWorkspaceCss(
  host: CustomCssHost,
  uri: CustomCssUri,
): Promise<CustomCssSourceResult> {
  try {
    const bytes = await host.readFile(uri);
    if (bytes.byteLength > MAX_CUSTOM_CSS_SOURCE_BYTES) {
      return invalid(`CSS exceeds the ${String(MAX_CUSTOM_CSS_SOURCE_BYTES)} byte source limit.`);
    }
    let css: string;
    try {
      css = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return invalid("CSS is not valid UTF-8.");
    }
    return validateCustomCss(css);
  } catch (error: unknown) {
    return host.isFileNotFound(error)
      ? { css: undefined, reason: "CSS file does not exist.", status: "missing" }
      : { css: undefined, reason: "CSS file could not be read.", status: "read-error" };
  }
}

function loadUserCss(value: unknown): CustomCssSourceResult {
  if (value === undefined) {
    return { css: undefined, reason: undefined, status: "disabled" };
  }
  return typeof value === "string"
    ? validateCustomCss(value)
    : invalid("CSS setting must be a string.");
}

function composeCss(
  workspace: CustomCssSourceResult,
  user: CustomCssSourceResult,
): {
  readonly css: string;
  readonly workspace: CustomCssSourceResult;
  readonly user: CustomCssSourceResult;
} {
  if (workspace.css === undefined || user.css === undefined) {
    const css = workspace.css ?? user.css ?? "";
    return { css, user, workspace };
  }
  const css = `${workspace.css}\n${user.css}`;
  if (utf8Encoder.encode(css).byteLength <= MAX_CUSTOM_CSS_COMBINED_BYTES) {
    return { css, user, workspace };
  }
  return {
    css: workspace.css,
    user: invalid(`CSS exceeds the ${String(MAX_CUSTOM_CSS_COMBINED_BYTES)} byte combined limit.`),
    workspace,
  };
}

function composeWithUnavailableWorkspace(
  user: CustomCssSourceResult,
  reason: string,
): Omit<CustomCssSnapshot, "revision"> {
  const workspace: CustomCssSourceResult = {
    css: undefined,
    reason,
    status: "disabled",
  };
  return {
    css: user.css ?? "",
    user,
    userCss: user.css,
    workspace,
    workspaceCss: undefined,
  };
}

function invalid(reason: string): CustomCssSourceResult {
  return { css: undefined, reason, status: "invalid" };
}

function findForbiddenOrUnbalancedCss(css: string): string | undefined {
  const stack: string[] = [];
  let inComment = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    const next = css[index + 1];
    if (character === undefined) {
      return "CSS could not be parsed.";
    }
    if (inComment) {
      if (character === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "@" && css.slice(index + 1, index + 7).toLowerCase() === "import") {
      const boundary = css[index + 7];
      if (boundary === undefined || !isCssIdentifierCharacter(boundary)) {
        return "CSS @import is not allowed.";
      }
    }
    if (isCssIdentifierStart(character)) {
      const identifierEnd = readIdentifierEnd(css, index);
      if (css.slice(index, identifierEnd).toLowerCase() === "url") {
        let cursor = identifierEnd;
        while (isCssWhitespace(css[cursor])) {
          cursor += 1;
        }
        if (css[cursor] === "(") {
          return "CSS url() is not allowed.";
        }
      }
      index = identifierEnd - 1;
      continue;
    }
    const expected = openingDelimiter(character);
    if (expected !== undefined) {
      stack.push(expected);
    } else if (character === ")" || character === "]" || character === "}") {
      if (stack.pop() !== character) {
        return "CSS has unbalanced delimiters.";
      }
    }
  }
  return inComment || quote !== undefined || stack.length > 0
    ? "CSS has unbalanced structure."
    : undefined;
}

function isCssIdentifierStart(character: string): boolean {
  return /[A-Za-z_-]/u.test(character);
}

function isCssIdentifierCharacter(character: string): boolean {
  return /[A-Za-z0-9_-]/u.test(character);
}

function readIdentifierEnd(css: string, start: number): number {
  let end = start + 1;
  while (isCssIdentifierCharacter(css[end] ?? "")) {
    end += 1;
  }
  return end;
}

function isCssWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

function openingDelimiter(character: string): string | undefined {
  if (character === "(") {
    return ")";
  }
  if (character === "[") {
    return "]";
  }
  return character === "{" ? "}" : undefined;
}
