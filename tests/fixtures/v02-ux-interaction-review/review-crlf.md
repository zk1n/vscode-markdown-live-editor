# v0.2 UX interaction review fixture

この本文は表・画像・検索の連続操作を確認するためのfixtureです。
表の前の本文にも複数の needle を置きます。ここでの needle は検索対象です。

| **名前** | 説明 | 値 | 補足 |
| :--- | :---: | ---: | --- |
| 先頭 | escaped \| pipe | 1 | [link](../v02-review/target.md#needle) |
| 中間 | `inline code` と日本語 | 2 | needle |
|  |  | 空セル |  |
| padding |   | 左右の余白 | [別link](../v02-review/target.md) |
| 末尾 | 長い文章の折り返しを確認するための日本語。ここへ続けて入力します。 | 3 | 最終セル |

表内の空セルとpaddingセルをクリックして、表示されるcaretの位置を確認します。
表の外側にある本文 needle です。表の形を保ったまま入力できることを確認します。

表外本文の先頭です。

![同一画像A](../v02-review/assets/example.png)

画像の前後へ入力する本文です。画像の読み込み中もcaretを保ちます。

![同一画像B](../v02-review/assets/example.png)

画像の後ろの本文 needle です。画像Aと画像Bは同じ相対pathを使います。

[隠れたtarget](../v02-review/target.md#needle)

表示上は短いラベルだけですが、検索ではMarkdownの隠れたtargetも対象にします。

hard breakの前の行です。  
hard breakの後の行です。

space-only行の次です。
   
space-only行の後です。

| 空 | 値 |
| --- | --- |
|  | 空セルのまま入力 |

この表の行追加・列追加後も、表外本文へ安全に移動できることを確認します。
未保存入力を含む source と disk の内容を比較します。

画面外検索 01: needle-screen を含む行です。
画面外検索 02: needle-screen を含む行です。
画面外検索 03: needle-screen を含む行です。
画面外検索 04: needle-screen を含む行です。
画面外検索 05: needle-screen を含む行です。
画面外検索 06: needle-screen を含む行です。
画面外検索 07: needle-screen を含む行です。
画面外検索 08: needle-screen を含む行です。
画面外検索 09: needle-screen を含む行です。
画面外検索 10: needle-screen を含む行です。
画面外検索 11: needle-screen を含む行です。
画面外検索 12: needle-screen を含む行です。
画面外検索 13: needle-screen を含む行です。
画面外検索 14: needle-screen を含む行です。
画面外検索 15: needle-screen を含む行です。
画面外検索 16: needle-screen を含む行です。
画面外検索 17: needle-screen を含む行です。
画面外検索 18: needle-screen を含む行です。
画面外検索 19: needle-screen を含む行です。
画面外検索 20: needle-screen を含む行です。
画面外検索 21: needle-screen を含む行です。
画面外検索 22: needle-screen を含む行です。
画面外検索 23: needle-screen を含む行です。
画面外検索 24: needle-screen を含む行です。
画面外検索 25: needle-screen を含む行です。
画面外検索 26: needle-screen を含む行です。
画面外検索 27: needle-screen を含む行です。
画面外検索 28: needle-screen を含む行です。
画面外検索 29: needle-screen を含む行です。
画面外検索 30: needle-screen を含む行です。
画面外検索 31: needle-screen を含む行です。
画面外検索 32: needle-screen を含む行です。
画面外検索 33: needle-screen を含む行です。
画面外検索 34: needle-screen を含む行です。
画面外検索 35: needle-screen を含む行です。
画面外検索 36: needle-screen を含む行です。
画面外検索 37: needle-screen を含む行です。
画面外検索 38: needle-screen を含む行です。
画面外検索 39: needle-screen を含む行です。
画面外検索 40: needle-screen を含む行です。
画面外検索 41: needle-screen を含む行です。
画面外検索 42: needle-screen を含む行です。
画面外検索 43: needle-screen を含む行です。
画面外検索 44: needle-screen を含む行です。
画面外検索 45: needle-screen を含む行です。
画面外検索 46: needle-screen を含む行です。
画面外検索 47: needle-screen を含む行です。
画面外検索 48: needle-screen を含む行です。
画面外検索 49: needle-screen を含む行です。
画面外検索 50: needle-screen を含む行です。

末尾の本文です。検索後にEscを押して、ここへ直ちに入力します。
