# Product Specification

## 1. Product definition

`vscode-markdown-live-editor` is a VS Code extension that provides an Obsidian-like Live Preview editing experience while preserving ordinary Markdown files as the only source of truth.

It is not an Obsidian clone and does not reimplement functionality already provided well by VS Code.

## 2. Primary user value

A user should be able to remain inside VS Code and obtain:

- pleasant Live Preview Markdown editing
- reliable normal text editing
- CSS customization
- outline navigation
- compact Front Matter presentation
- math
- editable tables
- image preview and controlled attachment placement
- Mermaid diagrams
- WikiLinks
- backlinks

while continuing to use VS Code for:

- Git
- diff
- branch management
- file explorer
- workspace search
- terminal
- draw.io extension
- other developer tooling

## 3. Non-goals

The extension will not initially provide:

- Git client
- remote repository sync
- automatic Git commit
- graph view
- draw.io editor
- proprietary note database
- cloud account
- collaboration server
- telemetry
- AI features
- arbitrary plugin runtime

## 4. File compatibility

### 4.1 Canonical data

Ordinary `.md` files are canonical.

The extension must not require hidden document state to reconstruct a file.

### 4.2 Portability

Files must remain usable in:

- VS Code text editor
- Obsidian
- GitHub/GitLab
- CLI tools
- other CommonMark/GFM-oriented Markdown tools

Extension-specific features should degrade to readable Markdown syntax.

## 5. Markdown baseline

Baseline:

- CommonMark-oriented Markdown
- GFM extensions where compatible
- YAML Front Matter preserved
- WikiLink syntax added as an extension

Supported core syntax target:

- H1-H6
- paragraphs
- emphasis
- strong
- strikethrough
- inline code
- fenced code blocks
- ordered/unordered lists
- task lists
- blockquotes
- horizontal rules
- links
- local images
- GFM tables

## 6. Editor interaction

### 6.1 Live Preview

When markup is not actively edited, markup characters may be visually replaced by rendered presentation.

When the caret/selection enters the relevant source region, source syntax must become directly editable.

Rendering must never mutate source text merely because a visual representation changed.

### 6.2 Core text behavior

Expected standard editing:

- typing
- selection
- cut/copy/paste
- find/replace
- Enter / Shift+Enter
- Backspace / Delete
- standard cursor navigation
- Ctrl+Z
- Ctrl+Y
- Ctrl+Shift+Z
- Ctrl+S
- VS Code Auto Save

### 6.3 Reliability invariant

The extension must never generate an unrequested newline, heading, character duplication, or source deletion because of asynchronous synchronization.

A visual renderer failure must not alter source text.

## 7. Document synchronization

VS Code `TextDocument` is the persisted authority.

The Webview editor may hold transient UI/editor state, but host synchronization uses:

- typed messages
- explicit document versions
- explicit operation sequence IDs
- ordered processing
- acknowledgement
- stale-operation detection
- controlled resynchronization

Correctness must not depend on an arbitrary timeout.

Save and Undo/Redo operations act as synchronization barriers.

## 8. Undo / Redo

Persistent Undo/Redo semantics should integrate with VS Code document history.

Before issuing Undo/Redo, pending visible edits must be fully integrated into the document history.

Undo/Redo must not:

- create new source characters
- create new newlines
- duplicate Markdown blocks
- silently discard unacknowledged input

Caret/selection restoration should be as natural as practical and must not compromise source correctness.

## 9. Japanese IME

Japanese IME is a first-class acceptance requirement.

Composition events must not cause intermediate text corruption.

Test cases include:

- hiragana input
- kanji conversion
- multi-segment conversion
- Enter composition confirmation
- Undo after composition
- Backspace during composition
- cursor movement around committed composition

## 10. Front Matter

Raw YAML is always preserved.

Target compact presentation:

```text
▸ Properties    tags: work   project: ABC   status: active
```

Interaction:

- collapsed by default in Live Preview
- click/focus expands source
- editing uses raw YAML initially
- richer property editing may be considered later

The compact representation is presentation only.

## 11. CSS customization

Support:

- VS Code theme variables by default
- user setting for custom CSS
- workspace-relative custom CSS
- safe live reload
- path restrictions

Custom CSS must not grant arbitrary file/script execution.

## 12. Outline

Parse H1-H6 and present hierarchical outline.

Requirements:

- click to navigate
- updates after document changes
- no full-workspace scan for document-local outline
- compatible with custom editor focus

## 13. Math

KaTeX is the preferred renderer.

Support:

- `$inline$`
- `$$block$$`

Source becomes available when actively edited.

Invalid formulas render an error state without mutating the Markdown.

## 14. Tables

GFM tables are canonical source.

Target experience:

- rendered table outside active editing
- cell editing
- source-mode escape hatch
- no silent reformat that changes semantic content
- deterministic formatting when explicit reformat is requested

Table editor behavior must have dedicated Undo/Redo regression tests.

## 15. Images and attachments

### 15.1 Preview

Render workspace-local relative Markdown images.

### 15.2 Paste

Clipboard image paste may save an attachment and insert Markdown.

Configurable settings:

```text
attachment path: assets/${yyyy}/${MM}
file name: ${yyyyMMdd-HHmmss}
```

Initial image format preference: PNG.

### 15.3 Security

- attachment writes remain inside workspace
- path traversal rejected
- remote images disabled by default
- file size limits may be added

## 16. Mermaid

Detect fenced blocks:

````text
```mermaid
...
```
````

Behavior:

- lazy-load renderer when required
- rendered diagram when not editing source
- source/edit mode on interaction
- renderer error does not alter source
- use patched/current maintained Mermaid version
- restrictive Mermaid security settings
- Webview CSP remains restrictive

## 17. WikiLinks

Target syntax:

```text
[[Note]]
[[Note|Alias]]
[[Folder/Note]]
[[Note#Heading]]
[[Folder/Note#Heading|Alias]]
```

### Resolution rules

Use an Obsidian-like shortest unambiguous target.

Example workspace:

```text
Daily/2026-09-02.md
ProjectA/Status.md
ProjectB/Status.md
```

`[[2026-09-02]]` resolves automatically because only one matching stem exists.

`[[Status]]` is ambiguous and must not silently choose a target.

Autocomplete should insert a distinguishing path when necessary:

```text
[[ProjectA/Status]]
```

For a manually typed ambiguous link, clicking opens a Quick Pick.

Missing links may offer note creation.

## 18. Backlinks

Maintain an incremental workspace index for Markdown link relations.

Do not rescan every file on every edit.

The index is a rebuildable cache, not canonical user data.

Display backlinks in a VS Code view.

## 19. Performance and memory

The extension should add as little persistent memory as practical.

Principles:

- no frontend framework by default
- one editor runtime per active webview only
- dispose inactive resources
- lazy-load Mermaid/KaTeX when possible
- incremental workspace index
- do not cache full file contents if link metadata is sufficient
- establish measured v0.1 baseline before setting hard memory targets

## 20. Security defaults

- Workspace Trust respected
- restrictive CSP
- remote images OFF
- Raw HTML OFF
- no telemetry
- no network API requirement
- no arbitrary shell execution
- no Git remote operation
- workspace-bounded file access
- renderer dependencies reviewed and pinned by lockfile

## 21. Release acceptance

A release candidate is not accepted solely by automated CI.

Process:

1. automated tests green
2. candidate integrated to `test`
3. user performs manual/real-use validation
4. user explicitly accepts release preparation
5. `release/vX.Y.Z`
6. version/changelog/final checks
7. human pushes
8. human opens/reviews/merges `release/* -> main` PR
9. human publishes release/VSIX as desired
