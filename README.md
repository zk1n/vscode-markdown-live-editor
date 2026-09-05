# Markdown Live Editor

通常のMarkdownファイルを編集する、VS Code用Live Preview Editorです。
Markdownを唯一の保存形式とし、VS CodeのTextDocumentが文書を管理します。

開発中のcandidateです。releaseの受入完了を示すものではありません。
日本語IMEや実キーボードの動作は、自動テストとは別に実環境で検証します。

## 開発

Node.js 24とnpmを使用します。

```sh
npm ci
npm run check
npm run test:extension-host
```

VS Codeでこのdirectoryを開き、F5でExtension Development Hostを起動できます。
Markdownを開き、`Reopen Editor With...`からMarkdown Live Editorを選択します。

## 設計

- 通常のMarkdownをそのまま保存します。
- CodeMirror 6とproject-owned Live Previewを使用します。
- Save / Undo / Redoと日本語IMEのデータ整合性を優先します。
- telemetryと必須network APIはありません。

詳細は[製品仕様](docs/PRODUCT_SPEC.md)、[Architecture](docs/architecture/ARCHITECTURE.md)、
[テスト方針](docs/development/TEST_STRATEGY.md)を参照してください。
参加方法は[CONTRIBUTING.md](CONTRIBUTING.md)、security報告は[SECURITY.md](SECURITY.md)に記載します。

## 公開履歴

このrepositoryは、選択した公開資産のsnapshotを積み重ねています。
開発履歴全体や元のcommit metadataは収録していません。
commitの日付は再現性のための固定値で、開発日時やrelease日時を表しません。
修正提案はissueまたはpatchで受け付け、管理元で反映した成果を再生成します。

## License

[MIT](LICENSE)
