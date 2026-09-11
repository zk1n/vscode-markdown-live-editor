import { markdownLanguage } from "@codemirror/lang-markdown";

/** YAML is left entirely to source editing; it must not become Markdown UI. */
export function frontmatterEnd(text: string): number {
  if (!/^(?:\uFEFF)?---[ \t]*\r?\n/u.test(text)) return 0;
  const end = /^(?:---|\.\.\.)[ \t]*\r?$/gmu;
  end.lastIndex = text.indexOf("\n") + 1;
  const match = end.exec(text);
  return match === null ? text.length : match.index + match[0].length;
}

/** Uses the installed GFM parser, never rendered DOM, to locate source nodes. */
export function sourceNodes(text: string, names: readonly string[]): readonly SourceNode[] {
  const nodes: SourceNode[] = [];
  const yamlEnd = frontmatterEnd(text);
  markdownLanguage.parser.parse(text).iterate({
    enter(node) {
      if (node.from >= yamlEnd && names.includes(node.name)) {
        nodes.push({
          from: node.from,
          to: node.to,
          name: node.name,
          parent: node.node.parent?.name,
        });
      }
    },
  });
  return nodes;
}

export interface SourceNode {
  readonly from: number;
  readonly to: number;
  readonly name: string;
  readonly parent: string | undefined;
}
