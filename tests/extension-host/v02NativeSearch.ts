import assert from "node:assert/strict";
import * as vscode from "vscode";

const liveType = "vscodeMarkdownLiveEditor.editor";
async function waitFor(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Native search: ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
}
function isLive(uri: vscode.Uri): boolean {
  const input: unknown = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return (
    input instanceof vscode.TabInputCustom &&
    input.viewType === liveType &&
    input.uri.toString() === uri.toString()
  );
}
async function search(args: Record<string, unknown>): Promise<void> {
  await vscode.commands.executeCommand("editor.actions.findWithArgs", {
    isRegex: false,
    isCaseSensitive: true,
    matchWholeWord: false,
    findInSelection: false,
    ...args,
  });
}
async function openNative(
  document: vscode.TextDocument,
  replace: boolean,
): Promise<vscode.TextEditor> {
  await vscode.commands.executeCommand(
    "vscode.openWith",
    document.uri,
    liveType,
    vscode.ViewColumn.One,
  );
  await waitFor(() => isLive(document.uri), "Live Editor did not open");
  // The public openWith promise precedes the webview's ready handshake.
  await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  await vscode.commands.executeCommand(`vscodeMarkdownLiveEditor.${replace ? "replace" : "find"}`);
  await waitFor(
    () => vscode.window.activeTextEditor?.document === document && !isLive(document.uri),
    "webview command did not hand off to the SAME TextDocument",
  );
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor);
  assert.equal(editor.document, document);
  assert.equal(editor.viewColumn, vscode.ViewColumn.One);
  return editor;
}

/** Runs actual VS Code Find/Replace commands against the actual shared text model. */
export async function verifyV02NativeSearch(workspace: vscode.Uri): Promise<void> {
  console.log(`V02_NATIVE_SEARCH_RUNTIME ${vscode.version}`);
  for (const eol of ["\n", "\r\n"] as const) {
    const uri = vscode.Uri.joinPath(workspace, `native-search-${String(eol.length)}.md`);
    const source = [
      "# 日本語",
      "",
      "![画像](assets/needle1.png)",
      "[リンク](target.md#needle2)",
      "needle Needle needleExtra",
      ...Array.from({ length: 250 }, (_, index) => `画面外の本文 ${String(index)}`),
      "needle3 needle4",
      "",
    ].join(eol);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source));
    const document = await vscode.workspace.openTextDocument(uri);
    try {
      let editor = await openNative(document, true);
      assert.equal(document.isDirty, false);
      await search({ searchString: "needle\\d", isRegex: true });
      await vscode.commands.executeCommand("editor.action.selectAllMatches");
      assert.equal(
        editor.selections.length,
        4,
        "regex must reach URLs, image source and offscreen text",
      );
      assert.ok(editor.selections.some((selection) => selection.start.line > 200));
      await search({ searchString: "needle", matchWholeWord: true });
      await vscode.commands.executeCommand("editor.action.selectAllMatches");
      assert.equal(editor.selections.length, 1, "whole-word case-sensitive match count");
      await search({ searchString: "needle", matchWholeWord: true, isCaseSensitive: false });
      await vscode.commands.executeCommand("editor.action.selectAllMatches");
      assert.equal(editor.selections.length, 2, "case-insensitive match count");
      await search({ searchString: "needle\\d", isRegex: true });
      await vscode.commands.executeCommand("editor.action.nextMatchFindAction");
      const first = editor.selection;
      await vscode.commands.executeCommand("editor.action.nextMatchFindAction");
      assert.equal(editor.selection.isEqual(first), false);
      await vscode.commands.executeCommand("editor.action.previousMatchFindAction");
      assert.equal(editor.selection.isEqual(first), true);
      await search({ searchString: "needle1", replaceString: "replaced1" });
      await vscode.commands.executeCommand("editor.action.nextMatchFindAction");
      assert.equal(
        document.getText(editor.selection),
        "needle1",
        "single replace must target the current native match",
      );
      await vscode.commands.executeCommand("editor.action.replaceOne");
      await waitFor(
        () => document.getText().includes("replaced1"),
        "single replacement did not modify authoritative model",
      );
      assert.equal(document.isDirty, true);
      await vscode.commands.executeCommand("closeFindWidget");
      await document.save();
      assert.equal(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)),
        source.replace("needle1", "replaced1"),
      );
      await vscode.commands.executeCommand("undo");
      await waitFor(() => document.getText() === source, "native Undo did not restore source");
      await vscode.commands.executeCommand("redo");
      await waitFor(
        () => document.getText().includes("replaced1"),
        "native Redo did not restore replacement",
      );
      await search({ searchString: "needle\\d", replaceString: "changed", isRegex: true });
      await vscode.commands.executeCommand("editor.action.replaceAll");
      await waitFor(
        () => !/needle\d/u.test(document.getText()),
        "native Replace All did not cover source",
      );
      assert.equal(document.eol, eol === "\n" ? vscode.EndOfLine.LF : vscode.EndOfLine.CRLF);
      await vscode.commands.executeCommand("closeFindWidget");
      editor.selection = new vscode.Selection(4, 0, 4, 6);
      await search({ searchString: "needle", replaceString: "selected", findInSelection: true });
      await vscode.commands.executeCommand("editor.action.replaceAll");
      await waitFor(
        () => document.lineAt(4).text.startsWith("selected"),
        "selection-scoped replacement did not execute",
      );
      assert.ok(
        document.lineAt(4).text.endsWith("needleExtra"),
        "selection replacement escaped its range",
      );
      const beforeReturn = document.getText();
      await vscode.commands.executeCommand("vscodeMarkdownLiveEditor.returnToLive");
      await waitFor(() => isLive(uri), "return command did not reveal Live Editor");
      for (let repeat = 0; repeat < 2; repeat += 1) {
        editor = await openNative(document, repeat === 0);
        assert.equal(editor.document.getText(), beforeReturn, "return/reopen changed dirty source");
        await vscode.commands.executeCommand("vscodeMarkdownLiveEditor.returnToLive");
        await waitFor(() => isLive(uri), "repeat return failed");
      }
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
          (tab) =>
            (tab.input instanceof vscode.TabInputText ||
              tab.input instanceof vscode.TabInputCustom) &&
            tab.input.uri.toString() === uri.toString(),
        );
      assert.ok(tabs.length <= 2, `tab count grew to ${String(tabs.length)}`);
      await document.save();
      console.log(
        `V02_NATIVE_SEARCH_PASS ${eol.length === 1 ? "LF" : "CRLF"} full-source/regex/case/word/next/previous/one/all/selection/Save/Undo/Redo/return/tabs`,
      );
    } finally {
      if (!document.isClosed && document.isDirty) await document.save();
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
          (tab) =>
            (tab.input instanceof vscode.TabInputText ||
              tab.input instanceof vscode.TabInputCustom) &&
            tab.input.uri.toString() === uri.toString(),
        );
      await vscode.window.tabGroups.close(tabs);
      await vscode.workspace.fs.delete(uri);
    }
  }
  const untitled = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: "未保存 needle",
  });
  const editor = await openNative(untitled, false);
  await search({ searchString: "needle", replaceString: "changed" });
  await vscode.commands.executeCommand("editor.action.replaceAll");
  await waitFor(
    () => editor.document.getText() === "未保存 changed",
    "untitled native replacement failed",
  );
  assert.equal(editor.document, untitled);
  assert.equal(untitled.isUntitled, true);
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  console.log("V02_NATIVE_SEARCH_PASS untitled dirty same-model");
}
