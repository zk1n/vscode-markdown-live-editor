# Security Policy

## Supported versions

Before v1.0, only the latest development line is supported.

## Reporting

When the repository is public, prefer a private GitHub Security Advisory for vulnerabilities that could expose files, execute code, bypass workspace boundaries, or cause data corruption.

Do not publish proof-of-concept exploit details in a public issue before a fix can be prepared.

## Security posture

The extension is intended to:

- avoid telemetry
- avoid required network APIs
- avoid arbitrary shell execution
- avoid Git remote operations
- restrict local resource access
- keep remote images disabled by default
- keep Raw HTML disabled by default
- use restrictive Webview CSP
- treat Mermaid and other rich renderers as untrusted-input boundaries
