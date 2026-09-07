# ADR 0012: M10 presentation、Status Bar、Custom CSS boundary

状態: Accepted（実装・自動検証済み、Human Gate pending）
日付: 2026-09-06

## Context

Custom EditorにもTab編集、VS Code Status Bar、EOL操作、blurred Undo / Redo後のfocus / caret復帰、theme追従、
optional Custom CSSが必要である。一方でordinary `.md`、VS Code `TextDocument`、host-owned Undo / Redo、canonical-LF protocol、
Save / recovery / compositionのauthorityとorderingをpresentation機能へ移してはならない。

## Decision

- Webviewはeffective `editor.insertSpaces` / `editor.tabSize` / `editor.indentSize`をtyped presentation messageで受け取る。Tab / Shift+Tabは
  CodeMirror source transactionとして実行するが、composition、recovery、barrier中は内容を変更せずfocus traversalだけを防ぐ。
- Webviewはcontroller/session/document version付きのselection、Ln / Col、indentation状態を報告する。Extensionはactive
  `TabInputCustom`、panel session、controller generation、open `TextDocument.version`を一致させた場合だけnative Status Barへ表示する。
  split、通常editor切替、controller replacement、close / dispose時にstale表示・操作を残さない。
- EOL変更は同じdocument FIFOへ`set-eol` operationとして投入し、VS Code public `WorkspaceEdit`と
  `TextEdit.setEndOfLine`だけを使う。canonical本文が変わらないことをport前後で確認し、Save後disk EOLはadapter境界で検証する。
- Encodingはeffective `files.encoding`を表示する。Custom Editorから対象documentを明確に指定できる安全なpublic変更経路がないため、
  encoding変更や独自transcoderは実装しない。
- shortcut / menuからのhost commandは、host-owned Undo / Redo ACKの後だけcontroller/session/request/document versionを照合して
  focusを戻す。Webviewは結果を先読みせず、authoritative snapshotに対する最小replacementのselection mappingを使う。
- Style FoundationはVS Code theme token中心のCodeMirror decoration / themeとする。theme切替とstyle snapshotはdocument transaction、
  reparse、selection / focus reset、sync、Save、Undo entryを生成しない。Native Markdown OutlineはVS Code Tree Viewのまま対象外とする。
  `markdown.preview.fontFamily` / `fontSize` / `lineHeight`も検証済みpresentation snapshotで伝播し、CSS適用後にmeasureを要求する。
- Custom CSSはUser Settingsのliteral CSSと、trusted owning workspaceの固定`.vscode/markdown-live-editor.css`だけを許す。
  multi-rootではactive documentのowning folderだけを参照する。64 KiB/source・128 KiB combined、fatal UTF-8、NUL、CSS escape、
  `@import`、`url()`、resource scheme、不均衡structureを拒否し、検証済みsnapshotだけをdedicated `<style>`へ原子的に置換する。
- watcher / async readはsession epochを持ち、create/change/delete、workspace folder / trust change、controller / Webview disposeでstale結果を拒否する。
  missing / invalid / read errorは編集を止めず、有効な残存sourceまたはbase Styleへfallbackする。

## Consequences

- Status Barとpresentationは可視性を高めるが、document authorityではない。state reportが`TextDocument.version`へ追いつくまでstatusをhideする。
- 2026-09-07の修正ではindentation変更をopen `TextDocument`単位の一時editing configurationとして保持する。
  同じdocumentの全live panelへcontroller identity付きで再送し、subscriptionはsession dispose時に解除する。
  Spaces / Tabs選択はindent sizeとtab sizeを更新し、tab display size変更はindent sizeを保持する。workspace/user settingsを暗黙に書き換えない。
- safe public routeがないencoding変更は通常Text Editorの既存操作へ委ねる。表示値はactual disk bytesの推測ではない。
- CSS escapeを含む合法な装飾など、安全側の制限で利用できないCSSがある。v0.1はresource-loading tokenの完全parserを所有しない。
- 自動回帰はsource / message非生成、identity/version rejection、watcher lifecycle、EOL Undo / Redo / Saveを検証する。
  light / dark / high contrast、focus / caret、ATOK、trust / reloadは実VS Code Human Gateに残る。
