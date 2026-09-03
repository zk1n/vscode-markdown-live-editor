# Test Strategy

## 1. Test pyramid

### Unit

Pure logic and state machines:

- protocol validation
- sequence/order handling
- version checks
- WikiLink parsing later
- path validation later
- attachment naming later

### Integration

Component boundaries:

- Webview sync client vs host sync coordinator
- edit queue
- acknowledgement
- reject/resync
- Save barrier
- Undo/Redo command ordering

### VS Code extension integration

Use VS Code test tooling for:

- Custom Text Editor registration
- TextDocument edits
- external document changes
- Undo/Redo integration
- Save where automation is feasible

### Manual

Required where automation cannot faithfully cover OS input behavior:

- Windows Japanese IME
- real keyboard shortcuts
- visual caret behavior
- memory observation
- extended real-use session

CodeMirror DOM propagation tests and controller/protocol sequence tests prove
the project-owned route and ordering only. They do not make synthetic events
trusted to VS Code and do not replace actual OS/VS Code key delivery or ATOK
Human Gate evidence.

## 2. v0.1 critical invariants

A test failure in these areas blocks promotion:

1. visible edits are preserved
2. no unexpected newline/character insertion
3. edit ordering is deterministic
4. stale edits are not blindly applied
5. Save includes prior visible edits
6. Undo/Redo does not create content
7. external changes converge safely
8. editor disposal does not retain stale synchronization state

## 3. Race-focused tests

Create deterministic tests instead of using sleeps where possible.

Examples:

```text
edit A pending
edit B arrives
Save requested
```

Expected:

```text
A -> B -> Save
```

```text
edit A pending
Undo requested
```

Expected:

```text
A integrated -> Undo A
```

```text
edit based on version 10
external host change creates version 11
old edit arrives
```

Expected:

```text
reject/resync
```

not positional application against version 11.

## 4. IME

Do not simulate confidence from simple key events alone.

Manual acceptance on Windows Japanese IME remains mandatory for release until robust automated composition testing is demonstrated.

## 5. Rich Preview regression rule

Any visual feature that uses CodeMirror decorations/widgets must have a source-integrity regression test.

Opening, rendering, scrolling, focusing, and unfocusing a document must not alter source.

## 6. Commands

Baseline:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run check
npm run test:extension-host
```

`npm run check` is the pre-integration baseline.

`npm run test:extension-host` is the separately runnable public-API smoke
suite. It uses a pinned VS Code test instance and may download it on its first
run; keep it outside the fast `check` path while it remains an integration
environment dependency.

## 7. Release manual evidence

Before `test -> release/*` approval, record manual results in a dated document or release checklist.

A public release should not rely only on "it seemed fine".
