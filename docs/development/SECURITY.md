# Security Design

## Threat model

Primary concerns:

- a Markdown file causing arbitrary script execution
- local path traversal
- unintended external network requests
- rich renderer vulnerabilities
- source-text corruption
- dependency compromise
- workspace boundary escape

## Webview

Use restrictive CSP.

Scripts must be extension-bundled and nonce-authorized.

Do not use a broad `https:` script source.

## Custom CSS

Custom CSSはUser Settingsのliteralと、trusted workspaceでactive documentを所有するfolderの固定
`.vscode/markdown-live-editor.css`だけを読む。任意path、workspace外探索、`@import`、`url()`、resource scheme、
CSS escape、NUL、malformed UTF-8 / structure、64 KiB/source超過を拒否する。Webviewへは検証済みsnapshotだけを渡し、
dedicated `<style>`をtextとして原子的に置換する。invalid / missing / read errorはbase Styleへfallbackし、編集authorityを止めない。

Native Markdown OutlineはWebview外のVS Code Tree Viewであり、Custom CSS対象にしない。

## Local files

When resolving images/attachments:

- normalize paths
- resolve against workspace/document root policy
- reject traversal outside allowed root
- use VS Code URI/file APIs where appropriate
- do not read arbitrary machine files from Markdown references

## Remote resources

Default:

- remote images OFF
- Raw HTML OFF

A future opt-in must explain network/privacy consequences.

## Markdown HTML

Do not render arbitrary raw HTML by default.

If later supported, it requires an ADR and sanitizer/security review.

## Mermaid

Treat Mermaid source as untrusted Markdown content.

Before enabling:

- review current security advisories
- use maintained patched version
- configure strict/sandboxed posture where feasible
- avoid click/javascript callbacks unless explicitly designed
- fail closed on unsupported constructs

## Attachments

Clipboard paste writes only into configured workspace-bounded directories.

Reject:

- absolute destinations outside workspace
- `..` traversal escaping workspace
- unsafe filename injection

## Network

The extension has no required network API and no telemetry.

Document any future network capability explicitly.

## Shell

Do not execute arbitrary shell commands from Markdown content.

## Git

Extension runtime does not interact with remote Git.

Project development scripts must not hide remote writes.

## Dependencies

Use lockfile + Dependabot + CI.

Security-sensitive dependency update may trigger a dedicated fix branch and release.
