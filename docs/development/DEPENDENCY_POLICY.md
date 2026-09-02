# Dependency Policy

## Principles

Dependencies are not free. Evaluate:

- maintenance
- license
- security history
- transitive dependency count
- runtime size
- memory impact
- API stability
- replaceability
- whether the dependency touches user data integrity

## Versioning

- `package-lock.json` is committed.
- CI uses `npm ci`.
- dependency upgrades are deliberate and tested.
- Dependabot may propose updates, but editor-core dependencies are not auto-merged.
- major upgrades require explicit review.
- security updates may be expedited but still require tests.

## Initial choices

### Node.js 24 LTS

Development tooling runtime.

Reason:

- LTS line
- compatible with modern ESLint tooling
- long enough maintenance horizon for the project start

This does not mean the VS Code Extension Host is Node 24. Runtime code must remain compatible with the minimum supported VS Code version.

### TypeScript 6.0.x initially

The newest major compiler is not automatically required on project day one.

Start from a mature recent compiler line and upgrade deliberately after lint/build/test tooling compatibility is verified.

Strict flags matter more than chasing the newest syntax.

### ESLint 9 maintenance line initially

Use the maintained ESLint 9 line rather than immediately adopting a newly released major if compatibility gives no project benefit.

### CodeMirror 6

Accepted core editor engine.

Reasons:

- modular
- mature
- actively maintained
- lower webview overhead than embedding another Monaco instance
- strong state/transaction model
- Markdown language support
- no frontend framework required

### `codemirror-live-markdown`

Candidate only.

It is not included in the initial scaffold dependencies.

Before v0.1 Live Preview Slice:

1. inspect current release/license
2. test against selected CodeMirror packages
3. test IME
4. test source mutation behavior
5. measure bundle/memory
6. integrate through `LivePreviewEngine` adapter only if acceptable

### KaTeX

Deferred until v0.2.

Load only when math is present if practical.

### Mermaid

Deferred until v0.3.

Use a maintained patched release and restrictive security configuration. Security review is mandatory before adding/upgrading.

## Avoided by default

- React
- Vue
- Svelte
- DI containers
- general-purpose state frameworks
- telemetry SDKs
- Git libraries
- cloud SDKs

These may be reconsidered only with a clear benefit and ADR.
