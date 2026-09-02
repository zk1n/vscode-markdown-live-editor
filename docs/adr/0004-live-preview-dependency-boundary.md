# ADR 0004: Live Preview dependency is replaceable

Status: Accepted  
Date: 2026-09-02

## Context

`codemirror-live-markdown` is attractive because it already implements many Obsidian-like CodeMirror presentation features, but it is still in a pre-1.0 development phase.

The project should not make an alpha-stage library responsible for core document integrity.

## Decision

Define a project-owned `LivePreviewEngine` boundary.

If `codemirror-live-markdown` is adopted, integrate it only through an adapter.

The adapter may control presentation but may not own:

- persisted document state
- host document synchronization
- Save ordering
- Undo/Redo authority
- attachment writes
- workspace indexing

Before adoption, evaluate:

- license
- maintenance activity
- source mutation behavior
- IME behavior
- CodeMirror compatibility
- bundle/memory cost
- ability to disable unwanted features

## Consequences

Replacing or forking the Live Preview renderer remains feasible without rewriting the core editor.
