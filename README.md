# Markdown Live Editor

Markdown Live Editor は、通常の Markdown ファイル（`.md`）を編集しながら、見出しや強調などの表示をその場で確認できる VS Code 拡張です。ファイルは Markdown のまま保存され、通常のテキストエディターでも開けます。

## 主な機能

- 見出し、強調、取り消し線、インラインコード、リスト、チェックボックス、引用、単純なリンクの Live Preview
- GFM表のセル編集、行・列・配置の操作
- 画像表示、ファイル選択・画像貼り付け・ドロップによる挿入
- 一文書内の検索・置換（Ctrl+F / Ctrl+H）、正規表現・選択範囲
- Markdownリンクのhover previewとCtrl+クリック移動
- 見出し末尾のEnterによる段落挿入と、sourceを保持する空行のコンパクト表示
- 編集箇所の Markdown 記法を表示しながらの入力
- 日本語入力、保存、元に戻す・やり直す
- 見出しを一覧し、本文へ移動できる Markdown Outline
- LF / CRLF、Tab・インデント設定への対応
- VS Code のテーマに合わせた表示と Custom CSS

## 使い方

1. 拡張をインストールし、`.md` ファイルを開きます。
2. エディターのタブから **Reopen Editor With...（エディターを再度開くアプリケーションの選択）** を選び、**Markdown Live Editor** で開きます。
3. 本文を編集し、通常どおり保存します。見出しへの移動には Explorer の **Markdown Outline** を使えます。

通常のテキスト編集に戻す場合も、同じメニューからテキストエディターを選択します。検索・置換・表・画像挿入はエディター上部のツールバーからも利用できます。

## 表と画像の操作

表のセルをクリックして直接編集します。Tab / Shift+Tabでセル移動、Enter / Shift+Enterで上下のセルへ移動し、Ctrl+EnterまたはEscで表の外へ出ます。Home / Endはセル内容の先頭・末尾です。「表の操作」から行列操作・配置変更・source表示切替ができます。

画像はクリックしてalt・path・titleをMarkdownとして編集します。挿入したPNG / JPEG / GIF / WebPは、保存済み文書に隣接する`attachments`へ一意な名前でコピーします。設定`vscodeMarkdownLiveEditor.attachmentFolder`で単一フォルダー名を指定できます。挿入のUndoは添付ファイルを削除しません。画像形式のclipboardが利用できない場合は「画像を挿入」を使ってください。

ワークスペース外の参照は拒否します。外部画像は既定で無効です。信頼済みワークスペースで`vscodeMarkdownLiveEditor.allowRemoteImages`を有効にするとHTTPS画像を読み込み、画像提供元へ通信が発生します。外部リンクのhoverではページを自動取得しません。

## 表示のカスタマイズ

`vscodeMarkdownLiveEditor.customCss` 設定で CSS を追加できます。信頼済みワークスペースでは、ルートの `.vscode/markdown-live-editor.css` も使用できます。

Live Preview は Markdown の一部の記法に対応しています。対応していない記法は、そのままテキストとして編集できます。

## プライバシー

Markdown ファイルを保存形式として使用し、専用のデータベースは必要ありません。テレメトリーを収集せず、編集に外部ネットワーク API は必要ありません。

## License

[MIT](LICENSE)
