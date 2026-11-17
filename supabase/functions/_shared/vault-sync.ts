/**
 * Pure helpers for the `vault-sync` edge function (FRIDAY → OS vault mirror). Validation and the
 * manifest diff live here so they can be unit-tested without a database.
 *
 * Protocol, per vault:
 *   1. manifest { vault, entries: [{ path, hash }] } → server deletes notes no longer present and
 *      answers { need: [paths whose hash is new or changed] }.
 *   2. upsert   { vault, notes: [...] } (≤ MAX_NOTES_PER_BATCH) → notes + their outgoing links.
 *   3. finish   { vault } → note/link counts and last_synced_at recorded for the UI.
 */

export const VAULTS = ["friday", "clara", "harvey"] as const;
export type VaultName = typeof VAULTS[number];

export const MAX_MANIFEST_ENTRIES = 50_000;
export const MAX_NOTES_PER_BATCH = 100;
export const MAX_NOTE_BYTES = 512 * 1024;
export const MAX_LINKS_PER_NOTE = 500;

export interface ManifestEntry { path: string; hash: string }

export interface NotePayload {
  path: string;
  title: string;
  folder: string;
  content: string;
  hash: string;
  mtime: string; // ISO
  links: string[]; // target paths in the same vault
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A configured VAULT_SYNC_KEY shorter than this is treated as unset. */
export const MIN_SYNC_KEY_LENGTH = 32;

/**
 * Constant-time check of the X-Vault-Sync-Key header against the VAULT_SYNC_KEY secret (the
 * Linux box's sync job uses this instead of an agent sign-in). False when the secret is unset/short.
 */
export function syncKeyMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected || expected.length < MIN_SYNC_KEY_LENGTH) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

export function isVault(v: unknown): v is VaultName {
  return typeof v === "string" && (VAULTS as readonly string[]).includes(v);
}

/** A vault-relative note path: forward slashes, .md, no traversal, no absolute paths. */
export function isSafeNotePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 1024) return false;
  if (p.startsWith("/") || p.includes("\\") || /^[a-zA-Z]:/.test(p)) return false;
  if (p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  return p.toLowerCase().endsWith(".md");
}

const isHash = (h: unknown): h is string => typeof h === "string" && /^[a-f0-9]{16,128}$/i.test(h);

export function parseManifest(body: unknown): ParseResult<{ vault: VaultName; entries: ManifestEntry[] }> {
  const b = body as { vault?: unknown; entries?: unknown };
  if (!isVault(b?.vault)) return { ok: false, error: "unknown vault" };
  if (!Array.isArray(b.entries)) return { ok: false, error: "entries must be an array" };
  if (b.entries.length > MAX_MANIFEST_ENTRIES) return { ok: false, error: "too many entries" };
  const seen = new Set<string>();
  const entries: ManifestEntry[] = [];
  for (const e of b.entries as { path?: unknown; hash?: unknown }[]) {
    if (!isSafeNotePath(e?.path) || !isHash(e?.hash)) return { ok: false, error: `bad entry: ${String(e?.path).slice(0, 80)}` };
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    entries.push({ path: e.path, hash: e.hash.toLowerCase() });
  }
  return { ok: true, value: { vault: b.vault, entries } };
}

export function parseUpsert(body: unknown): ParseResult<{ vault: VaultName; notes: NotePayload[] }> {
  const b = body as { vault?: unknown; notes?: unknown };
  if (!isVault(b?.vault)) return { ok: false, error: "unknown vault" };
  if (!Array.isArray(b.notes) || b.notes.length === 0) return { ok: false, error: "notes must be a non-empty array" };
  if (b.notes.length > MAX_NOTES_PER_BATCH) return { ok: false, error: `at most ${MAX_NOTES_PER_BATCH} notes per batch` };
  const notes: NotePayload[] = [];
  for (const raw of b.notes as Record<string, unknown>[]) {
    const { path, title, folder, content, hash, mtime, links } = raw ?? {};
    if (!isSafeNotePath(path) || !isHash(hash)) return { ok: false, error: `bad note: ${String(path).slice(0, 80)}` };
    if (typeof title !== "string" || typeof folder !== "string" || typeof content !== "string") {
      return { ok: false, error: `bad note fields: ${path}` };
    }
    if (new TextEncoder().encode(content).length > MAX_NOTE_BYTES) return { ok: false, error: `note too large: ${path}` };
    if (typeof mtime !== "string" || !Number.isFinite(Date.parse(mtime))) return { ok: false, error: `bad mtime: ${path}` };
    const targets = Array.isArray(links) ? [...new Set(links.filter(isSafeNotePath))].slice(0, MAX_LINKS_PER_NOTE) : [];
    notes.push({
      path, hash: hash.toLowerCase(), mtime: new Date(mtime).toISOString(), content,
      title: title.slice(0, 300) || path.split("/").pop()!.replace(/\.md$/i, ""),
      folder: folder.slice(0, 120) || "root",
      links: targets.filter((t) => t !== path),
    });
  }
  return { ok: true, value: { vault: b.vault, notes } };
}

/** Pure: which notes the server must fetch, and which it must delete, given what it already has. */
export function diffManifest(
  incoming: ManifestEntry[],
  stored: { path: string; content_hash: string }[],
): { need: string[]; remove: string[] } {
  const have = new Map(stored.map((s) => [s.path, s.content_hash]));
  const want = new Set(incoming.map((e) => e.path));
  return {
    need: incoming.filter((e) => have.get(e.path) !== e.hash).map((e) => e.path),
    remove: stored.filter((s) => !want.has(s.path)).map((s) => s.path),
  };
}
