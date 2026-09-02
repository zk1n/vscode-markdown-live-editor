# ADR 0008: IME composition has one authoritative commit boundary

Status: Accepted for ATOK remediation  
Date: 2026-09-02

## Context

ADR 0002 and ADR 0006 establish VS Code `TextDocument` as persistent authority
and originally describe forwarding stable CodeMirror edits immediately. ATOK
manual testing found that its romaji/preedit changes can become many persistent
`WorkspaceEdit` operations. This exposes internal IME states to VS Code Undo
and makes Save/Undo/Redo ordering unsafe to change by timing heuristics.

The public VS Code API has no `WorkspaceEdit` undo-group identifier or
equivalent atomic grouping control. `TextEditor.edit` undo-stop options do not
apply to this Custom Text Editor architecture, and proposed/internal APIs are
out of scope.

## Decision

For an IME composition recognized by CodeMirror's composition lifecycle:

- CodeMirror keeps the preedit transient and local.
- The sync client sends no persistent edit for intermediate preedit updates.
- At the completed composition boundary, it sends one exact replacement from
  the last acknowledged authoritative text to the final CodeMirror text.
- The resulting one `WorkspaceEdit` is the composition's persistent Undo unit.
- Save, Undo, and Redo requested while composition is active remain queued;
  they do not reconfigure the content DOM, force a commit, or overtake the
  final composition edit.
- An authoritative external update during composition enters visible recovery
  without silently overwriting the local preedit.

The implementation must use semantic composition state (`compositionStarted`
and input/composition events corroborated by the development trace), never an
arbitrary timeout. It must preserve the ADR 0006 FIFO, exact-text verification,
and explicit recovery rules.

## Consequences

The `TextDocument` can temporarily lag CodeMirror only during an uncommitted
composition. This is intentional and tightly bounded. Save/close/external
update/recovery behavior must be regression-tested before this ADR is marked
implemented.

The current Windows target is ATOK. Microsoft IME requires its own recorded
manual result and cannot substitute for ATOK release-gate evidence.
