import { describe, expect, it } from "vitest";

import {
  decodeHostToWebviewMessage,
  decodeWebviewToHostMessage,
  PROTOCOL_VERSION,
} from "../../src/protocol/messages.js";

describe("protocol decoding", () => {
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
});
