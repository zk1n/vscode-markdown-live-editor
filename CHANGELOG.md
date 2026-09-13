# Changelog

## 0.2.0 UX fourth review — 2026-09-14

- フローティング検索をシェブロンとテーマ色で整理し、本文の選択と検索一致を分離。表示文字のMarkdown装飾を保ち、隠れた記号・URLだけを必要に応じて表示する。
- コンパクトな構造空行へ通常caretを止めず、見えている編集位置へ移す。source、範囲選択、compositionを維持する。
- 表の左右移動と折り返し内の上下移動、同列セルへの移動に対応。表の下と右の帯全体から行・列を追加して直ちに入力できる。
- Ctrl+ClickはVS Codeの既定editorを尊重。別文書のLive Editorも準備完了後に見出しへ移動する。
- `editor.minimap.enabled` に従う表示専用ミニマップを追加。文書概要、表示範囲、検索・選択位置、クリックとドラッグのscrollに対応。
- Humanレビュー用候補。正式release、実OSのIME／操作感の受入は未実施。

## 0.2.0 UX interaction review — 2026-09-13

- 表を表示したままセルを編集。Tab／Shift+Tab、最終セルのTab行追加、右端／下側の＋から入力を継続できる。
- Ctrl+F／Hで右上に小さな検索・置換窓を開く。Markdown全文、case／word／regex／選択範囲、単一／全置換と既存Undo／Redoに対応。Escで本文入力へ戻る。
- 画像貼り付け後に本文入力行を確保し、非同期処理中に移ったUIからfocusを奪わない。許可root内画像の重複grantによるWebview再生成を抑止。
- 旧R2の独自UI採用判断待ちは解消。正式releaseとHuman IME／操作感の受入は未実施。

## 0.2.0 UX stability review — 2026-09-13

- 表の行・列追加直後に新しいセルへcaretとfocusを移し、パイプの直接編集は対象行のsource表示を維持。
- 画像のcontroller起動前要求を待機し、無関係な入力では読み込み済みDOMを再利用。実資源変更と旧sessionの寿命を分離。
- 常設の画像Markdown編集リンクを撤去。キーボード・画像クリック・context menuからのsource編集を維持。
- Live内の標準全文検索・置換は公開APIの判断待ち。既存Text Editor bridgeを暫定保持。

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
