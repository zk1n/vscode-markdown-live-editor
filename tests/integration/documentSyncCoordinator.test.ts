import { describe, expect, it } from "vitest";

import {
  DocumentSyncCoordinator,
  type DocumentPort,
  type DocumentPortResult,
  type DocumentSnapshot,
  type WebviewEndpoint,
} from "../../src/core/sync/documentSyncCoordinator.js";
import type {
  ClientEditMessage,
  HostToWebviewMessage,
  WireChange,
} from "../../src/protocol/messages.js";
import { PROTOCOL_VERSION } from "../../src/protocol/messages.js";

const DOCUMENT_URI = "file:///workspace/note.md";

class FakeDocumentPort implements DocumentPort {
  private readonly history: string[];
  private historyIndex = 0;
  private version = 1;

  public readonly calls: string[] = [];
  public replacementTextOverride: string | undefined;

  public constructor(initialText: string) {
    this.history = [initialText];
  }

  public readDocument(documentUri: string): Promise<DocumentSnapshot> {
    return Promise.resolve(this.snapshot(documentUri));
  }

  public replaceDocument(
    documentUri: string,
    expectedVersion: number,
    text: string,
  ): Promise<DocumentPortResult> {
    this.calls.push(`replace:${text}`);
    if (expectedVersion !== this.version) {
      return Promise.resolve({
        kind: "rejected",
        snapshot: this.snapshot(documentUri),
        note: "Version changed.",
      });
    }

    const appliedText = this.replacementTextOverride ?? text;
    this.history.splice(this.historyIndex + 1);
    this.history.push(appliedText);
    this.historyIndex += 1;
    this.version += 1;
    return Promise.resolve({ kind: "applied", snapshot: this.snapshot(documentUri) });
  }

  public saveDocument(documentUri: string): Promise<DocumentPortResult> {
    this.calls.push("save");
    return Promise.resolve({ kind: "applied", snapshot: this.snapshot(documentUri) });
  }

  public undoDocument(documentUri: string): Promise<DocumentPortResult> {
    this.calls.push("undo");
    if (this.historyIndex === 0) {
      return Promise.resolve({
        kind: "rejected",
        snapshot: this.snapshot(documentUri),
        note: "No undo entry.",
      });
    }
    this.historyIndex -= 1;
    this.version += 1;
    return Promise.resolve({ kind: "applied", snapshot: this.snapshot(documentUri) });
  }

  public redoDocument(documentUri: string): Promise<DocumentPortResult> {
    this.calls.push("redo");
    if (this.historyIndex === this.history.length - 1) {
      return Promise.resolve({
        kind: "rejected",
        snapshot: this.snapshot(documentUri),
        note: "No redo entry.",
      });
    }
    this.historyIndex += 1;
    this.version += 1;
    return Promise.resolve({ kind: "applied", snapshot: this.snapshot(documentUri) });
  }

  public applyExternalChange(text: string): void {
    this.history.splice(this.historyIndex + 1);
    this.history.push(text);
    this.historyIndex += 1;
    this.version += 1;
  }

  private snapshot(documentUri: string): DocumentSnapshot {
    const text = this.history[this.historyIndex];
    if (text === undefined) {
      throw new Error("Fake document history has no current entry.");
    }
    return { documentUri, documentVersion: this.version, text };
  }
}

class RecordingEndpoint implements WebviewEndpoint {
  public readonly messages: HostToWebviewMessage[] = [];

  public postMessage(message: HostToWebviewMessage): void {
    this.messages.push(message);
  }
}

function insertionChange(expectedText: string, text: string): WireChange {
  return {
    range: {
      start: { line: 0, character: expectedText.length },
      end: { line: 0, character: expectedText.length },
    },
    expectedText: "",
    text,
  };
}

function edit(
  sequence: number,
  documentVersion: number,
  sourceText: string,
  text: string,
): ClientEditMessage {
  return {
    kind: "edit",
    protocolVersion: PROTOCOL_VERSION,
    documentUri: DOCUMENT_URI,
    sessionId: "session-a",
    sequence,
    documentVersion,
    changes: [insertionChange(sourceText, text)],
  };
}

function fullReplacementEdit(
  sequence: number,
  documentVersion: number,
  expectedText: string,
  text: string,
): ClientEditMessage {
  return {
    kind: "edit",
    protocolVersion: PROTOCOL_VERSION,
    documentUri: DOCUMENT_URI,
    sessionId: "session-a",
    sequence,
    documentVersion,
    changes: [
      {
        range: {
          start: { line: 0, character: 0 },
          end: positionAt(expectedText, expectedText.length),
        },
        expectedText,
        text,
      },
    ],
  };
}

function positionAt(
  text: string,
  offset: number,
): { readonly line: number; readonly character: number } {
  const prefix = text.slice(0, offset);
  const lastNewline = prefix.lastIndexOf("\n");
  return {
    line: lastNewline === -1 ? 0 : prefix.split("\n").length - 1,
    character: offset - lastNewline - 1,
  };
}

function barrier(
  kind: "save" | "undo" | "redo",
  sequence: number,
): {
  readonly kind: "save" | "undo" | "redo";
  readonly protocolVersion: 1;
  readonly documentUri: string;
  readonly sessionId: string;
  readonly sequence: number;
} {
  return {
    kind,
    protocolVersion: PROTOCOL_VERSION,
    documentUri: DOCUMENT_URI,
    sessionId: "session-a",
    sequence,
  };
}

describe("DocumentSyncCoordinator", () => {
  it("acknowledges valid first insertions at middle, beginning, EOF, and an empty document", async () => {
    const cases = [
      { initial: "abc", expected: "aXbc" },
      { initial: "abc", expected: "Xabc" },
      { initial: "abc", expected: "abcX" },
      { initial: "", expected: "X" },
      { initial: "日本😀", expected: "日本X😀" },
    ] as const;

    for (const testCase of cases) {
      const port = new FakeDocumentPort(testCase.initial);
      const coordinator = new DocumentSyncCoordinator(port);
      const endpoint = new RecordingEndpoint();
      await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

      await coordinator.receive(
        fullReplacementEdit(1, 1, testCase.initial, testCase.expected),
        endpoint,
      );

      expect(endpoint.messages.some((message) => message.kind === "resync")).toBe(false);
      expect(endpoint.messages).toContainEqual(
        expect.objectContaining({
          kind: "operation-ack",
          operation: "edit",
          sequence: 1,
          text: testCase.expected,
        }),
      );
    }
  });

  it("keeps sequential full-document edits FIFO and authoritative", async () => {
    const port = new FakeDocumentPort("");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

    await coordinator.receive(fullReplacementEdit(1, 1, "", "A"), endpoint);
    await coordinator.receive(fullReplacementEdit(2, 2, "A", "A日"), endpoint);
    await coordinator.receive(fullReplacementEdit(3, 3, "A日", "A日😀"), endpoint);

    expect(port.calls).toEqual(["replace:A", "replace:A日", "replace:A日😀"]);
    expect(endpoint.messages.filter((message) => message.kind === "operation-ack")).toHaveLength(3);
    expect(endpoint.messages.some((message) => message.kind === "resync")).toBe(false);
  });

  it("serializes queued edits, acknowledges each one, and broadcasts authority", async () => {
    const port = new FakeDocumentPort("");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpointA = new RecordingEndpoint();
    const endpointB = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpointA);
    await coordinator.openSession(DOCUMENT_URI, "session-b", endpointB);

    await Promise.all([
      coordinator.receive(edit(1, 1, "", "A"), endpointA),
      coordinator.receive(edit(2, 2, "A", "B"), endpointA),
    ]);

    expect(port.calls).toEqual(["replace:A", "replace:AB"]);
    expect(endpointA.messages.filter((message) => message.kind === "operation-ack")).toHaveLength(
      2,
    );
    expect(endpointB.messages).toContainEqual({
      kind: "document-update",
      reason: "edit",
      documentUri: DOCUMENT_URI,
      documentVersion: 3,
      text: "AB",
    });
  });

  it("rejects a sequence gap without applying it, then accepts the expected sequence", async () => {
    const port = new FakeDocumentPort("");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

    await coordinator.receive(edit(2, 1, "", "B"), endpoint);
    expect(port.calls).toEqual([]);
    expect(endpoint.messages.at(-1)).toMatchObject({
      kind: "resync",
      reason: "sequence-gap",
      nextSequence: 1,
    });

    await coordinator.receive(edit(1, 1, "", "A"), endpoint);
    expect(port.calls).toEqual(["replace:A"]);
  });

  it("rejects a duplicate acknowledged sequence without replaying its edit", async () => {
    const port = new FakeDocumentPort("");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

    await coordinator.receive(edit(1, 1, "", "A"), endpoint);
    await coordinator.receive(edit(1, 2, "A", "B"), endpoint);

    expect(port.calls).toEqual(["replace:A"]);
    expect(endpoint.messages.at(-1)).toMatchObject({
      kind: "resync",
      reason: "sequence-gap",
      nextSequence: 2,
      text: "A",
    });
  });

  it("rejects stale versions without applying positional edits", async () => {
    const port = new FakeDocumentPort("old");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);
    port.applyExternalChange("external");

    await coordinator.receive(edit(1, 1, "old", "!"), endpoint);

    expect(port.calls).toEqual([]);
    expect(endpoint.messages.at(-1)).toMatchObject({
      kind: "resync",
      reason: "stale-version",
      nextSequence: 2,
      documentVersion: 2,
      text: "external",
    });
  });

  it("uses Save and Undo as FIFO barriers after visible edits", async () => {
    const port = new FakeDocumentPort("");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

    await Promise.all([
      coordinator.receive(edit(1, 1, "", "日本語"), endpoint),
      coordinator.receive(barrier("save", 2), endpoint),
      coordinator.receive(barrier("undo", 3), endpoint),
    ]);

    expect(port.calls).toEqual(["replace:日本語", "save", "undo"]);
    expect(endpoint.messages.at(-1)).toMatchObject({
      kind: "document-update",
      reason: "undo",
      text: "",
    });
  });

  it("resyncs when a port claims success with different text", async () => {
    const port = new FakeDocumentPort("");
    port.replacementTextOverride = "unexpected";
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

    await coordinator.receive(edit(1, 1, "", "expected"), endpoint);

    expect(endpoint.messages.at(-1)).toMatchObject({
      kind: "resync",
      reason: "port-inconsistent",
      text: "unexpected",
      nextSequence: 2,
    });
  });

  it("broadcasts an external authoritative change without applying a client edit", async () => {
    const port = new FakeDocumentPort("before");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);
    port.applyExternalChange("after");

    await coordinator.publishExternalChange(DOCUMENT_URI);

    expect(port.calls).toEqual([]);
    expect(endpoint.messages.at(-1)).toEqual({
      kind: "document-update",
      reason: "external",
      documentUri: DOCUMENT_URI,
      documentVersion: 2,
      text: "after",
    });
  });

  it("rejects a disposed session and safely starts a reopened session", async () => {
    const port = new FakeDocumentPort("");
    const coordinator = new DocumentSyncCoordinator(port);
    const closedEndpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", closedEndpoint);
    await coordinator.receive(edit(1, 1, "", "saved"), closedEndpoint);
    coordinator.closeSession(DOCUMENT_URI, "session-a");

    await coordinator.receive(edit(2, 2, "saved", "!"), closedEndpoint);
    expect(port.calls).toEqual(["replace:saved"]);
    expect(closedEndpoint.messages.at(-1)).toMatchObject({
      kind: "protocol-error",
    });

    const reopenedEndpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-b", reopenedEndpoint);
    expect(reopenedEndpoint.messages.at(-1)).toMatchObject({
      kind: "document-update",
      reason: "opened",
      text: "saved",
      documentVersion: 2,
    });

    await coordinator.receive(
      { ...edit(1, 2, "saved", "!"), sessionId: "session-b" },
      reopenedEndpoint,
    );
    expect(reopenedEndpoint.messages).toContainEqual(
      expect.objectContaining({ kind: "operation-ack", sequence: 1 }),
    );
    expect(port.calls).toEqual(["replace:saved", "replace:saved!"]);
  });
});
