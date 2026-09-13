# v0.2 UX 第四レビュー fixture

この文書は Live Editor の選択、検索、構造空行、表、リンク、ミニマップを確認するための 改行形式別fixtureです。

## 操作開始

asdf as-dfg needle alpha

**太字の asdf と needle**、`inline code`、[隠れた target](日本語%20target.md#見出し-日本語) を含みます。

通常の空行の次は編集可能です。


ここは複数の空行の後です。
   
この行の直前には space-only 行があります。  
この行は Markdown hard break の直後です。

## 見出し 日本語

日本語の見出しへの同一文書リンク: [ここ](#見出し-日本語)

### 文字列検索

asdf
as-dfg
needle
needle-screen
needle-screen-2

本文の長い段落です。検索が source 記号を不要に露出せず、選択色が本文と表で一貫することを確認します。本文の折り返し設定は既存のままとし、表セル内の折り返しとミニマップの高さ対応を確認します。

## 表とセル移動

| 名前 | 短い値 | 長い値 | 空セル | escaped pipe |
| --- | :---: | --- | --- | --- |
| alpha | asdf | このセルは折り返しを確認するために十分に長い日本語テキストを含み、狭い幅では複数行になります。 |  | `a\|b` |
| beta | needle | [リンク](日本語%20target.md#見出し-日本語) |   | `code \| value` |
| gamma | as-dfg | 太字 **needle** と通常テキストを混在させます。 | | escaped \| pipe |
| delta | | 長いセルの二行目を source に入れず、表示上の折り返しだけを確認します。 | | [text target](日本語%20target.txt) |

表の後の通常本文です。表の最終セルから Tab で行を追加し、右端と下端の追加領域、Undo/Redo、本文への脱出を確認します。

## 画像と表示高さ

![例の画像](../v02-review/assets/example.png)

画像の前後で入力しても caret が見え、画像 load 後もミニマップの位置対応が更新されることを確認します。

## セクション 001

001: asdf needle 日本語の本文。表示専用のミニマップに要約ブロックが出ます。
002: as-dfg needle-screen 長い本文を折り返して検索一致の位置を確認します。
003: 通常の本文です。リンク preview は [対象](日本語%20target.md#見出し-日本語) のままです。
004: Ctrl+Click は既定 editor を選び、OS の関連付けアプリを開きません。
005: 既存 tab がある対象へ移動しても、別文書へ位置通知を配達しません。
006: この段落は表より上の検索一致です。needle
007: この段落は表より下の検索一致です。needle
008: ひらがな、カタカナ、漢字、space path を含む相対パスを確認します。
009: 選択を解除してから矢印移動し、構造空行へ caret が停止しないことを確認します。
010: 本文編集は source of truth を変更する唯一の経路です。

## セクション 002

011: asdf needle alpha beta gamma delta epsilon zeta eta theta.
012: as-dfg needle-screen この文章はミニマップの中部を確認するための本文です。
013: [日本語 target](日本語%20target.md#見出し-日本語) を Ctrl+Click します。
014: [text target](日本語%20target.txt) を Ctrl+Click します。
015: 見出しへの移動後、現在の editor 種別と位置を確認します。
016: 検索 query を asdf から as-dfg に変え、古い強調が消えることを確認します。
017: 検索 query を空にして、一致印が消えることを確認します。
018: 不正 regex は error 表示になり、本文 selection を誤って変えません。
019: 通常空行は編集できます。

020: 二つ目の通常空行も編集できます。
021: hard break の確認行です。  
022: hard break の次の行です。
023: source の pipe は表以外では \| のままです。
024: Markdown **strong** と *emphasis* を含みます。
025: `inline code` は source reveal の対象です。
026: [別の見出し](#セクション-003) へ移動します。
027: この行は selection 用の短文です。
028: この行は minimap の選択印用の短文です。
029: この行は viewport の drag 用の短文です。
030: この行は click 用の短文です。

## セクション 003

031: asdf needle 日本語本文。
032: as-dfg needle-screen 長い本文。
033: 短い行。
034: 長い行。表示幅を狭くして、この文書全体の高さとミニマップの対応を確認します。画像、表、見出し、折り返しが同じ単純な行数比率ではないことを確認します。
035: 短い行。
036: 短い行。
037: 短い行。
038: 短い行。
039: 短い行。
040: 短い行。

## セクション 004

041: asdf needle。
042: as-dfg needle-screen。
043: 本文。
044: 本文。
045: 本文。
046: 本文。
047: 本文。
048: 本文。
049: 本文。
050: 本文。

## セクション 005

051: asdf needle。
052: as-dfg needle-screen。
053: 本文。
054: 本文。
055: 本文。
056: 本文。
057: 本文。
058: 本文。
059: 本文。
060: 本文。

## セクション 006

061: asdf needle。
062: as-dfg needle-screen。
063: 本文。
064: 本文。
065: 本文。
066: 本文。
067: 本文。
068: 本文。
069: 本文。
070: 本文。

## セクション 007

071: asdf needle。
072: as-dfg needle-screen。
073: 本文。
074: 本文。
075: 本文。
076: 本文。
077: 本文。
078: 本文。
079: 本文。
080: 本文。

## セクション 008

081: asdf needle。
082: as-dfg needle-screen。
083: 本文。
084: 本文。
085: 本文。
086: 本文。
087: 本文。
088: 本文。
089: 本文。
090: 本文。

## セクション 009

091: asdf needle。
092: as-dfg needle-screen。
093: 本文。
094: 本文。
095: 本文。
096: 本文。
097: 本文。
098: 本文。
099: 本文。
100: 本文。

## セクション 010

101: asdf needle。
102: as-dfg needle-screen。
103: 本文。
104: 本文。
105: 本文。
106: 本文。
107: 本文。
108: 本文。
109: 本文。
110: 本文。

## セクション 011

111: asdf needle。
112: as-dfg needle-screen。
113: 本文。
114: 本文。
115: 本文。
116: 本文。
117: 本文。
118: 本文。
119: 本文。
120: 本文。

## セクション 012

121: asdf needle。
122: as-dfg needle-screen。
123: 本文。
124: 本文。
125: 本文。
126: 本文。
127: 本文。
128: 本文。
129: 本文。
130: 本文。

## セクション 013

131: asdf needle。
132: as-dfg needle-screen。
133: 本文。
134: 本文。
135: 本文。
136: 本文。
137: 本文。
138: 本文。
139: 本文。
140: 本文。

## セクション 014

141: asdf needle。
142: as-dfg needle-screen。
143: 本文。
144: 本文。
145: 本文。
146: 本文。
147: 本文。
148: 本文。
149: 本文。
150: 本文。

## セクション 015

151: asdf needle。
152: as-dfg needle-screen。
153: 本文。
154: 本文。
155: 本文。
156: 本文。
157: 本文。
158: 本文。
159: 本文。
160: 本文。

## セクション 016

161: asdf needle。
162: as-dfg needle-screen。
163: 本文。
164: 本文。
165: 本文。
166: 本文。
167: 本文。
168: 本文。
169: 本文。
170: 本文。

## セクション 017

171: asdf needle。
172: as-dfg needle-screen。
173: 本文。
174: 本文。
175: 本文。
176: 本文。
177: 本文。
178: 本文。
179: 本文。
180: 本文。

## 終端

181: 文書下部の click と drag を確認します。
182: asdf needle は下部の検索一致です。
183: as-dfg needle-screen は下部の検索一致です。
184: [日本語 Markdown](日本語%20target.md#見出し-日本語)
185: [日本語 Text](日本語%20target.txt)
186: Save、Undo、Redo は source を保ちます。
187: ミニマップは Canvas の表示専用概要です。
188: `editor.minimap.enabled` を false にすると非表示です。
189: その他の VS Code minimap 設定は未対応です。
190: Human 操作結果は自動試験と分けて記録します。
