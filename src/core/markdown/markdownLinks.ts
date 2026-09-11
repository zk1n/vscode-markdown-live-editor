import { markdownLanguage } from "@codemirror/lang-markdown";
import { frontmatterEnd, sourceNodes } from "./markdownSource.js";

export interface MarkdownLink {
  readonly from: number;
  readonly to: number;
  readonly label: string;
  readonly target: string;
  readonly title: string | undefined;
  readonly image: boolean;
}

function unescapeMarkdown(value: string): string {
  return value
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/gu, "$1")
    .replace(
      /&(?:amp|lt|gt|quot|apos);/gu,
      (entity) =>
        ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] ??
        entity,
    )
    .replace(/&#(x[\da-f]+|\d+);/giu, (entity: string, number: string) => {
      const point = number.toLowerCase().startsWith("x")
        ? Number.parseInt(number.slice(1), 16)
        : Number(number);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    });
}
function labelKey(value: string): string {
  return unescapeMarkdown(value).trim().replace(/\s+/gu, " ").toLowerCase();
}

export function findMarkdownLinks(text: string): readonly MarkdownLink[] {
  const tree = markdownLanguage.parser.parse(text);
  const yamlEnd = frontmatterEnd(text);
  const references = new Map<string, { target: string; title: string | undefined }>();
  tree.iterate({
    enter(node) {
      if (node.name !== "LinkReference" || node.from < yamlEnd) return;
      const label = node.node.getChild("LinkLabel");
      const url = node.node.getChild("URL");
      const title = node.node.getChild("LinkTitle");
      if (label === null || url === null) return;
      const key = labelKey(text.slice(label.from + 1, label.to - 1));
      if (!references.has(key))
        references.set(key, {
          target: decodeDestination(text.slice(url.from, url.to)),
          title:
            title === null ? undefined : unescapeMarkdown(text.slice(title.from + 1, title.to - 1)),
        });
    },
  });
  const links: MarkdownLink[] = [];
  tree.iterate({
    enter(node) {
      if ((node.name !== "Link" && node.name !== "Image") || node.from < yamlEnd) return;
      const image = node.name === "Image";
      const marks = node.node.getChildren("LinkMark");
      const closeLabel = marks.find((mark) => text.slice(mark.from, mark.to) === "]");
      if (closeLabel === undefined) return;
      const label = text.slice(node.from + (image ? 2 : 1), closeLabel.from);
      const url = node.node.getChild("URL");
      const title = node.node.getChild("LinkTitle");
      const referenceLabel = node.node.getChild("LinkLabel");
      const key =
        referenceLabel === null
          ? label
          : text.slice(referenceLabel.from + 1, referenceLabel.to - 1) || label;
      const reference = references.get(labelKey(key));
      const target =
        url === null ? reference?.target : decodeDestination(text.slice(url.from, url.to));
      // Unresolved references stay raw; never invent a destination.
      if (target === undefined) return;
      links.push({
        from: node.from,
        to: node.to,
        image,
        label: unescapeMarkdown(label),
        target,
        title:
          title === null
            ? reference?.title
            : unescapeMarkdown(text.slice(title.from + 1, title.to - 1)),
      });
    },
  });
  return links;
}
function decodeDestination(value: string): string {
  return unescapeMarkdown(
    value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value,
  );
}

/** GitHub/VS Code style duplicate heading suffixes, computed from source. */
export function headingOffset(text: string, fragment: string): number | undefined {
  if (fragment === "") return 0;
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment).toLowerCase();
  } catch {
    return undefined;
  }
  const used = new Set<string>();
  for (const node of sourceNodes(text, [
    "ATXHeading1",
    "ATXHeading2",
    "ATXHeading3",
    "ATXHeading4",
    "ATXHeading5",
    "ATXHeading6",
    "SetextHeading1",
    "SetextHeading2",
  ])) {
    const literal = text.slice(node.from, node.to).split("\n")[0] ?? "";
    const label = unescapeMarkdown(
      literal.replace(/^ {0,3}#{1,6}\s*/u, "").replace(/\s+#+\s*$/u, ""),
    )
      .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/<[^>]*>/gu, "");
    const base = label
      .trim()
      .toLowerCase()
      .replace(/\p{Cc}/gu, "")
      .replace(/[!"#$%&'()*+,./:;<=>?@[\]\\^`{|}~]/gu, "")
      .replace(/\s/gu, "-");
    let slug = base;
    let duplicate = 0;
    while (used.has(slug)) {
      duplicate += 1;
      slug = `${base}-${String(duplicate)}`;
    }
    used.add(slug);
    if (slug === decoded) return node.from;
  }
  return undefined;
}
