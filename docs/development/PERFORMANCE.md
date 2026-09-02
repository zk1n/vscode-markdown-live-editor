# Performance and Memory

## Goal

Provide rich Markdown editing without turning the extension into another large application runtime inside VS Code.

## Design rules

- no frontend framework by default
- CodeMirror modules only as needed
- avoid duplicate parser/editor runtimes
- lazy-load heavy rich renderers
- dispose closed editor resources
- incremental backlinks/indexing
- cache metadata, not full workspace source
- avoid background polling when FileSystemWatcher/events suffice

## Measurement

Do not invent a hard memory budget before measuring v0.1.

Record:

- VS Code baseline
- one normal text Markdown editor
- one custom Markdown Live Editor
- multiple custom editors
- after closing editors
- after repeated open/close cycles

Track:

- Extension Host memory
- renderer/webview process memory where observable
- bundle size
- activation time
- indexing time

Store dated measurements under:

```text
docs/performance/
```

A significant regression requires investigation before release.
