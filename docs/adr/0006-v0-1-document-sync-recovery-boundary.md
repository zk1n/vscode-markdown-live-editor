# ADR 0006: v0.1 document synchronization recovery boundary

Status: Accepted
Date: 2026-09-02

## Context

ADR 0002 establishes VS Code `TextDocument` as the persisted authority. The
v0.1 implementation must make that decision concrete without treating
asynchronous webview messages, CodeMirror state, or `WorkspaceEdit` results as
an independent source of truth.

The public VS Code API does not expose an atomic compare-and-swap edit by
`TextDocument.version`, a universal pre-Undo/Redo hook, or a guaranteed
pre-save hook for every possible integrity save. A design that hides those
limits would risk silent source corruption.

## Decision

For v0.1:

- Every webview operation is validated from `unknown`, names the document and
  session, and carries a monotonic client sequence.
- A client edit names its base `TextDocument.version`, uses UTF-16
  line/character ranges, and includes the exact source it expects to replace.
- The host serializes every operation for a document in one FIFO queue. A
  sequenced Save, Undo, or Redo request cannot overtake a received edit.
- The host rereads `TextDocument` after every mutation and acknowledges only
  the resulting authoritative snapshot.
- Protocol text uses LF as its canonical line-separator representation, matching
  CodeMirror's document model. `VscodeDocumentPort` projects replacement text
  to `TextDocument.eol` only at the VS Code boundary and converts snapshots
  back to canonical LF before exact expected-result comparison. This preserves
  the TextDocument/disk EOL convention while keeping protocol comparisons exact.
- A stale version, sequence gap, mismatched source, rejected port operation,
  or inconsistent result produces an explicit resync/recovery message. It is
  never applied positionally against newer text.
- The webview holds only transient state, sends stable CodeMirror transactions
  immediately, and has at most one edit operation in flight. It does not add
  CodeMirror persistent history.
- Webview `Mod+S`, `Mod+Z`, `Mod+Y`, and `Mod+Shift+Z` are routed through the
  host queue. `onWillSaveTextDocument` flushes work already received by the
  host as a best-effort Auto Save barrier. A Save initiated by that same host
  queue bypasses the listener's flush to avoid self-waiting during
  `TextDocument.save()`.
- For those exact four physical shortcuts, the CodeMirror webview keymap is
  the semantic owner. A handled binding uses both `preventDefault` and
  `stopPropagation`: VS Code's webview wrapper may forward trusted keydown
  events to the workbench even after `preventDefault`, so default prevention
  alone cannot establish a single owner. This is deliberately limited to the
  four bindings; unrelated workbench shortcuts continue to bubble normally.
- The local-only diagnostic ring retains at most 250 metadata-only events.
  It records operation IDs, versions, queue state, focus/selection offsets,
  and text length/fingerprint rather than Markdown bodies. It is available via
  an explicit copy command and does not add a network or telemetry path.
- When an external update arrives while local work is pending, editing pauses
  and the local text remains visible for recovery rather than being silently
  overwritten.

The VS Code adapter checks `TextDocument.version` immediately before applying a
`WorkspaceEdit`, then verifies the resulting snapshot. This reduces, but does
not eliminate, the public-API race between that check and VS Code applying the
edit. The v0.1 manual test matrix and future extension-host contract tests are
therefore release gates.

## Consequences

The implementation has a small, testable pure synchronization core and an
explicit adapter boundary. It also has deliberately visible recovery states
instead of an unsupported automatic merge/rebase system.

The following remain manual/extension-host validation items before release:

- real Windows Japanese IME composition, including Save and Undo timing;
- host command/menu Undo and Redo behavior while the custom editor has focus;
- Auto Save and forced-save behavior;
- concurrent external file replacement close to a webview edit.

Synthetic DOM tests prove the CodeMirror propagation boundary but cannot make
an event trusted to VS Code. Actual OS/VS Code shortcut delivery, menu/command
paths, and ATOK composition remain separate Human Gate surfaces.
