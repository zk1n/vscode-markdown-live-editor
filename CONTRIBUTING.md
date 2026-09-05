# Contributing

editorのデータ整合性を最優先に開発しています。
issueで再現手順・期待結果・実際の結果・利用環境を共有してください。
機密文書の本文は添付しないでください。

修正提案には次の検証結果を添えてください。

```sh
npm ci
npm run check
```

editor動作の変更にはregression testを追加し、必要な実環境テストを明示してください。
設計判断は[Architecture](docs/architecture/ARCHITECTURE.md)、
品質基準は[テスト方針](docs/development/TEST_STRATEGY.md)を参照してください。

このrepositoryは生成されたsnapshotです。提案は管理元で取り込み、公開snapshotへ反映します。
生成先での手編集は次の生成へ引き継がれません。
公開やreleaseの最終判断はmaintainerが行います。

security報告は[SECURITY.md](SECURITY.md)に従ってください。
