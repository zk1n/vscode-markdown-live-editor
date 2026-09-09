# ADR 0007: v0.1 Live Preview uses project-owned CodeMirror decorations

Status: Accepted
Date: 2026-09-02
Last updated: 2026-09-03

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
`StateField` state, `Decoration.mark` for semantic/visible presentation, and
widgetless `Decoration.replace({})` for hidden source markers. It supports the conservative subset
needed by Roadmap Slice 2:

- ATX heading markers;
- strong markers (`**`, `__`);
- emphasis markers (`*`, `_`).
- strikethrough markers (`~~`);
- inline-code markers (matching backtick runs);
- ordered/unordered list prefixes;
- GFM task prefixes, rendered as an inactive checked/unchecked visual marker;
- blockquote prefixes; and
- simple inline links (`[label](destination)`).

The engine skips fenced code blocks and keeps complex/nested inline forms as
raw source. It does not add task toggles, link navigation, source rewriting, or
other interactive widgets. It keeps semantic styling on syntax content even
while its caret/selection is inside that range, and reveals all source markers
only for that syntax range. Hidden markers are replacement decorations rather
than CSS-hidden DOM text, so a caret on an adjacent line does not reveal raw
source or offer an invisible marker to native newline deletion. This avoids
heading font-size and line-height changes when a caret crosses a source marker.

For CodeMirror transactions identified as `input.type.compose`, it maps the
existing decoration set through the text change rather than rebuilding it. It
does not install a project `compositionstart`/`compositionend` handler that
dispatches an additional CodeMirror transaction. The next non-composition
transaction recalculates presentation normally. This decision is specifically
intended to avoid a document-wide DOM transition while an IME establishes or
updates a composition range. It does not claim to solve a browser/ATOK input
bug without A1-A4 diagnostic evidence.

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
CodeMirror-level tests cannot reproduce the operating system input path. ATOK
is a required v0.1 manual regression target alongside any separately verified
Microsoft IME environment.
