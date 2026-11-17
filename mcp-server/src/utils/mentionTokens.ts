/**
 * Pure parser/serializer for @entity mention tokens.
 *
 * Token format: `@[Display Name](type:id)`
 *
 * This is a backward-compatible extension of team chat's original
 * user-only mention token, `@[Name](userId)` (see the legacy
 * `extractMentions()` regex in services/teamMessaging.ts). A payload with
 * no `:` is a legacy user mention (`userId` with no type prefix); a payload
 * with a `:` is `type:id` for any of the mentionable entity types.
 *
 * No dependencies — this file is duplicated verbatim into
 * mcp-server/src/utils/mentionTokens.ts so the MCP server (a separate
 * compiled TS project with no access to src/) can parse agent-written text
 * the same way the app does. Keep the two copies in sync.
 */

export type MentionTargetType =
  | 'contact'
  | 'opportunity'
  | 'project'
  | 'proposal'
  | 'document'
  | 'user';

export const MENTION_TARGET_TYPES: MentionTargetType[] = [
  'contact',
  'opportunity',
  'project',
  'proposal',
  'document',
  'user',
];

export interface ParsedMention {
  /** Entity type mentioned. Legacy `@[Name](userId)` tokens parse as 'user'. */
  type: MentionTargetType;
  /** UUID of the mentioned entity. */
  id: string;
  /** Display text shown to the user (between the square brackets). */
  displayName: string;
  /** The full raw token, e.g. `@[Acme Corp](contact:1234...)`. */
  raw: string;
  /** Character offset of the token's start within the source text. */
  index: number;
}

// Matches @[Display Name](payload) where payload has no `)` or `]`.
const MENTION_TOKEN_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

function isKnownTargetType(value: string): value is MentionTargetType {
  return (MENTION_TARGET_TYPES as string[]).includes(value);
}

/**
 * Parse every `@[Name](type:id)` (or legacy `@[Name](userId)`) token out of
 * free text. Malformed payloads (unknown type, empty id) are skipped rather
 * than throwing — this runs on arbitrary user- and agent-written content.
 */
export function parseMentions(text: string): ParsedMention[] {
  if (!text) return [];
  const results: ParsedMention[] = [];
  const re = new RegExp(MENTION_TOKEN_RE);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const [raw, displayName, payload] = match;
    const colonIndex = payload.indexOf(':');

    let type: string;
    let id: string;
    if (colonIndex === -1) {
      // Legacy user mention: payload IS the user id.
      type = 'user';
      id = payload;
    } else {
      type = payload.slice(0, colonIndex);
      id = payload.slice(colonIndex + 1);
    }

    if (!id || !isKnownTargetType(type)) continue;

    results.push({
      type,
      id,
      displayName,
      raw,
      index: match.index,
    });
  }

  return results;
}

/** Build a mention token for insertion into composer text. */
export function buildMentionToken(
  type: MentionTargetType,
  id: string,
  displayName: string
): string {
  // 'user' keeps the legacy payload shape (no type prefix) so existing
  // consumers of team_messages.mentions / notification fan-out that only
  // understand bare user ids keep working unchanged.
  const payload = type === 'user' ? id : `${type}:${id}`;
  return `@[${displayName}](${payload})`;
}

/** Strip all mention tokens down to their plain `@Display Name` form. */
export function mentionsToPlainText(text: string): string {
  if (!text) return text;
  return text.replace(MENTION_TOKEN_RE, '@$1');
}

/**
 * Build a ~`maxLen`-char snippet of `text` centered on the mention token at
 * `tokenIndex`/`tokenLength` (raw-text coordinates, as returned by
 * `parseMentions`), for storage in entity_mentions.snippet. Mention tokens
 * fully inside the window are rendered as their plain `@Display Name` form;
 * a token that straddles the window edge is left as-is (rare with a
 * ~200-char window around typical token lengths).
 */
export function buildMentionSnippet(
  text: string,
  tokenIndex: number,
  tokenLength: number,
  maxLen = 200
): string {
  const tokenCenter = tokenIndex + Math.floor(tokenLength / 2);
  const half = Math.floor(maxLen / 2);
  let start = Math.max(0, tokenCenter - half);
  let end = Math.min(text.length, start + maxLen);
  start = Math.max(0, end - maxLen);

  let snippet = mentionsToPlainText(text.slice(start, end)).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return snippet;
}
