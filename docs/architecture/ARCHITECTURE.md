# Architecture

## 1. Architectural goals

Priorities, in order:

1. source-text correctness
2. predictable Save / Undo / Redo
3. maintainability and testability
4. low idle memory overhead
5. rich Live Preview experience

## 2. Runtime boundaries

```text
VS Code Extension Host
│
├─ ExtensionController
├─ EditorSessionRegistry
├─ EditorSession
│  ├─ DocumentSyncCoordinator
│  ├─ HistoryCoordinator
│  ├─ SaveCoordinator
│  └─ ProtocolEndpoint
│
├─ WorkspaceService
│  ├─ WorkspaceIndex        (later)
│  ├─ WikiLinkResolver      (later)
│  ├─ BacklinkIndex         (later)
│  └─ AttachmentService     (later)
│
└─ UI Providers
   ├─ OutlineProvider
   └─ BacklinkProvider      (later)

        typed Webview protocol
               │
               ▼

VS Code Webview
│
├─ EditorController
├─ CodeMirror 6
├─ HostSyncClient
├─ LivePreviewEngine
│  └─ CodeMirrorLiveMarkdownAdapter (candidate, later)
├─ FrontMatterPresenter
├─ MathRenderer             (later)
├─ TableRenderer            (later)
├─ MermaidRenderer          (later)
└─ ImageRenderer            (later)
```

## 3. Object-oriented boundaries

Use classes/objects where state, lifecycle, or coordination matters.

Examples:

- `EditorSession`
- `DocumentSyncCoordinator`
- `HostSyncClient`
- `WorkspaceIndex`
- `AttachmentService`
- `MermaidRenderer`

Use pure functions for stateless operations.

Examples:

- WikiLink parsing
- path normalization
- heading extraction
- protocol schema validation helpers
- Markdown source transformations that are explicitly requested

Avoid class hierarchies that exist only for style. Prefer interfaces + composition.

## 4. Dependency inversion

Central features use project-owned interfaces.

Example:

```ts
export interface LivePreviewEngine {
  attach(context: LivePreviewContext): DisposableLike;
}
```

A third-party implementation is an adapter:

```text
LivePreviewEngine
       ↑
CodeMirrorLiveMarkdownAdapter
```

This prevents an alpha/abandoned library from becoming the architecture.

Same rule applies to Mermaid/table renderers when useful.

## 5. Document authority

Canonical state:

```text
Disk
  ↕ VS Code
TextDocument
  ↕ ordered protocol
CodeMirror transient editor state
```

`TextDocument` is the persisted authority.

CodeMirror is not allowed to become an independent competing document database.

## 6. Synchronization model

### 6.1 Requirements

Every edit operation must have:

- document identifier
- base VS Code document version
- client sequence number
- ordered application
- explicit acknowledgement or rejection

Conceptual message:

```ts
type ClientEdit = {
  readonly kind: "edit";
  readonly documentVersion: number;
  readonly sequence: number;
  readonly changes: readonly TextChange[];
};
```

Do not lock the exact wire shape until Slice 1 implementation, but preserve these semantics.

### 6.2 Ordered operation queue

Host-side document mutations execute sequentially.

No Save/Undo/Redo command may overtake an already-visible edit.

### 6.3 No correctness debounce

Do not delay document synchronization merely to reduce event volume and then depend on a timeout for Save/Undo correctness.

Performance coalescing may be introduced later only if:

- operation order remains explicit
- Save/Undo barriers can synchronously/explicitly wait for all prior edits
- regression tests prove no data loss

### 6.4 Stale edits

If `baseVersion` no longer matches:

- do not blindly apply offsets to a changed document
- reject/resynchronize in a controlled way
- preserve recoverable user input when possible
- never silently drop content

Exact recovery semantics require tests and may evolve through ADR.

## 7. Save model

Save is a barrier:

```text
User Save request
       ↓
finish/acknowledge all prior editor operations
       ↓
VS Code document Save
       ↓
Save completion
```

Visible editor content before the Save request must be included.

VS Code Auto Save must pass through equivalent host synchronization semantics.

## 8. Undo / Redo model

Preferred baseline:

- VS Code `TextDocument` history is persistent Undo/Redo authority.
- CodeMirror local history must not independently conflict with it.
- before Undo/Redo, prior editor mutations must be fully integrated
- execute host Undo/Redo
- host document changes flow back to CodeMirror

Selection/caret state needs explicit design and testing, but source correctness wins if trade-offs arise.

## 9. IME composition

Composition is editor-local until CodeMirror emits stable document transactions appropriate for synchronization.

Do not invent ad-hoc key handling that breaks standard composition events.

Avoid intercepting Enter/Backspace globally unless required.

IME cases must be manually validated on Windows Japanese IME.

## 10. Live Preview

Live Preview is a presentation layer over the same source.

It may:

- decorate
- replace visual spans with widgets
- reveal syntax near selection/caret

It must not rewrite source merely to normalize presentation.

`codemirror-live-markdown` is a candidate implementation, not a permanent architectural requirement.

## 11. Front Matter

Presentation-only collapsed properties view.

Source remains exact YAML.

Do not parse and rewrite YAML simply by opening the file.

## 12. Workspace index

Later WikiLink/backlink index stores only information required for navigation:

- normalized file path
- stem/name
- headings
- outgoing links
- minimal metadata required for resolution

Do not keep every Markdown file's full source in memory if not required.

Index is rebuildable.

## 13. Webview security

Use a restrictive CSP.

Default concept:

```text
default-src 'none'
img-src <webview-source> data:
style-src <webview-source> 'unsafe-inline' only if unavoidable
script-src 'nonce-...'
font-src <webview-source>
```

Exact CSP should be tightened per implemented features.

Never enable unrestricted `https:` image loading by default.

## 14. Disposal

Every lifecycle object that registers a listener/watcher must be disposable.

Closing an editor must release:

- webview listeners
- document subscriptions
- timers
- observers
- renderer instances
- large caches scoped to that editor

## 15. Performance measurement

Measure extension-added memory rather than guessing.

Record baselines in `docs/performance/`.

Do not trade correctness for memory before profiling identifies a real issue.
