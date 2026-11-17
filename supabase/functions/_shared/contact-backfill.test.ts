import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  BACKFILL_BUDGET_MS,
  gmailContactQuery,
  graphContactSearchUrl,
  isBackfillableEmail,
  runGmailContactBackfill,
  runGraphContactBackfill,
} from "./contact-backfill.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");

Deno.test("only real addresses are backfilled", () => {
  for (const ok of ["a@b.co", " Client@Example.com ", "first.last+tag@sub.example.org"]) assert(isBackfillableEmail(ok), ok);
  for (const bad of ["", "   ", null, undefined, "nope", "a@b", "a b@c.com", "a@b.com, c@d.com", "<a@b.com>", "x".repeat(250) + "@b.com"]) {
    assertEquals(isBackfillableEmail(bad as string), false, String(bad));
  }
});

Deno.test("gmail query is one address, lowercased, one year back", () => {
  const q = gmailContactQuery("  Client@Example.com ", NOW);
  assertEquals(q, `after:${Math.floor((NOW - 365 * 86_400_000) / 1000)} (from:client@example.com OR to:client@example.com)`);
});

Deno.test("graph search url targets one folder and strips quotes from the address", () => {
  const u = graphContactSearchUrl("inbox", 'A"@b.com');
  assert(u.startsWith("/me/mailFolders/inbox/messages?$search=\"participants:a@b.com\""));
  assert(u.includes("$top=50"));
});

const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function gmailFetch(pages: Array<{ ids: string[]; next?: string }>, seenUrls: string[] = []) {
  return (input: string | URL | Request) => {
    const url = String(input);
    seenUrls.push(url);
    if (url.includes("/messages?")) {
      const tok = new URL(url).searchParams.get("pageToken");
      const idx = tok ? Number(tok.replace("p", "")) : 0;
      const p = pages[idx];
      return Promise.resolve(jsonRes({ messages: p.ids.map((id) => ({ id })), nextPageToken: p.next }));
    }
    return Promise.resolve(jsonRes({ id: url.split("/").pop() }));
  };
}

Deno.test("gmail backfill walks every page, skips stored ids, counts stored vs skipped", async () => {
  const processed: string[] = [];
  const r = await runGmailContactBackfill({
    gmailApiUrl: "https://gmail.test",
    accessToken: "t",
    email: "c@x.com",
    now: () => NOW,
    fetchImpl: gmailFetch([{ ids: ["a", "b"], next: "p1" }, { ids: ["c"] }]) as unknown as typeof fetch,
    storedIds: (ids) => Promise.resolve(new Set(ids.filter((i) => i === "b"))),
    processMessage: (m) => { processed.push(String((m as { id: string }).id)); return Promise.resolve(m.id !== "c"); },
  });
  assertEquals(r.complete, true);
  assertEquals(processed.sort(), ["a", "c"]);
  assertEquals([r.stats.pages, r.stats.listed, r.stats.stored, r.stats.skipped], [2, 3, 1, 1]);
});

Deno.test("gmail backfill stops at its budget and returns the page to resume from", async () => {
  let clock = NOW;
  const seen: string[] = [];
  const r = await runGmailContactBackfill({
    gmailApiUrl: "https://gmail.test",
    accessToken: "t",
    email: "c@x.com",
    budgetMs: 1000,
    now: () => clock,
    fetchImpl: gmailFetch([{ ids: ["a", "b"], next: "p1" }, { ids: ["c"] }], seen) as unknown as typeof fetch,
    storedIds: () => Promise.resolve(new Set()),
    processMessage: () => { clock += 5000; return Promise.resolve(true); }, // each message "takes" 5 s
  });
  assertEquals(r.complete, false);
  // the first page's batch finished (5 s each, in parallel), so the run resumes at the second page
  assertEquals(r.pageToken, "p1");
  // a resumed run starts from the saved token
  const r2 = await runGmailContactBackfill({
    gmailApiUrl: "https://gmail.test", accessToken: "t", email: "c@x.com", startToken: "p1", now: () => NOW,
    fetchImpl: gmailFetch([{ ids: ["a", "b"], next: "p1" }, { ids: ["c"] }]) as unknown as typeof fetch,
    storedIds: () => Promise.resolve(new Set()), processMessage: () => Promise.resolve(true),
  });
  assertEquals([r2.complete, r2.stats.pages, r2.stats.stored], [true, 1, 1]);
});

Deno.test("gmail backfill: a failing list call throws and reports where it was", async () => {
  const progress: unknown[] = [];
  await assertRejects(() =>
    runGmailContactBackfill({
      gmailApiUrl: "https://gmail.test", accessToken: "t", email: "c@x.com", now: () => NOW,
      fetchImpl: (() => Promise.resolve(jsonRes({}, 429))) as unknown as typeof fetch,
      storedIds: () => Promise.resolve(new Set()), processMessage: () => Promise.resolve(true),
      onProgress: (s) => { progress.push(s.stats.lastError); return Promise.resolve(); },
    }), Error, "429");
  assertEquals(progress.at(-1), "list 429");
});

Deno.test("default budget stays well inside the 60 s cron window", () => {
  assert(BACKFILL_BUDGET_MS <= 45_000);
});

function graphFixture(byUrl: Record<string, unknown>) {
  const urls: string[] = [];
  return {
    urls,
    get: (u: string) => {
      urls.push(u);
      const hit = byUrl[u];
      return Promise.resolve(hit === undefined ? jsonRes({ value: [] }) : jsonRes(hit));
    },
  };
}

Deno.test("graph backfill walks inbox then sent items, follows nextLink, drops mail older than a year", async () => {
  const inbox = graphContactSearchUrl("inbox", "c@x.com");
  const sent = graphContactSearchUrl("sentitems", "c@x.com");
  const fx = graphFixture({
    [inbox]: { value: [{ id: "1", receivedDateTime: "2026-10-01T00:00:00Z" }], "@odata.nextLink": "https://graph.microsoft.com/next" },
    "https://graph.microsoft.com/next": { value: [{ id: "2", receivedDateTime: "2024-01-01T00:00:00Z" }] }, // too old
    [sent]: { value: [{ id: "3", sentDateTime: "2026-09-01T00:00:00Z" }] },
  });
  const stored: string[] = [];
  const r = await runGraphContactBackfill({
    email: "c@x.com", now: () => NOW, graphGet: fx.get,
    processMessage: (m) => { stored.push(String(m.id)); return Promise.resolve(true); },
  });
  assertEquals(r.complete, true);
  assertEquals(stored, ["1", "3"]);
  assertEquals(fx.urls, [inbox, "https://graph.microsoft.com/next", sent]);
  assertEquals([r.stats.pages, r.stats.listed, r.stats.stored, r.stats.skipped], [3, 3, 2, 1]);
});

Deno.test("graph backfill resumes from a saved folder and nextLink, and stops at its budget", async () => {
  const sent = graphContactSearchUrl("sentitems", "c@x.com");
  const fx = graphFixture({ "https://graph.microsoft.com/mid": { value: [{ id: "9", sentDateTime: "2026-09-01T00:00:00Z" }] } });
  const r = await runGraphContactBackfill({
    email: "c@x.com", now: () => NOW, startFolder: "sentitems", startToken: "https://graph.microsoft.com/mid",
    graphGet: fx.get, processMessage: () => Promise.resolve(true),
  });
  assertEquals(fx.urls, ["https://graph.microsoft.com/mid"]); // inbox not repeated
  assertEquals(r.complete, true);

  let clock = NOW;
  const slow = graphFixture({ [sent]: { value: [{ id: "1" }], "@odata.nextLink": "https://graph.microsoft.com/p2" } });
  const cut = await runGraphContactBackfill({
    email: "c@x.com", now: () => clock, budgetMs: 1000, startFolder: "sentitems", graphGet: slow.get,
    processMessage: () => { clock += 5000; return Promise.resolve(true); },
  });
  assertEquals([cut.complete, cut.folder, cut.pageToken], [false, "sentitems", "https://graph.microsoft.com/p2"]);
});

Deno.test("graph backfill: an error response throws; a bad message is counted, not fatal", async () => {
  await assertRejects(() =>
    runGraphContactBackfill({ email: "c@x.com", now: () => NOW, graphGet: () => Promise.resolve(jsonRes({}, 403)), processMessage: () => Promise.resolve(true) }),
    Error, "403");
  const fx = graphFixture({ [graphContactSearchUrl("inbox", "c@x.com")]: { value: [{ id: "1" }, { id: "2" }] } });
  const r = await runGraphContactBackfill({
    email: "c@x.com", now: () => NOW, graphGet: fx.get,
    processMessage: (m) => m.id === "1" ? Promise.reject(new Error("boom")) : Promise.resolve(true),
  });
  assertEquals([r.complete, r.stats.errors, r.stats.stored, r.stats.lastError], [true, 1, 1, "boom"]);
});
