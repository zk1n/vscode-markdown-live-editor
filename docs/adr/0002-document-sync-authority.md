# ADR 0002: VS Code TextDocument is the persistent document authority

Status: Accepted  
Date: 2026-09-02

## Context

A webview editor and VS Code TextDocument can become competing sources of truth. Timing races around Save and Undo/Redo can cause lost, duplicated, or misplaced text.

The project was motivated in part by observed behavior in another Live Preview editor where unexpected line breaks appeared during editing/Undo/Redo.

## Decision

- VS Code `TextDocument` is persistent authority.
- CodeMirror is transient editor state.
- Edits cross a typed, ordered protocol.
- Client edits include a base document version and sequence.
- Host edits are serialized.
- Save / Undo / Redo are synchronization barriers.
- Correctness must not depend on a debounce timeout.
- Stale versions cause controlled reject/resync, never blind positional application.
- VS Code document history is the baseline persistent Undo/Redo authority.

## Consequences

The synchronization layer is considered core product code and must not be delegated to a Live Preview rendering dependency.

This layer requires disproportionate automated/manual test coverage.
