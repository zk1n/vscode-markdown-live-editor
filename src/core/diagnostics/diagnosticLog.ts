export type DiagnosticLogValue = boolean | number | string | undefined;

/**
 * Development-only local logging boundary. Implementations must never transmit
 * data or retain it beyond the current VS Code process/session.
 */
export interface DiagnosticLog {
  record(kind: string, details: Readonly<Record<string, DiagnosticLogValue>>): void;
}

/** Local-only, bounded operation metadata retained for explicit user copy. */
export class BoundedDiagnosticLog implements DiagnosticLog {
  private readonly lines: { readonly line: string; readonly size: number }[] = [];
  private totalSize = 0;

  public constructor(
    private readonly capacity = 250,
    private readonly onRecord?: (line: string) => void,
    private readonly maximumSize = 32_768,
  ) {}

  public record(kind: string, details: Readonly<Record<string, DiagnosticLogValue>>): void {
    const serialized = Object.entries(details)
      .map(([key, value]): string => `${key}=${JSON.stringify(limitValue(value))}`)
      .join(" ");
    const line = limitLine(
      `${String(Date.now())} ${limitString(kind, 96)}${serialized === "" ? "" : ` ${serialized}`}`,
    );
    const size = utf8Size(`${line}\n`);
    this.lines.push({ line, size });
    this.totalSize += size;
    while (this.lines.length > this.capacity || this.totalSize > this.maximumSize) {
      const removed = this.lines.shift();
      if (removed !== undefined) {
        this.totalSize -= removed.size;
      }
    }
    this.onRecord?.(line);
  }

  public copyText(): string {
    return this.lines.map(({ line }): string => line).join("\n");
  }
}

function limitValue(value: DiagnosticLogValue): DiagnosticLogValue {
  return typeof value === "string" ? limitString(value, 160) : value;
}

function limitLine(value: string): string {
  return limitByUtf8Bytes(value, 512);
}

function limitString(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength)}…`;
}

function limitByUtf8Bytes(value: string, maximumSize: number): string {
  if (utf8Size(value) <= maximumSize) {
    return value;
  }
  let end = value.length;
  while (end > 0 && utf8Size(`${value.slice(0, end)}…`) > maximumSize) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export const disabledDiagnosticLog: DiagnosticLog = {
  record: (): void => undefined,
};
