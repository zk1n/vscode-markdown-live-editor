# ADR 0008: IME composition の永続commit境界

Status: Accepted — guarantee level B
Date: 2026-09-03

## Context

ADR 0002 / ADR 0006 は VS Code `TextDocument` を永続authorityとする。ATOKでは
ローマ字・preeditの内部更新が多数発生し得るため、これを個別の`WorkspaceEdit`として
渡すと、ユーザーに見えない状態がUndo historyへ露出する。

`WorkspaceEdit`には公開されたundo-group ID / undo-stop指定がない。公開APIの
`TextEditor.edit(..., { undoStopBefore, undoStopAfter })`は存在するが、Custom Editor
のみを開いた実Extension Hostでは対象documentのvisible `TextEditor`が存在しなかった。
これを使うには通常Text Editorの表示・active editor依存・split editorへの依存、または
hidden editorが必要となり、本製品の安全境界に反する。

実Extension Hostのprobeでは、初期`X`に対する`WorkspaceEdit A: XA`、続く
`WorkspaceEdit B: XAB`は、連続実行、Aの`TextDocument` change event確認後、microtask
境界後のいずれでも、1回のUndoで`XA`、Redoで`XAB`となった。同じ順序をcoordinator経由の
composition相当commit 2回にも適用すると同じ結果だった（VS Code 1.120.0 / 1.135.0）。
ただしこれは実測であり、公開API契約としてcomposition間のUndo stopを保証するものではない。
実機ATOKでは隣接compositionが1単位に併合される観測もある。

## Decision

保証は次のLevel Bとする。

- IME preedit内部の更新はpersistent Undo historyへ露出しない。
- composition完了時に、最後にacknowledgeされたauthorityから最終CodeMirror textへの
  正確なauthoritative editを1回だけ発行する。
- composition中のSave / Undo / RedoはFIFO barrierに残し、content DOMの再構成、強制commit、
  focus移動を行わない。
- 隣接したauthoritative editのUndo groupingはVS Code host semanticsに従う。compositionごとに
  異なるUndo unitとなることはpublic APIでは保証しない。
- composition中のauthoritative external updateは、local preeditを黙って上書きせずvisible
  recoveryに入る。

実装は`compositionStarted`およびinput / composition eventsで裏付けた意味的な状態だけを使う。
timeout、dummy edit、whitespace / newline、hidden editor、internal / proposed APIは使わない。

## Consequences

`TextDocument`は未確定compositionの間だけCodeMirrorより遅れ得る。これは意図した限定状態で
あり、Save / Undo / Redoは最終editのacknowledgement後に進む。

v0.1の既知制約は、ATOKを含むhostが隣接compositionのauthoritative editを同じUndo unitに
併合する可能性である。これはpreeditをローマ字単位Undoへ戻す理由にはならない。source text、
caret、focus、入力継続、Redoの正しさを優先する。

Windows ATOKの手動結果は必須であり、Microsoft IMEの結果で代替しない。

## Implementation notes

webviewは`compositionstart`でauthoritative versionとlocal textを記録する。preedit transactionは
local bufferだけを更新する。意味的な`compositionend`後、前のordinary editがあればacknowledgeを
待ち、authorityが記録したbaseと一致することを検証してから既存FIFOの`edit`を送る。不一致なら
local compositionを可視のままrecoveryへ入る。

compositionendのmicrotaskはCodeMirrorの同期処理をsettleさせる目的だけであり、Undo groupingを
変えるdelayではない。
