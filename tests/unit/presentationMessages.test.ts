import { describe, expect, it } from "vitest";

import {
  decodeEditorStateMessage,
  decodeHostPresentationMessage,
} from "../../src/protocol/presentationMessages.js";
import { PROTOCOL_VERSION } from "../../src/protocol/messages.js";

const identity = {
  protocolVersion: PROTOCOL_VERSION,
  documentUri: "file:///note.md",
  sessionId: "session-a",
  controllerId: "controller-a",
} as const;

describe("presentation message decoding", () => {
  it("decodes a bounded controller state report", () => {
    expect(
      decodeEditorStateMessage({
        kind: "editor-state",
        ...identity,
        reportSequence: 2,
        documentVersion: 7,
        selectionAnchor: 1,
        selectionHead: 3,
        line: 2,
        column: 4,
        focused: true,
        composing: false,
        recoveryActive: false,
        barrierActive: false,
        insertSpaces: true,
        tabSize: 4,
      }),
    ).toMatchObject({ ok: true, value: { kind: "editor-state", reportSequence: 2 } });
  });

  it("rejects invalid status dimensions and flags", () => {
    expect(
      decodeEditorStateMessage({
        kind: "editor-state",
        ...identity,
        reportSequence: 1,
        documentVersion: 1,
        selectionAnchor: 0,
        selectionHead: 0,
        line: 0,
        column: 1,
        focused: true,
        composing: false,
        recoveryActive: false,
        barrierActive: false,
        insertSpaces: true,
        tabSize: 4,
      }).ok,
    ).toBe(false);
  });

  it("decodes configuration, style, and history focus controls", () => {
    expect(
      decodeHostPresentationMessage({
        kind: "editor-navigation",
        ...identity,
        documentVersion: 7,
        line: 3,
        column: 5,
      }),
    ).toMatchObject({ ok: true, value: { kind: "editor-navigation", line: 3, column: 5 } });
    expect(
      decodeHostPresentationMessage({
        kind: "editor-configuration",
        ...identity,
        revision: 3,
        insertSpaces: false,
        tabSize: 8,
      }),
    ).toMatchObject({ ok: true, value: { kind: "editor-configuration", tabSize: 8 } });
    expect(
      decodeHostPresentationMessage({
        kind: "style-snapshot",
        ...identity,
        revision: 4,
        css: ".cm-content {}",
      }),
    ).toMatchObject({ ok: true, value: { kind: "style-snapshot", revision: 4 } });
    expect(
      decodeHostPresentationMessage({
        kind: "restore-history-focus",
        ...identity,
        requestId: "request-1",
        documentVersion: 9,
        operation: "redo",
      }),
    ).toMatchObject({ ok: true, value: { kind: "restore-history-focus" } });
  });

  it("rejects non-positive presentation navigation coordinates", () => {
    expect(
      decodeHostPresentationMessage({
        kind: "editor-navigation",
        ...identity,
        documentVersion: 1,
        line: 0,
        column: 1,
      }).ok,
    ).toBe(false);
  });

  it("requires an EOL only for set-eol commands", () => {
    expect(
      decodeHostPresentationMessage({
        kind: "editor-command",
        ...identity,
        requestId: "request-1",
        documentVersion: 1,
        command: "set-eol",
      }).ok,
    ).toBe(false);
    expect(
      decodeHostPresentationMessage({
        kind: "editor-command",
        ...identity,
        requestId: "request-2",
        documentVersion: 1,
        command: "undo",
        eol: "lf",
      }).ok,
    ).toBe(false);
    expect(
      decodeHostPresentationMessage({
        kind: "editor-command",
        ...identity,
        requestId: "request-3",
        documentVersion: 1,
        command: "set-eol",
        eol: "crlf",
      }),
    ).toMatchObject({ ok: true, value: { kind: "editor-command", eol: "crlf" } });
  });

  it("rejects stale-identity-shaped and oversized messages", () => {
    expect(
      decodeHostPresentationMessage({
        kind: "style-snapshot",
        ...identity,
        controllerId: "",
        revision: 1,
        css: "",
      }).ok,
    ).toBe(false);
    expect(
      decodeHostPresentationMessage({
        kind: "style-snapshot",
        ...identity,
        revision: 1,
        css: "x".repeat(2 * 64 * 1024 + 1),
      }).ok,
    ).toBe(false);
  });
});
