# ADR 0007: v0.1 Live Preview uses project-owned CodeMirror decorations

Status: Accepted
Date: 2026-09-02

## Context

Slice 2 needs Obsidian-like presentation without changing the raw Markdown
document, the synchronization protocol, or VS Code history ownership.

The evaluated `codemirror-live-markdown@0.5.1-alpha.1` core decorations do not
directly rewrite source, but the published artifact also contains a table editor
that serializes and replaces Markdown source. It has no composition-aware path,
documents IME flicker as a limitation, is alpha-stage, and pulls a much larger
bundle than this slice requires.

## Decision

For v0.1, provide a project-owned `LivePreviewEngine` backed by CodeMirror
`Decoration.mark` and `StateField` state. It supports only:

- ATX heading markers;
- strong markers (`**`, `__`);
- emphasis markers (`*`, `_`).

The engine recognizes a conservative subset and skips fenced code blocks. It
hides markers and styles content only when a caret or selection is outside the
enclosing syntax range. On `compositionstart`, it removes preview decorations;
on `compositionend`, decorations are recalculated. These are effects-only
presentation transactions.

The engine owns no document changes, filesystem activity, commands, history,
protocol messages, document versions, sequence numbers, or recovery decisions.
Its lifecycle is owned by the webview controller and disposed with its
`EditorView`.

`codemirror-live-markdown` remains a future candidate only behind the existing
project-owned boundary, after a separately accepted ADR and the full IME,
bundle, selection, and source-integrity evidence set.

## Consequences

The first slice has a small and removable rendering surface with no new runtime
dependency. It intentionally omits richer Markdown syntax and advanced widgets.
Manual Windows IME and cursor/selection behavior remain release gates because
CodeMirror-level tests cannot reproduce the operating system input path.
