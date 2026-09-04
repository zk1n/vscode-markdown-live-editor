# ADR 0008: IME composition の永続commit境界

Status: Accepted — guarantee level B
Date: 2026-09-03
Updated: 2026-09-04

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
- compositionがactiveの状態でbarrierを要求しても、そのcompositionを完了するtransactionは
  barrier filterで拒否しない。composition完了後に開始される通常入力だけをFIFOの後ろへ止める。
- 隣接したauthoritative editのUndo groupingはVS Code host semanticsに従う。compositionごとに
  異なるUndo unitとなることはpublic APIでは保証しない。
- composition中のauthoritative external updateは、local preeditを黙って上書きせずvisible
  recoveryに入る。
- originating operationのauthoritative resultはorigin sessionへ`operation-ack`として1回返す。
  同じoperation由来の`document-update`はpeer sessionだけへbroadcastし、external changeは全sessionへ通知する。
- edit ACK前に届いた`document-update`がin-flight targetと完全一致する場合は、外部競合と即断せず
  ACK/resyncまでmetadata-onlyでdeferする。host ACKなしに成功扱いせず、本文が異なる場合は
  `reason: "edit"`でもvisible recoveryへ入る。

実装は`compositionStarted`およびinput / composition eventsで裏付けた意味的な状態だけを使う。
timeout、dummy edit、whitespace / newline、hidden editor、internal / proposed APIは使わない。

## Consequences

`TextDocument`は未確定compositionの間だけCodeMirrorより遅れ得る。これは意図した限定状態で
あり、Save / Undo / Redoは最終editのacknowledgement後に進む。

v0.1の既知制約は、ATOKを含むhostが隣接compositionのauthoritative editを同じUndo unitに
併合する可能性である。これはpreeditをローマ字単位Undoへ戻す理由にはならない。source text、
caret、focus、入力継続、Redoの正しさを優先する。

Windows ATOKの手動結果は必須であり、Microsoft IMEの結果で代替しない。
Save / Undo / Redo shortcutのsingle-owner証跡もADR 0006に従って記録する。
hostが返すUndo snapshotが複数のfinal compositionを一括で戻すことをLevel Bの
host groupingとして扱えるのは、webview keymap / barrierとhost history commandが
それぞれ一回であるtraceが得られた場合だけである。

## Implementation notes

webviewは`compositionstart`でauthoritative versionとlocal textを記録する。preedit transactionは
local bufferだけを更新する。composition開始前のordinary editをflushする必要があれば、送信targetは
captured base textとして明示的に保持し、mutableなEditorView textを再読しない。したがってpreedit
(`ABk`、`ABka`など)をpersistent authorityへ送らない。意味的な`compositionend`後、前のordinary
editがあればacknowledgeを待ち、authorityが記録したbaseと一致することを検証してから最終textだけを
既存FIFOの`edit`として送る。不一致ならlocal compositionを可視のままrecoveryへ入る。

in-flight targetと完全一致するdeferred snapshotはauthorityを変更せず、matching sequenceかつmatching textの
`operation-ack`を受けた時だけ解決する。deferred snapshotのversionがACKより新しければ、両方の最新versionを
次のpending/final editのbaseに使う。resyncはhost snapshotを優先してdeferred stateを破棄する。recovery中の
遅延ACK、snapshot、compositionendは編集送信を再開させない。

VS Code 1.135.0の実測では、port-owned `WorkspaceEdit`の`onDidChangeTextDocument`は
`applyEdit()` promise解決前に発生し、単一change、expected version + 1、全snapshot target一致、replacement一致、
EOL正規化後一致の全条件で`own`分類された。自己editが`external`へ誤分類された証拠はないため、
`VscodeDocumentPort.classifyDocumentChange()`のfail-closed条件は緩めない。Undo/Redo changeはtargetを事前検証できず
`external`のままとし、origin attributionの根拠に`historyInProgress`だけを使わない。

Save barrierはcomposition active時にqueueする。filterはその時点で既にactiveだったcompositionの
continuation/final transactionを許可し、final authoritative editのacknowledgement後にbarrierを送る。
barrier完了後は必ずfreezeを解除する。freeze中にqueue、barrier in-flight、composition completion、
または先行edit in-flightのいずれも存在しない状態はinternal invariant violationとしてvisible recoveryに
遷移し、入力だけを黙って捨てる状態を作らない。

compositionendのmicrotaskはCodeMirrorの同期処理をsettleさせる目的だけであり、Undo groupingを
変えるdelayではない。
