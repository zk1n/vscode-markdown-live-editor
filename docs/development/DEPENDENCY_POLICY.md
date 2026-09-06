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

## GitHub Dependabot Intake / Development authority

GitHub Dependabotは`dependency update inbox / notification / public projection`として維持する。GitLab / Developmentが
実装、検証、merge historyのauthoritative sourceであり、GitHub Dependabot PRをmergeまたはcherry-pickしない。

1. PRのdependency、差分種別、release notes、CI、breaking change、現行engine / peer / editor boundaryとの互換性を調べる。
2. 非互換、CI FAIL、意図しないminimum runtime引上げは`REJECTED`とし、Development MRを作らない。
3. 採用品は最新Development `develop`から原則PRごとの独立maintenance branchを作り、同等変更を新規に生成する。
4. `npm ci`、`npm run check`、`npm run build`、`npm run package:vsix`、`git diff --check`を必須とする。
   Editor runtime dependencyは関連Extension Host / Human regressionを追加し、toolchain-only更新に不要なHuman matrixを課さない。
5. GREEN後だけ通常GitLab integrationで`develop`へ統合し、正常なpublic projectionを生成する。GitHub `develop`で同等以上の
   versionを確認してからDependabot PRを理由付きcloseする。Rejectはprojectionを待たずcloseできる。
6. GitLab MR APIを利用できない場合もbranch / commit / push、MR title / body / targetをhandoffし、権限を迂回しない。

1 PR = 1 MRをdefaultとし、不可分なdependencyだけgroupingできる。現在のintake dispositionは
[`DEPENDABOT_INTAKE.md`](DEPENDABOT_INTAKE.md)に記録する。`.github/dependabot.yml`は削除しない。

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

### `@vscode/vsce` 3.9.2

VSIX packaging の development-only CLI として追加する。version は lockfile を含め exact に固定する。

- license: MIT
- maintenance: VS Code extension packaging の公式 CLI として VS Code documentation が案内する
- scope / cost: package と VSIX manifest 構築のための transitive dependencies が増える。extension runtime bundle には含めない
- security: CI は `vsce package --no-dependencies` だけを使い、publish command、publisher credential、Marketplace token、remote write を使わない。生成 VSIX の ZIP entry を project-owned script で allowlist 検証する
- replaceability: package boundary は npm script と project-owned validation script に限定し、extension runtime は `vsce` API に依存しない

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
