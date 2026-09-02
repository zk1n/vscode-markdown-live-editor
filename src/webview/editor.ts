import { markdown } from "@codemirror/lang-markdown";
import { Annotation, Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding, type ViewUpdate } from "@codemirror/view";

import {
  PROTOCOL_VERSION,
  decodeHostToWebviewMessage,
  type DocumentSnapshotMessage,
  type HostToWebviewMessage,
  type WebviewToHostMessage,
  type WirePosition,
} from "../protocol/messages.js";
import {
  createLivePreviewEngine,
  type LivePreviewEngine,
} from "./livePreview/LivePreviewEngine.js";

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
}

interface WebviewBootstrap {
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly sessionId: string;
  readonly nextSequence: number;
  readonly text: string;
}

declare function acquireVsCodeApi(): VsCodeApi;

const remoteUpdate = Annotation.define<boolean>();

class MarkdownWebviewController {
  private readonly editable = new Compartment();
  private readonly livePreview: LivePreviewEngine;
  private readonly view: EditorView;
  private authoritativeText: string;
  private documentVersion: number;
  private nextSequence: number;
  private inFlightSequence: number | undefined;
  private barrierInFlightSequence: number | undefined;
  private readonly barrierQueue: ("save" | "undo" | "redo")[] = [];
  private hasPendingLocalChanges = false;
  private disposed = false;

  public constructor(
    private readonly vscode: VsCodeApi,
    private readonly bootstrap: WebviewBootstrap,
    private readonly statusElement: HTMLElement,
    parent: HTMLElement,
  ) {
    this.authoritativeText = bootstrap.text;
    this.documentVersion = bootstrap.documentVersion;
    this.nextSequence = bootstrap.nextSequence;
    this.livePreview = createLivePreviewEngine();
    this.view = new EditorView({
      state: EditorState.create({
        doc: bootstrap.text,
        extensions: [
          markdown(),
          this.livePreview.extension,
          this.editable.of(EditorView.editable.of(true)),
          Prec.highest(
            keymap.of(
              createBarrierKeymap((action): void => {
                this.requestBarrier(action);
              }),
            ),
          ),
          EditorView.updateListener.of((update): void => {
            this.handleUpdate(update);
          }),
        ],
      }),
      parent,
    });
  }

  public receive(value: unknown): void {
    if (this.disposed) {
      return;
    }

    const decoded = decodeHostToWebviewMessage(value);
    if (!decoded.ok) {
      this.enterRecovery(`Invalid host message: ${decoded.error}`);
      return;
    }

    this.handleHostMessage(decoded.value);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.view.destroy();
    this.livePreview.dispose();
  }

  private handleUpdate(update: ViewUpdateLike): void {
    if (
      !update.docChanged ||
      this.disposed ||
      update.transactions.some((transaction) => transaction.annotation(remoteUpdate) === true)
    ) {
      return;
    }

    this.hasPendingLocalChanges = true;
    this.sendPendingEdit();
  }

  private sendPendingEdit(): void {
    if (this.inFlightSequence !== undefined || !this.hasPendingLocalChanges || this.disposed) {
      return;
    }

    const text = this.view.state.doc.toString();
    if (text === this.authoritativeText) {
      this.hasPendingLocalChanges = false;
      return;
    }

    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.inFlightSequence = sequence;
    this.hasPendingLocalChanges = false;
    this.vscode.postMessage({
      kind: "edit",
      protocolVersion: PROTOCOL_VERSION,
      documentUri: this.bootstrap.documentUri,
      sessionId: this.bootstrap.sessionId,
      sequence,
      documentVersion: this.documentVersion,
      changes: [fullDocumentReplacement(this.authoritativeText, text)],
    });
  }

  private requestBarrier(action: "save" | "undo" | "redo"): void {
    if (this.disposed) {
      return;
    }

    // Freeze before queueing the barrier so an edit made after the command
    // cannot overtake it. The host still supplies the authoritative result.
    this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(false)) });
    this.barrierQueue.push(action);
    this.sendPendingEdit();
    this.sendNextBarrier();
  }

  private handleHostMessage(message: HostToWebviewMessage): void {
    switch (message.kind) {
      case "operation-ack":
        this.handleAcknowledgement(message);
        return;
      case "document-update":
        this.handleDocumentUpdate(message);
        return;
      case "resync":
        this.documentVersion = message.documentVersion;
        this.nextSequence = message.nextSequence;
        this.inFlightSequence = undefined;
        this.barrierInFlightSequence = undefined;
        this.barrierQueue.length = 0;
        this.hasPendingLocalChanges = false;
        if (this.view.state.doc.toString() === this.authoritativeText) {
          this.applyAuthoritativeSnapshot(message);
          this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(true)) });
          this.showStatus(`Resynchronized after ${message.reason}: ${message.note}`);
        } else {
          this.authoritativeText = message.text;
          this.enterRecovery(
            `Resynchronization is required after ${message.reason}; local text remains visible: ${message.note}`,
          );
        }
        return;
      case "protocol-error":
        this.enterRecovery(message.note);
        return;
    }
  }

  private handleAcknowledgement(
    message: Extract<HostToWebviewMessage, { kind: "operation-ack" }>,
  ): void {
    this.documentVersion = message.documentVersion;
    if (message.operation === "edit" && message.sequence === this.inFlightSequence) {
      this.inFlightSequence = undefined;
      this.authoritativeText = message.text;
      if (this.hasPendingLocalChanges) {
        this.sendPendingEdit();
      } else {
        this.sendNextBarrier();
      }
      return;
    }

    this.applyAuthoritativeSnapshot(message);
    if (message.sequence === this.barrierInFlightSequence) {
      this.barrierInFlightSequence = undefined;
      this.barrierQueue.shift();
      this.sendNextBarrier();
    }
  }

  private handleDocumentUpdate(
    message: Extract<HostToWebviewMessage, { kind: "document-update" }>,
  ): void {
    this.documentVersion = message.documentVersion;
    if (message.text === this.authoritativeText) {
      return;
    }
    if (this.inFlightSequence !== undefined || this.hasPendingLocalChanges) {
      this.enterRecovery(
        "The document changed outside this webview while local edits were pending.",
      );
      return;
    }
    this.applyAuthoritativeSnapshot(message);
  }

  private applyAuthoritativeSnapshot(snapshot: DocumentSnapshotMessage): void {
    this.authoritativeText = snapshot.text;
    if (this.view.state.doc.toString() === snapshot.text) {
      return;
    }
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: snapshot.text },
      annotations: remoteUpdate.of(true),
    });
  }

  private enterRecovery(note: string): void {
    this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(false)) });
    this.showStatus(`Editing paused to protect unsynchronized text: ${note}`);
  }

  private sendNextBarrier(): void {
    const action = this.barrierQueue[0];
    if (action === undefined) {
      if (this.barrierInFlightSequence === undefined) {
        this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(true)) });
      }
      return;
    }
    if (
      this.inFlightSequence !== undefined ||
      this.barrierInFlightSequence !== undefined ||
      this.hasPendingLocalChanges ||
      this.disposed
    ) {
      return;
    }

    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.barrierInFlightSequence = sequence;
    this.vscode.postMessage({
      kind: action,
      protocolVersion: PROTOCOL_VERSION,
      documentUri: this.bootstrap.documentUri,
      sessionId: this.bootstrap.sessionId,
      sequence,
    });
  }

  private showStatus(note: string): void {
    this.statusElement.textContent = note;
    this.statusElement.hidden = false;
  }
}

type ViewUpdateLike = Pick<ViewUpdate, "docChanged" | "transactions">;

function createBarrierKeymap(
  requestBarrier: (action: "save" | "undo" | "redo") => void,
): readonly KeyBinding[] {
  const request =
    (action: "save" | "undo" | "redo"): (() => boolean) =>
    () => {
      requestBarrier(action);
      return true;
    };
  return [
    { key: "Mod-s", preventDefault: true, run: request("save") },
    { key: "Mod-z", preventDefault: true, run: request("undo") },
    { key: "Mod-y", preventDefault: true, run: request("redo") },
    { key: "Mod-Shift-z", preventDefault: true, run: request("redo") },
  ];
}

function fullDocumentReplacement(
  expectedText: string,
  text: string,
): {
  readonly range: { readonly start: WirePosition; readonly end: WirePosition };
  readonly expectedText: string;
  readonly text: string;
} {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: offsetToPosition(expectedText, expectedText.length),
    },
    expectedText,
    text,
  };
}

function offsetToPosition(text: string, offset: number): WirePosition {
  const beforeOffset = text.slice(0, offset);
  const lastNewline = beforeOffset.lastIndexOf("\n");
  return {
    line: lastNewline === -1 ? 0 : beforeOffset.split("\n").length - 1,
    character: offset - lastNewline - 1,
  };
}

function readBootstrap(): WebviewBootstrap {
  const element = document.getElementById("markdown-live-editor-bootstrap");
  if (element === null) {
    throw new Error("The editor bootstrap data is missing.");
  }
  const value: unknown = JSON.parse(element.textContent);
  if (!isBootstrap(value)) {
    throw new Error("The editor bootstrap data is invalid.");
  }
  return value;
}

function isBootstrap(value: unknown): value is WebviewBootstrap {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["documentUri"] === "string" &&
    typeof value["sessionId"] === "string" &&
    typeof value["text"] === "string" &&
    Number.isSafeInteger(value["documentVersion"]) &&
    typeof value["documentVersion"] === "number" &&
    value["documentVersion"] >= 0 &&
    Number.isSafeInteger(value["nextSequence"]) &&
    typeof value["nextSequence"] === "number" &&
    value["nextSequence"] >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const root = document.getElementById("editor-root");
const status = document.getElementById("editor-status");
if (root === null || status === null) {
  throw new Error("The editor webview root is missing.");
}

const controller = new MarkdownWebviewController(acquireVsCodeApi(), readBootstrap(), status, root);
window.addEventListener("message", (event: MessageEvent<unknown>): void => {
  controller.receive(event.data);
});
window.addEventListener("unload", (): void => {
  controller.dispose();
});
