export type DiagnosticLogValue = boolean | number | string | undefined;

/**
 * Development-only local logging boundary. Implementations must never transmit
 * data or retain it beyond the current VS Code process/session.
 */
export interface DiagnosticLog {
  record(kind: string, details: Readonly<Record<string, DiagnosticLogValue>>): void;
}

export const disabledDiagnosticLog: DiagnosticLog = {
  record: (): void => undefined,
};
