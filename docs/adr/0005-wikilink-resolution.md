# ADR 0005: Obsidian-like shortest unambiguous WikiLink resolution

Status: Accepted for v0.4 direction  
Date: 2026-09-02

## Decision

WikiLinks use the shortest target that is unambiguous in the workspace.

Examples:

```text
[[2026-09-02]]
[[ProjectA/Status]]
[[ProjectA/Status|Status]]
[[ProjectA/Status#TODO]]
```

Rules:

1. One matching filename stem -> resolve directly.
2. Multiple matching stems -> do not guess.
3. Autocomplete inserts enough path to disambiguate.
4. Clicking an ambiguous manually typed link opens Quick Pick.
5. Missing links may offer note creation.
6. Backlinks use the same resolved index.
7. The workspace's naming convention is not imposed by the extension.

## Rationale

This keeps simple links short while avoiding accidental navigation to the wrong note.
