import { describe, expect, it } from "vitest";

import {
  DocumentSyncCoordinator,
  type DocumentPort,
  type DocumentPortResult,
  type DocumentSnapshot,
  type WebviewEndpoint,
} from "../../src/core/sync/documentSyncCoordinator.js";
import { BoundedDiagnosticLog } from "../../src/core/diagnostics/diagnosticLog.js";
import { textFingerprint } from "../../src/core/diagnostics/textFingerprint.js";
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
  public rejectSave = false;

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
    if (this.rejectSave) {
      return Promise.resolve({
        kind: "rejected",
        snapshot: this.snapshot(documentUri),
        note: "The dirty document was not saved.",
      });
    }
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
    controllerId: "controller-a",
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
    controllerId: "controller-a",
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
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly documentUri: string;
  readonly sessionId: string;
  readonly controllerId: string;
  readonly sequence: number;
} {
  return {
    kind,
    protocolVersion: PROTOCOL_VERSION,
    documentUri: DOCUMENT_URI,
    sessionId: "session-a",
    controllerId: "controller-a",
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

  it("acknowledges the origin and sends each edit snapshot only to peer sessions", async () => {
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
    expect(
      endpointA.messages.filter(
        (message) => message.kind === "document-update" && message.reason === "edit",
      ),
    ).toHaveLength(0);
    const peerUpdate = endpointB.messages.find(
      (message): message is Extract<HostToWebviewMessage, { readonly kind: "document-update" }> =>
        message.kind === "document-update" && message.documentVersion === 3,
    );
    expect(peerUpdate).toMatchObject({
      kind: "document-update",
      reason: "edit",
      documentUri: DOCUMENT_URI,
      documentVersion: 3,
      text: "AB",
    });
    expect(peerUpdate?.correlation?.causalId).toBe("operation:session-a:2");
    expect(peerUpdate?.correlation?.source).toBe("operation-peer");
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

  it("records fingerprint-only evidence when a claimed replacement misses authority", async () => {
    const port = new FakeDocumentPort("- ");
    const diagnostics = new BoundedDiagnosticLog();
    const coordinator = new DocumentSyncCoordinator(port, diagnostics);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

    await coordinator.receive(fullReplacementEdit(1, 1, "-x", "- 日本"), endpoint);

    const trace = diagnostics.copyText();
    expect(trace).toContain("coordinator.edit.change-mismatch");
    expect(trace).toContain(`authorityTextFingerprint=${JSON.stringify(textFingerprint("- "))}`);
    expect(trace).toContain(`expectedTextFingerprint=${JSON.stringify(textFingerprint("-x"))}`);
    expect(trace).toContain(`actualTextFingerprint=${JSON.stringify(textFingerprint("- "))}`);
    expect(endpoint.messages.at(-1)).toMatchObject({ kind: "resync", reason: "change-mismatch" });
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
      kind: "operation-ack",
      operation: "undo",
      text: "",
    });
  });

  it("keeps a composition-final edit and repeated Save barriers FIFO", async () => {
    const port = new FakeDocumentPort("ABCD");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

    await Promise.all([
      coordinator.receive(fullReplacementEdit(1, 1, "ABCD", "ABCDあいう"), endpoint),
      coordinator.receive(barrier("save", 2), endpoint),
      coordinator.receive(barrier("save", 3), endpoint),
    ]);

    expect(port.calls).toEqual(["replace:ABCDあいう", "save", "save"]);
    expect(
      endpoint.messages.filter(
        (message) => message.kind === "operation-ack" && message.operation === "save",
      ),
    ).toHaveLength(2);
    expect(endpoint.messages.some((message) => message.kind === "resync")).toBe(false);
  });

  it("uses host authority only for two final compositions, Undo, and Redo", async () => {
    const port = new FakeDocumentPort("ABCDEF");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

    await coordinator.receive(fullReplacementEdit(1, 1, "ABCDEF", "ABCD"), endpoint);
    await coordinator.receive(fullReplacementEdit(2, 2, "ABCD", "ABCDあいう"), endpoint);
    await coordinator.receive(
      fullReplacementEdit(3, 3, "ABCDあいう", "ABCDあいうかきく"),
      endpoint,
    );
    await coordinator.receive(barrier("undo", 4), endpoint);
    await coordinator.receive(barrier("redo", 5), endpoint);

    expect(port.calls).toEqual([
      "replace:ABCD",
      "replace:ABCDあいう",
      "replace:ABCDあいうかきく",
      "undo",
      "redo",
    ]);
    expect(endpoint.messages).toContainEqual(
      expect.objectContaining({ kind: "operation-ack", operation: "undo", text: "ABCDあいう" }),
    );
    expect(endpoint.messages).toContainEqual(
      expect.objectContaining({
        kind: "operation-ack",
        operation: "redo",
        text: "ABCDあいうかきく",
      }),
    );
  });

  it("keeps local edit, acknowledgement, and Save identical for plain and supported Markdown syntax", async () => {
    const cases = ["plain text", "# ATX heading", "**strong**", "*emphasis*"] as const;

    for (const text of cases) {
      const port = new FakeDocumentPort("");
      const coordinator = new DocumentSyncCoordinator(port);
      const endpoint = new RecordingEndpoint();
      await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

      await coordinator.receive(fullReplacementEdit(1, 1, "", text), endpoint);
      await coordinator.receive(barrier("save", 2), endpoint);

      expect(port.calls).toEqual([`replace:${text}`, "save"]);
      expect(endpoint.messages).toContainEqual(
        expect.objectContaining({
          kind: "operation-ack",
          operation: "edit",
          sequence: 1,
          text,
        }),
      );
      expect(endpoint.messages).toContainEqual(
        expect.objectContaining({
          kind: "operation-ack",
          operation: "save",
          sequence: 2,
          text,
        }),
      );
      expect(endpoint.messages.some((message) => message.kind === "resync")).toBe(false);
    }
  });

  it("applies only the authoritative Undo result and restores the same text on Redo", async () => {
    const port = new FakeDocumentPort("あいう");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

    await coordinator.receive(fullReplacementEdit(1, 1, "あいう", "あいうかきく"), endpoint);
    await coordinator.receive(barrier("undo", 2), endpoint);
    await coordinator.receive(barrier("redo", 3), endpoint);

    const acknowledgements = endpoint.messages.filter(
      (message): message is Extract<typeof message, { readonly kind: "operation-ack" }> =>
        message.kind === "operation-ack",
    );
    expect(acknowledgements.map(({ operation, text }) => ({ operation, text }))).toEqual([
      { operation: "edit", text: "あいうかきく" },
      { operation: "undo", text: "あいう" },
      { operation: "redo", text: "あいうかきく" },
    ]);
    expect(port.calls).toEqual(["replace:あいうかきく", "undo", "redo"]);
  });

  it("enters recovery when a Save barrier reports an actual rejection", async () => {
    const port = new FakeDocumentPort("unsaved");
    port.rejectSave = true;
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

    await coordinator.receive(barrier("save", 1), endpoint);

    expect(port.calls).toEqual(["save"]);
    expect(endpoint.messages.at(-1)).toMatchObject({
      kind: "resync",
      reason: "port-rejected",
      text: "unsaved",
      nextSequence: 2,
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

  it("broadcasts an external authoritative change to every open session without applying a client edit", async () => {
    const port = new FakeDocumentPort("before");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpointA = new RecordingEndpoint();
    const endpointB = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpointA);
    await coordinator.openSession(DOCUMENT_URI, "session-b", endpointB);
    port.applyExternalChange("after");

    await coordinator.publishExternalChange(DOCUMENT_URI);

    expect(port.calls).toEqual([]);
    const expectedUpdate = {
      kind: "document-update",
      reason: "external",
      documentUri: DOCUMENT_URI,
      documentVersion: 2,
      text: "after",
    };
    expect(endpointA.messages.at(-1)).toMatchObject(expectedUpdate);
    expect(endpointB.messages.at(-1)).toMatchObject(expectedUpdate);
    const externalUpdate = endpointA.messages.at(-1);
    expect(externalUpdate?.kind).toBe("document-update");
    if (externalUpdate?.kind === "document-update") {
      expect(externalUpdate.correlation?.source).toBe("external-event");
    }
  });

  it("records event-time to queue-time drift without broadcasting the event text as metadata", async () => {
    const port = new FakeDocumentPort("before");
    const diagnostics = new BoundedDiagnosticLog();
    const coordinator = new DocumentSyncCoordinator(port, diagnostics);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);
    const eventVersion = 1;
    const eventFingerprint = textFingerprint("before");
    port.applyExternalChange("after");

    await coordinator.publishExternalChange(DOCUMENT_URI, {
      eventId: "document-change-1",
      eventDocumentVersion: eventVersion,
      eventTextFingerprint: eventFingerprint,
      eventTextLength: "before".length,
      contentChangeCount: 0,
      classification: "external",
    });

    const update = endpoint.messages.at(-1);
    expect(update).toMatchObject({
      kind: "document-update",
      reason: "external",
      text: "after",
    });
    if (update?.kind === "document-update") {
      expect(update.correlation?.causalId).toBe("external:document-change-1");
      expect(update.correlation?.externalEventId).toBe("document-change-1");
      expect(update.correlation?.source).toBe("external-event");
    }
    const trace = diagnostics.copyText();
    expect(trace).toContain("coordinator.external.publish-enqueued");
    expect(trace).toContain('eventId="document-change-1"');
    expect(trace).toContain("coordinator.external.publish-executed");
    expect(trace).toContain("temporalDrift=true");
    expect(trace).toContain(eventFingerprint);
    expect(trace).not.toContain("before");
    expect(trace).not.toContain("after");
  });

  it("sends ACKs to the origin and authoritative snapshots to peers for edit, Save, Undo, and Redo", async () => {
    const port = new FakeDocumentPort("before");
    const diagnostics = new BoundedDiagnosticLog();
    const coordinator = new DocumentSyncCoordinator(port, diagnostics);
    const endpointA = new RecordingEndpoint();
    const endpointB = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpointA);
    await coordinator.openSession(DOCUMENT_URI, "session-b", endpointB);

    await coordinator.receive(fullReplacementEdit(1, 1, "before", "after"), endpointA);
    await coordinator.receive(barrier("save", 2), endpointA);
    await coordinator.receive(barrier("undo", 3), endpointA);
    await coordinator.receive(barrier("redo", 4), endpointA);

    const originOperations = endpointA.messages.filter(
      (message): message is Extract<HostToWebviewMessage, { readonly kind: "operation-ack" }> =>
        message.kind === "operation-ack",
    );
    expect(
      originOperations.map(({ operation, sequence, text }) => ({ operation, sequence, text })),
    ).toEqual([
      { operation: "edit", sequence: 1, text: "after" },
      { operation: "save", sequence: 2, text: "after" },
      { operation: "undo", sequence: 3, text: "before" },
      { operation: "redo", sequence: 4, text: "after" },
    ]);
    expect(endpointA.messages.filter((message) => message.kind === "document-update")).toHaveLength(
      1,
    );
    expect(
      endpointB.messages
        .filter(
          (
            message,
          ): message is Extract<HostToWebviewMessage, { readonly kind: "document-update" }> =>
            message.kind === "document-update" && message.reason !== "opened",
        )
        .map(({ reason, text }) => ({ reason, text })),
    ).toEqual([
      { reason: "edit", text: "after" },
      { reason: "save", text: "after" },
      { reason: "undo", text: "before" },
      { reason: "redo", text: "after" },
    ]);

    const trace = diagnostics.copyText();
    expect(trace).toContain("coordinator.ack");
    expect(trace).toContain('originSessionId="session-a"');
    expect(trace).toContain("coordinator.broadcast");
    expect(trace).toContain('excludedSessionId="session-a"');
    expect(trace).toContain("peerCount=1");
    expect(trace).toContain('logicalOrder="after-ack"');
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

  it("continues the session sequence across controller recreation and rejects the stale controller", async () => {
    const port = new FakeDocumentPort("");
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    await coordinator.openSession(DOCUMENT_URI, "session-a", endpoint);

    const first = await coordinator.activateController(
      DOCUMENT_URI,
      "session-a",
      endpoint,
      "controller-a",
    );
    expect(first).toMatchObject({ ok: true, nextSequence: 1 });
    for (let sequence = 1; sequence <= 132; sequence += 1) {
      await coordinator.receive(
        { ...barrier("save", sequence), controllerId: "controller-a" },
        endpoint,
      );
    }

    const recreated = await coordinator.activateController(
      DOCUMENT_URI,
      "session-a",
      endpoint,
      "controller-b",
    );
    expect(recreated).toMatchObject({ ok: true, nextSequence: 133 });

    await coordinator.receive(
      {
        ...fullReplacementEdit(133, 1, "", "stale"),
        controllerId: "controller-a",
      },
      endpoint,
    );
    expect(port.calls.some((call) => call === "replace:stale")).toBe(false);

    await coordinator.receive(
      {
        ...fullReplacementEdit(133, 1, "", "current"),
        controllerId: "controller-b",
      },
      endpoint,
    );
    expect(endpoint.messages).toContainEqual(
      expect.objectContaining({ kind: "operation-ack", sequence: 133, text: "current" }),
    );
    expect(port.calls.filter((call) => call.startsWith("replace:"))).toEqual(["replace:current"]);
  });
});
