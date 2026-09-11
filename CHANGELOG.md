# Changelog

## 0.2.0 — 初回開発レビュー

- GFM表のセル編集、行列操作、配置変更、source表示切替。
- 相対画像の表示・編集と、画像のファイル選択・貼り付け・ドロップ挿入。
- Live Editor内の検索・置換、正規表現、選択範囲。
- 標準Markdown linkのhover preview、Ctrl+クリック、見出しfragment。
- 見出しEnterによる段落挿入と、sourceを保持する空行のコンパクト表示。
- 入力ACK中のStatus Bar hide/showを抑制。実視覚ちらつきの確認はレビュー待ち。

正式releaseではなく、実機のIME・操作感の確認前です。

All notable changes to this project will be documented in this file.

The project follows semantic versioning.

## [0.1.0] - 2026-09-08

### Added

- Stable Markdown Live Editor based on CodeMirror 6 with VS Code `TextDocument` authority.
- Source-preserving Save, Undo / Redo, external-update recovery, LF / CRLF, Tab / indentation, and Japanese IME handling.
- Conservative Live Preview for headings, emphasis, strikethrough, inline code, lists, task items, blockquotes, and simple links.
- Native Markdown Outline and bounded Custom CSS support.

### Known limitations

- Live Editor `Ctrl+F` search is deferred to v0.2+.
- Math, GFM table editing, image preview, Mermaid, and WikiLink / Backlink are outside the v0.1 scope.

## [Unreleased]

### Added

- Initial project scaffold and engineering specifications.
