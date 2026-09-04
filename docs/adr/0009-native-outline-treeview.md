# ADR 0009: Native Markdown Outline Tree View

状態: Accepted（実装済み、focused Human Gate A-D PASS）
日付: 2026-09-04

## Context

v0.1 に見出し階層と見出しへの移動を加える。Markdown の唯一の authority は VS Code `TextDocument` であり、
Live Preview の rendered DOM、Webview の一時 state、Outline の表示 state を新しい source authority にしてはならない。
複数 custom editor、document change、IME composition、未ACK edit、Save/Undo/Redo barrier、recovery 中に古い outline item を
クリックしても、文字列、Undo history、同期順序を壊さない必要がある。

## Decision

- Explorer に VS Code native Tree View `Markdown Outline` を寄与する。Webview 内の Outline panel や custom CSS tree は作らない。
- `MarkdownOutlineTreeProvider` は last-active `MarkdownEditorSessionRegistry` session の authoritative open `TextDocument` だけから、
  LF に正規化した本文を pure heading parser へ渡し、H1–H6 tree を構築する。rendered DOM は入力にしない。
- session registry はWebviewの `editor-ready` handshake後だけpanelを登録し、active 化、disposeを通知する。providerはlast-active
  sessionの切替、close、そのdocument changeでsnapshotを更新し、Side Barへfocusが移っても直前のLive Editorを保持する。
- providerはheading label / level / hierarchyが不変のdocument updateではsnapshot内のitem object、version、source rangeだけを
  更新し、`onDidChangeTreeData`を発火しない。Outline表示が変わる場合だけroot refreshを1回発火し、identity完全一致または
  同一parent内の明確なrename対応でmatched opaque item IDを再利用する。item IDはnavigation identityから分離して一意に発行し、
  rename後に旧labelを再追加しても衝突させない。曖昧な構造変更では誤ったstate移植を推測しない。
- childなしからchildありへ遷移したheadingは、visible Tree Viewに対してselection/focusなしのbounded `reveal(..., { expand: true })`
  を要求する。手動collapseはTree View eventで識別し、そのitemおよびcollapsed ancestorを自動展開しない。通常refreshのたびに
  全itemを強制展開するstate ownerにはならない。native refresh settling中に最初の`reveal`がrejectした場合は、次のuser editを
  待たず次taskで1回だけ自動再試行する。なおpending requestはdocument / visibility / expand eventでも再評価し、dispose後は再試行しない。
- Tree item は document URI、document version、heading identity/range を保持する。navigation 前に host と Webview の双方で
  session、URI、version、range を再照合する。
- 一致時だけ Webview は caret/focus/scroll と約800 msの行 highlight を presentation effect として適用する。source text、
  Save、Undo/Redo、host sync、composition state を変更しない。
- stale version、session mismatch、recovery、composition、pending local edit、barrier、authority mismatch、不正位置は
  navigation を no-op とする。host は必要に応じて tree snapshot を refresh し、Webview は diagnostic metadata のみ記録する。

## Consequences

- Tree の表示と操作は VS Code theme/accessibility/keyboard semantics に従う。extension の custom CSS は native tree を上書きしない。
- ViewはExplorerへのcontributionを維持し、既定container外へ移動した場合だけmanifestの`contextualTitle: "Outline"`を使う。
  独自View Containerは追加しない。
- Outline は開いている custom editor session がないと空であり、workspace 全体 index ではない。workspace-wide outline/search は別 slice の責務である。
- navigation は見出し本文の編集ではないため、physical Save/Undo/Redo shortcut を増やさず、IME preedit を host へ送らない。
- stale item の無操作は古い offset への移動より安全だが、ユーザーは最新 tree の再表示後に再クリックする必要がある。

## Status and validation boundary

自動検証は heading extraction/tree、session registry、TreeDataProvider、package contribution、protocol/Webview navigation guardを対象とする。
2026-09-04の実 VS Code follow-upで、flicker、initial expansion / manual collapse、moved-view title、quick regressionを
**Gate A-D: HUMAN PASS**と確認した。この結果はOutlineのfocused acceptanceであり、full Manual Matrix、IME、Save、
external updateのrelease acceptanceには拡張しない。
