import { findAtxHeadings } from "../markdown/atxHeadings.js";

export interface OutlineHeading {
  readonly level: number;
  readonly label: string;
  /** Inclusive canonical-LF source offset of the complete heading line. */
  readonly from: number;
  /** Exclusive canonical-LF source offset of the complete heading line. */
  readonly to: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  /** Natural editing destination immediately after the ATX marker and spacing. */
  readonly navigationOffset: number;
}

export interface OutlineNode extends OutlineHeading {
  /** Stable while this structural path and same-sibling occurrence remain stable. */
  readonly identity: string;
  readonly children: readonly OutlineNode[];
}

/** Derives Outline entries from Markdown source, never from rendered DOM. */
export function extractOutlineHeadings(text: string): readonly OutlineHeading[] {
  return findAtxHeadings(text).map((heading): OutlineHeading => ({
    level: heading.level,
    label: outlineLabel(text.slice(heading.contentFrom, heading.contentTo)),
    from: heading.from,
    to: heading.to,
    contentFrom: heading.contentFrom,
    contentTo: heading.contentTo,
    navigationOffset: heading.contentFrom,
  }));
}

/**
 * Creates a forgiving heading tree. A skipped level attaches to the nearest
 * preceding lower-level heading, while a later lower level closes prior nodes.
 */
export function buildOutlineTree(headings: readonly OutlineHeading[]): readonly OutlineNode[] {
  const roots: MutableOutlineNode[] = [];
  const ancestors: MutableOutlineNode[] = [];
  const siblingOccurrences = new Map<string, number>();

  for (const heading of headings) {
    let parent = ancestors.at(-1);
    while (parent !== undefined && parent.level >= heading.level) {
      ancestors.pop();
      parent = ancestors.at(-1);
    }
    const parentIdentity = parent?.identity ?? "root";
    const identityBase = `${parentIdentity}/${String(heading.level)}:${encodeURIComponent(heading.label)}`;
    const occurrence = (siblingOccurrences.get(identityBase) ?? 0) + 1;
    siblingOccurrences.set(identityBase, occurrence);
    const node: MutableOutlineNode = {
      ...heading,
      identity: `${identityBase}#${String(occurrence)}`,
      children: [],
    };
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
    ancestors.push(node);
  }

  return roots;
}

interface MutableOutlineNode extends OutlineHeading {
  readonly identity: string;
  readonly children: MutableOutlineNode[];
}

function outlineLabel(source: string): string {
  return source.replace(/[ \t]+#+[ \t]*$/, "").trim();
}
