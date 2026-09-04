/**
 * A language-specific explicit setting takes precedence over this extension's
 * Markdown default.  Only an effective true value is unsafe for a custom
 * editor whose caret is not visible to VS Code's trailing-whitespace saver.
 */
export function shouldWarnForMarkdownTrailingWhitespace(
  effectiveTrimTrailingWhitespace: boolean | undefined,
): boolean {
  return effectiveTrimTrailingWhitespace === true;
}
