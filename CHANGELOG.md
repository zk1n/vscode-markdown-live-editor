# Changelog

## 0.2.0 — UX修正版開発レビュー

- GFM表のセル編集、行列操作、配置変更、source表示切替。
- 相対画像の表示・編集と、画像のファイル選択・貼り付け・ドロップ挿入。
- 常設toolbarを撤去し、表・画像の標準context menuとkeyboard操作へ移行。
- 同じTextDocumentを標準Text Editorで検索・置換し、Live Editorへ戻る連携。正規表現・選択範囲はVS Code標準機能を使用。
- 標準Markdown linkのhover preview、Ctrl+クリック、見出しfragment。
- 保存済み単体文書の画像・リンク対応、未保存画像の標準Save As継続、read-only / Trust / URI別の制限。
- 通常通知は4秒で自動消去。データ保護警告は維持。
- ATX見出しの構造用区切りを入力時に生成・解除し、由来を追跡。通常本文・手動空行・入力行を保持し、構造余白だけコンパクト表示。
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
