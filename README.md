# Markdown Live Editor

Markdown Live Editor は、通常の Markdown ファイル（`.md`）を編集しながら、見出しや強調などの表示をその場で確認できる VS Code 拡張です。ファイルは Markdown のまま保存され、通常のテキストエディターでも開けます。

## 主な機能

- 見出し、強調、取り消し線、インラインコード、リスト、チェックボックス、引用、単純なリンクの Live Preview
- 編集箇所の Markdown 記法を表示しながらの入力
- 日本語入力、保存、元に戻す・やり直す
- 見出しを一覧し、本文へ移動できる Markdown Outline
- LF / CRLF、Tab・インデント設定への対応
- VS Code のテーマに合わせた表示と Custom CSS

## 使い方

1. 拡張をインストールし、`.md` ファイルを開きます。
2. エディターのタブから **Reopen Editor With...（エディターを再度開くアプリケーションの選択）** を選び、**Markdown Live Editor** で開きます。
3. 本文を編集し、通常どおり保存します。見出しへの移動には Explorer の **Markdown Outline** を使えます。

通常のテキスト編集に戻す場合も、同じメニューからテキストエディターを選択します。ファイル内の検索には通常のテキストエディターを利用してください。

## 表示のカスタマイズ

`vscodeMarkdownLiveEditor.customCss` 設定で CSS を追加できます。信頼済みワークスペースでは、ルートの `.vscode/markdown-live-editor.css` も使用できます。

Live Preview は Markdown の一部の記法に対応しています。対応していない記法は、そのままテキストとして編集できます。

## プライバシー

Markdown ファイルを保存形式として使用し、専用のデータベースは必要ありません。テレメトリーを収集せず、編集に外部ネットワーク API は必要ありません。

## License

[MIT](LICENSE)
