import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { STALE_MINUTES, announcement, processRequestResults } from "./request-results.ts";
import type { NotifyRequest, NotifyResult } from "./notify.ts";

const NOW = new Date("2026-10-20T15:00:00Z");
const base = { org_id: "o", kind: "bug", notified_at: null, attempt: 0, result_summary: null, error: null };
function run(rows: Record<string, unknown>[], result: NotifyResult | ((r: NotifyRequest) => NotifyResult) = "sms") {
  const f = new FakeSupabase({ agent_requests: rows });
  const sent: NotifyRequest[] = [];
  const p = processRequestResults(asClient(f), { now: () => NOW, notify: (_o, r) => { sent.push(r); return Promise.resolve(typeof result === "function" ? result(r) : result); } });
  return { f, sent, p };
}

Deno.test("announcements say what FRIDAY did, asked, or couldn't do", () => {
  assertEquals(announcement({ title: "Login 500", status: "completed", result_summary: "Fixed null check, PR #12.", error: null }), 'FRIDAY finished "Login 500". Fixed null check, PR #12.');
  assertEquals(announcement({ title: "T", status: "needs_input", result_summary: "Which env?", error: null }).endsWith("Reply with your answer and I'll pass it on."), true);
  assertEquals(announcement({ title: "T", status: "failed", result_summary: null, error: "tests red" }).includes("tests red"), true);
});

Deno.test("each finished request is announced once and then marked notified", async () => {
  const s = run([{ ...base, id: "r1", title: "A", status: "completed", result_summary: "ok", finished_at: "2026-10-20T14:59:00Z", created_at: "2026-10-20T14:00:00Z" }]);
  assertEquals((await s.p).announced, 1);
  assertEquals(s.f.rows("agent_requests")[0].notified_at, NOW.toISOString());
  assertEquals(s.sent[0].dedupeKey, "agent-request:r1:completed");
  // Next minute: nothing left to say.
  const again = await processRequestResults(asClient(s.f), { now: () => NOW, notify: () => Promise.reject(new Error("must not notify")) });
  assertEquals(again.announced, 0);
});

Deno.test("if the owner couldn't be reached the request stays un-notified and retries", async () => {
  const s = run([{ ...base, id: "r1", title: "A", status: "failed", error: "x", finished_at: "2026-10-20T14:59:00Z", created_at: "2026-10-20T14:00:00Z" }], "failed");
  assertEquals((await s.p).announced, 0);
  assertEquals(s.f.rows("agent_requests")[0].notified_at, null);
});

Deno.test("a lease that lapsed three times fails the request and the owner hears about it", async () => {
  const s = run([{ ...base, id: "r1", title: "A", status: "claimed", attempt: 3, lease_expires_at: "2026-10-20T14:00:00Z", created_at: "2026-10-20T10:00:00Z" }]);
  const r = await s.p;
  assertEquals([r.failedStale, r.announced], [1, 1]);
  assertEquals(s.f.rows("agent_requests")[0].status, "failed");
  assertEquals(s.sent[0].text.includes("stopped responding"), true);
});

Deno.test("work nobody has picked up is warned about once; fresh work is left alone", async () => {
  const old = new Date(NOW.getTime() - (STALE_MINUTES + 5) * 60_000).toISOString();
  const s = run([
    { ...base, id: "old", title: "Old", status: "queued", created_at: old },
    { ...base, id: "new", title: "New", status: "queued", created_at: NOW.toISOString() },
  ]);
  assertEquals((await s.p).warned, 1);
  assertEquals(s.sent.map((r) => r.dedupeKey), ["agent-request:old:stale"]);
});
