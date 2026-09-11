# v0.2 初回レビュー

同じ文書で表・画像・検索・リンク・空行を確認します。needle NEEDLE needlework 日本語 😀 é

## 見出しEnterの確認

この見出しの末尾でEnterを押し、新しい段落へ「本文」と入力してください。

| **名前** | 説明 | 個数 |
| :--- | :---: | ---: |
| 日本語 | needle と **強調** | 1 |
| 空セル |  | 2 |
| escaped pipe | a \| b と `code` | 3 |
| link | [リンク先](target.md#日本語の見出し) | 4 |
| 長いセル | 長い説明文を繰り返して折り返しと横スクロールを確認します。長い説明文を繰り返して確認します。 | 5 |

表の後の本文 needle。

![相対画像](assets/example.png "合成した確認画像")

![存在しない画像](assets/missing.png)

[別文書](target.md#日本語の見出し) / [同じ文書](#検索の確認) / [参照リンク][target]

[target]: target.md#日本語の見出し "参照形式"

[外部URL](https://example.com) / [拒否するURI](command:workbench.action.openSettings)

## 検索の確認

needle needle NEEDLE needlework
画像パス assets/example.png や表の区切り | もsource検索に含まれます。

## 意図した複数空行



この前の複数空行はコンパクト化しません。

space-only行は、この文の前に半角スペースだけの行を追加して確認します。

```markdown
# コード内の見出し

この空行と見出しは入力補助・コンパクト表示の対象外です。
```

| 未完成の表 | 列 |
| --- |
| sourceのまま修復できます | needle |

## 最後の見出し