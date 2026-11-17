import type { VaultGraphNode } from '../services/vault';

const WIKILINK = /\[\[([^[\]\n|#]+)(#[^[\]\n|]+)?(?:\|([^[\]\n]+))?\]\]/g;

/**
 * Pure: turn Obsidian [[Target|alias]] links into markdown links on a `wikilink:` pseudo-scheme
 * the note reader resolves to a note in the same vault (by title, like Obsidian).
 */
export function wikilinksToMarkdown(content: string): string {
  return content.replace(WIKILINK, (_m, target: string, _heading: string | undefined, alias: string | undefined) => {
    const label = (alias ?? target).trim().replace(/[[\]]/g, '');
    return `[${label}](wikilink:${encodeURIComponent(target.trim())})`;
  });
}

/** Pure: resolve a wikilink target (title, or a path without .md) to a note path in the graph. */
export function resolveWikilink(target: string, nodes: Pick<VaultGraphNode, 'id' | 'title'>[]): string | null {
  const t = target.trim().toLowerCase();
  const byPath = nodes.find((n) => n.id.toLowerCase() === `${t}.md` || n.id.toLowerCase() === t);
  if (byPath) return byPath.id;
  return nodes.find((n) => n.title.toLowerCase() === t)?.id ?? null;
}
