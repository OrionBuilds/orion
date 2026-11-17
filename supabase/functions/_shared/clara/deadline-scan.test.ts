import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { MAX_PER_RUN, addDays, bucketFor, deadlineText, localDate, scanTaskDeadlines } from "./deadline-scan.ts";
import type { NotifyRequest } from "./notify.ts";

const NOW = new Date("2026-10-23T03:30:00Z"); // 23:30 on Oct 22 in New York
const ENV = { get: (k: string) => ({ OWNER_USER_ID: "owner", CLARA_TZ: "America/New_York" })[k] };
const task = (id: string, due: string | null, extra: Record<string, unknown> = {}) => ({
  id, org_id: "o", title: `T-${id}`, due_date: due, status: "todo", priority: "medium", assigned_user_id: "owner", ...extra,
});

Deno.test("the local date follows the org timezone, and buckets are overdue / today / tomorrow only", () => {
  assertEquals(localDate(NOW, "America/New_York"), "2026-10-22");
  assertEquals(addDays("2026-10-31", 1), "2026-11-01");
  assertEquals([bucketFor("2026-10-21", "2026-10-22"), bucketFor("2026-10-22", "2026-10-22"), bucketFor("2026-10-23", "2026-10-22"), bucketFor("2026-10-24", "2026-10-22")], ["overdue", "today", "tomorrow", null]);
  assertStringIncludes(deadlineText({ title: "Ship it", due_date: "2026-10-22" }, "today"), "due today");
});

Deno.test("owner's open tasks due soon are notified once per bucket; done, other people's and far-off tasks are not", async () => {
  const notes: NotifyRequest[] = [];
  const seen = new Set<string>();
  const notify = (r: NotifyRequest) => { const dup = seen.has(r.dedupeKey!); seen.add(r.dedupeKey!); if (!dup) notes.push(r); return Promise.resolve(dup ? "deduped" : "queued"); };
  const f = new FakeSupabase({ project_tasks: [
    task("a", "2026-10-20"), task("b", "2026-10-22"), task("c", "2026-10-23"), task("far", "2026-11-30"),
    task("done", "2026-10-20", { status: "completed" }), task("other", "2026-10-20", { assigned_user_id: "someone" }), task("nodate", null),
  ] });
  const r = await scanTaskDeadlines(asClient(f), ENV, { orgId: "o", now: NOW, notify });
  assertEquals(r.alerted, 3);
  assertEquals(notes.map((n) => n.dedupeKey).sort(), ["task-due:a:overdue", "task-due:b:today", "task-due:c:tomorrow"]);
  assertEquals(notes.every((n) => n.priority === "normal" && n.kind === "task.deadline"), true);
  assertEquals((await scanTaskDeadlines(asClient(f), ENV, { orgId: "o", now: NOW, notify })).alerted, 0); // re-run: all deduped
});

Deno.test("a flood of overdue tasks is capped per run, and no owner configured means no scan", async () => {
  const many = Array.from({ length: 25 }, (_, i) => task(`t${i}`, "2026-10-01"));
  const notes: NotifyRequest[] = [];
  const f = new FakeSupabase({ project_tasks: many });
  const r = await scanTaskDeadlines(asClient(f), ENV, { orgId: "o", now: NOW, notify: (n) => { notes.push(n); return Promise.resolve("queued"); } });
  assertEquals([r.alerted, notes.length], [MAX_PER_RUN, MAX_PER_RUN]);
  const none = await scanTaskDeadlines(asClient(f), { get: () => undefined }, { orgId: "o", now: NOW, notify: () => Promise.resolve("queued") });
  assertEquals(none, { alerted: 0, skipped: "no owner user configured" });
});
