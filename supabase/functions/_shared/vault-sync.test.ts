import { assertEquals } from "jsr:@std/assert";
import { diffManifest, isSafeNotePath, MAX_NOTES_PER_BATCH, parseManifest, parseUpsert, syncKeyMatches } from "./vault-sync.ts";

const H = "a".repeat(64);

Deno.test("isSafeNotePath accepts vault-relative .md paths only", () => {
  for (const ok of ["Inbox.md", "02 Projects/OS/Plan.md", "Omi/Memories.md"]) assertEquals(isSafeNotePath(ok), true, ok);
  for (const bad of ["", "/etc/passwd.md", "../secret.md", "a/../b.md", "C:/vault/x.md", "a\\b.md", "notes.txt", "a//b.md", "./a.md"]) {
    assertEquals(isSafeNotePath(bad), false, bad);
  }
});

Deno.test("parseManifest validates the vault, paths and hashes and drops duplicate paths", () => {
  assertEquals(parseManifest({ vault: "unknown-vault", entries: [] }).ok, false);
  assertEquals(parseManifest({ vault: "friday", entries: [{ path: "../x.md", hash: H }] }).ok, false);
  assertEquals(parseManifest({ vault: "friday", entries: [{ path: "x.md", hash: "nothex" }] }).ok, false);
  const r = parseManifest({ vault: "clara", entries: [{ path: "x.md", hash: H.toUpperCase() }, { path: "x.md", hash: H }] });
  assertEquals(r, { ok: true, value: { vault: "clara", entries: [{ path: "x.md", hash: H }] } });
});

Deno.test("parseUpsert normalizes notes, drops self/unsafe links and enforces limits", () => {
  const note = { path: "02 Projects/A.md", title: "", folder: "", content: "see [[B]]", hash: H, mtime: "2026-10-28T10:00:00Z",
    links: ["02 Projects/B.md", "02 Projects/B.md", "02 Projects/A.md", "../evil.md"] };
  const r = parseUpsert({ vault: "friday", notes: [note] });
  if (!r.ok) throw new Error(r.error);
  assertEquals(r.value.notes[0].title, "A");
  assertEquals(r.value.notes[0].folder, "root");
  assertEquals(r.value.notes[0].links, ["02 Projects/B.md"]);
  assertEquals(r.value.notes[0].mtime, "2026-10-28T10:00:00.000Z");

  assertEquals(parseUpsert({ vault: "friday", notes: [] }).ok, false);
  assertEquals(parseUpsert({ vault: "friday", notes: Array(MAX_NOTES_PER_BATCH + 1).fill(note) }).ok, false);
  assertEquals(parseUpsert({ vault: "friday", notes: [{ ...note, mtime: "yesterday" }] }).ok, false);
  assertEquals(parseUpsert({ vault: "friday", notes: [{ ...note, content: "x".repeat(512 * 1024 + 1) }] }).ok, false);
});

Deno.test("diffManifest asks only for new/changed notes and removes notes gone from the vault", () => {
  const stored = [{ path: "same.md", content_hash: H }, { path: "changed.md", content_hash: "b".repeat(64) }, { path: "gone.md", content_hash: H }];
  const incoming = [{ path: "same.md", hash: H }, { path: "changed.md", hash: H }, { path: "new.md", hash: H }];
  assertEquals(diffManifest(incoming, stored), { need: ["changed.md", "new.md"], remove: ["gone.md"] });
  assertEquals(diffManifest([], stored).remove.length, 3);
});

Deno.test("syncKeyMatches: exact match only, and never with an unset or short configured key", () => {
  const key = "k".repeat(48);
  assertEquals(syncKeyMatches(key, key), true);
  assertEquals(syncKeyMatches(key.slice(0, -1) + "x", key), false);
  assertEquals(syncKeyMatches(key + "k", key), false);
  assertEquals(syncKeyMatches(key.slice(0, 40), key), false);
  assertEquals(syncKeyMatches(null, key), false);
  assertEquals(syncKeyMatches("", key), false);
  assertEquals(syncKeyMatches(key, undefined), false);
  assertEquals(syncKeyMatches("short", "short"), false);
});

Deno.test("Harvey's vault is a known vault, an unknown one is not", () => {
  assertEquals(parseManifest({ vault: "harvey", entries: [] }), { ok: true, value: { vault: "harvey", entries: [] } });
  assertEquals(parseManifest({ vault: "unknown-vault", entries: [] }), { ok: false, error: "unknown vault" });
});
