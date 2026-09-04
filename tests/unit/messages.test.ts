import { describe, expect, it } from "vitest";

import {
  decodeEditorReadyMessage,
  decodeHostToWebviewMessage,
  decodeWebviewToHostMessage,
  PROTOCOL_VERSION,
} from "../../src/protocol/messages.js";

describe("protocol decoding", () => {
  it("decodes the provider-only editor-ready lifecycle message", () => {
    expect(
      decodeEditorReadyMessage({
        kind: "editor-ready",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///note.md",
        sessionId: "session-1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      decodeEditorReadyMessage({
        kind: "editor-ready",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///note.md",
        sessionId: "",
      }).ok,
    ).toBe(false);
  });

  it("accepts metadata-only diagnostic messages without a client sequence", () => {
    const decoded = decodeWebviewToHostMessage({
      kind: "diagnostic",
      documentUri: "file:///workspace/note.md",
      sessionId: "session-a",
      event: "shortcut.keymap.handled",
      details: { action: "save", repeat: false },
    });

    expect(decoded).toEqual({
      ok: true,
      value: {
        kind: "diagnostic",
        documentUri: "file:///workspace/note.md",
        sessionId: "session-a",
        event: "shortcut.keymap.handled",
        details: { action: "save", repeat: false },
      },
    });
  });

  it("rejects diagnostic values that exceed bounded transport limits", () => {
    const decoded = decodeWebviewToHostMessage({
      kind: "diagnostic",
      documentUri: "file:///workspace/note.md",
      sessionId: "session-a",
      event: "shortcut.keymap.handled",
      details: { note: "x".repeat(161) },
    });

    expect(decoded).toEqual({ ok: false, error: "Diagnostic detail is invalid." });
  });

  it("decodes a complete edit operation from unknown data", () => {
    const decoded = decodeWebviewToHostMessage({
      kind: "edit",
      protocolVersion: PROTOCOL_VERSION,
      documentUri: "file:///note.md",
      sessionId: "session-1",
      sequence: 1,
      documentVersion: 3,
      changes: [
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 2 },
          },
          expectedText: "b",
          text: "B",
        },
      ],
    });

    expect(decoded).toEqual({
      ok: true,
      value: {
        kind: "edit",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///note.md",
        sessionId: "session-1",
        sequence: 1,
        documentVersion: 3,
        changes: [
          {
            range: {
              start: { line: 0, character: 1 },
              end: { line: 0, character: 2 },
            },
            expectedText: "b",
            text: "B",
          },
        ],
      },
    });
  });

  it("rejects malformed or unsafe edit data without throwing", () => {
    const malformedMessages: readonly unknown[] = [
      null,
      { kind: "edit" },
      {
        kind: "edit",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///note.md",
        sessionId: "session-1",
        sequence: 1,
        documentVersion: 0,
        changes: [],
      },
      {
        kind: "edit",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///note.md",
        sessionId: "session-1",
        sequence: 1.5,
        documentVersion: 0,
        changes: [],
      },
      {
        kind: "edit",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///note.md",
        sessionId: "session-1",
        sequence: 1,
        documentVersion: 0,
        changes: [
          {
            range: {
              start: { line: 1, character: 0 },
              end: { line: 0, character: 0 },
            },
            expectedText: "",
            text: "x",
          },
        ],
      },
    ];

    for (const malformedMessage of malformedMessages) {
      expect(decodeWebviewToHostMessage(malformedMessage).ok).toBe(false);
    }
  });

  it("decodes host resync messages and rejects incomplete snapshots", () => {
    expect(
      decodeHostToWebviewMessage({
        kind: "resync",
        documentUri: "file:///note.md",
        documentVersion: 4,
        text: "authoritative",
        reason: "stale-version",
        nextSequence: 7,
        note: "The base version changed.",
      }),
    ).toMatchObject({ ok: true });

    expect(
      decodeHostToWebviewMessage({
        kind: "operation-ack",
        documentUri: "file:///note.md",
        documentVersion: 4,
        operation: "edit",
        sequence: 1,
      }),
    ).toMatchObject({ ok: false });
  });

  it("decodes bounded metadata-only host correlation without making it authority", () => {
    const decoded = decodeHostToWebviewMessage({
      kind: "document-update",
      reason: "external",
      documentUri: "file:///note.md",
      documentVersion: 4,
      text: "authoritative",
      correlation: {
        causalId: "external:document-change-7",
        publicationId: "publication-9",
        source: "external-event",
        queueEnqueueOrdinal: 11,
        queueStartOrdinal: 12,
        externalEventId: "document-change-7",
      },
    });

    expect(decoded).toMatchObject({
      ok: true,
      value: {
        kind: "document-update",
        correlation: {
          causalId: "external:document-change-7",
          publicationId: "publication-9",
          source: "external-event",
        },
      },
    });
    expect(
      decodeHostToWebviewMessage({
        kind: "document-update",
        reason: "external",
        documentUri: "file:///note.md",
        documentVersion: 4,
        text: "authoritative",
        correlation: { causalId: "missing-required-fields" },
      }).ok,
    ).toBe(false);
  });

  it("decodes valid navigate-to-heading messages and enforces strict range bounds", () => {
    expect(
      decodeHostToWebviewMessage({
        kind: "navigate-to-heading",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///note.md",
        documentVersion: 7,
        sessionId: "session-1",
        targetOffset: 14,
        highlightFrom: 10,
        highlightTo: 20,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects malformed protocol versions and session identifiers", () => {
    expect(
      decodeHostToWebviewMessage({
        kind: "navigate-to-heading",
        protocolVersion: 0,
        documentUri: "file:///note.md",
        documentVersion: 7,
        sessionId: "session-1",
        targetOffset: 14,
        highlightFrom: 10,
        highlightTo: 20,
      }).ok,
    ).toBe(false);

    expect(
      decodeHostToWebviewMessage({
        kind: "navigate-to-heading",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "",
        documentVersion: 7,
        sessionId: "session-1",
        targetOffset: 14,
        highlightFrom: 10,
        highlightTo: 20,
      }).ok,
    ).toBe(false);
  });

  it("rejects malformed navigation ranges and malformed edit ranges from webview messages", () => {
    expect(
      decodeHostToWebviewMessage({
        kind: "navigate-to-heading",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///note.md",
        documentVersion: 7,
        sessionId: "session-1",
        targetOffset: 10,
        highlightFrom: 12,
        highlightTo: 11,
      }).ok,
    ).toBe(false);

    expect(
      decodeWebviewToHostMessage({
        kind: "edit",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///note.md",
        sessionId: "session-1",
        sequence: 9,
        documentVersion: 1,
        changes: [
          {
            range: {
              start: { line: 3, character: 0 },
              end: { line: 2, character: 0 },
            },
            expectedText: "",
            text: "",
          },
        ],
      }).ok,
    ).toBe(false);
  });
});
