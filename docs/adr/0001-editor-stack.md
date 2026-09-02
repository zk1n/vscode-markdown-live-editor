# ADR 0001: Editor stack

Status: Accepted  
Date: 2026-09-02

## Context

The project needs an Obsidian-like Markdown editing surface inside VS Code while minimizing added memory and dependency complexity.

## Decision

Use:

- TypeScript
- VS Code Custom Text Editor API
- CodeMirror 6
- Vanilla DOM/TypeScript for webview UI
- esbuild for bundling
- strict TypeScript checking separately from bundling

Do not add React/Vue/Svelte by default.

Use Node.js 24 LTS for development tooling via mise.

Initial compiler/tooling versions are deliberately conservative rather than always following the newest major immediately.

## Consequences

Positive:

- relatively small webview runtime
- modular editor dependencies
- easier memory profiling
- direct control over synchronization and lifecycle
- fewer framework-specific abstractions

Negative:

- some UI utilities must be built directly
- contributors need to understand CodeMirror 6 transaction/state patterns
