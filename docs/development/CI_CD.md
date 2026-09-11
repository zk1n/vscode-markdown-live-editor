# CI / CD

## 検証パイプライン

Development repository は Forgejo とする。Forgejo Actions は `.github/workflows/ci.yml` を共通workflow正本として読み込み、branch push、Pull Request、`v*` tag、`workflow_dispatch` に対して `npm ci` と正式 gate の `npm run check` を実行する。Forgejo固有workflow directoryは追加せず、GitHub / Forgejoで同じ定義を検証する。`package-vsix` は手動実行または `v*` tag で起動し、生成した VSIX artifact を 30 日間保存する。

公開 GitHub repository は `develop` / `main` への push と、それらを対象にした Pull Request で同じ `npm ci` と `npm run check` を実行する。VSIX job は `v*` tag または明示的な `workflow_dispatch` でだけ起動し、build artifact を upload する。workflow permission は `contents: read` のみであり、checkout credential は保持しない。

どちらの pipeline も Visual Studio Marketplace への publish、GitHub / Forgejo release の作成、tag / branch の push、publish credential の読取りを行わない。publish と release acceptance は Human Gate のままとする。

GitHub Dependabot PRはCI evidenceを提供するinboxであり、Development sourceへ直接mergeしない。採用品はForgejo / Developmentの
最新`develop`から独立branchで再実装し、同じlocal gateとForgejo Actions workflowを通す。Development統合後に通常のpublic projectionで
GitHub `develop`を更新し、同等以上のversionを確認してから元PRをcloseする。詳細は
[`DEPENDENCY_POLICY.md`](DEPENDENCY_POLICY.md)と[`DEPENDABOT_INTAKE.md`](DEPENDABOT_INTAKE.md)を参照する。

## 再現可能な VSIX artifact

`@vscode/vsce` は `package-lock.json` に固定された development dependency である。ローカルで release artifact を作る手順は次のとおり。

```powershell
npm ci
npm run check
npm run package:vsix
```

artifact の出力先は `artifacts/vscode-markdown-live-editor-<package-version>.vsix` である。

`package.json` は明示的な `files` allowlist を使う。package script は最小 staging directory を作成し、Development では `docs/public/README.md` を優先し、単独の公開 checkout では repository README を package README として使う。その後 `vsce package` が生成した ZIP central directory を検証する。許可するのは extension manifest、package metadata、curated README、changelog、license、2 本の runtime bundle、英語・日本語の extension localization bundle のみである。欠落または未許可 entry は失敗とし、内部設定、worklog、source、test、local configuration、開発文書が VSIX に入ることを防ぐ。

この artifact は installable VSIX だけであり、Marketplace publisher の設定や publish 権限を与えない。
