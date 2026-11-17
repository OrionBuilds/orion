import { assertEquals } from "jsr:@std/assert@1";
import { createMotionTask, itemKey, motionDueDate, pushMeetingItemsToMotion, type MotionFetch } from "./motion.ts";

const creds = { apiKey: "k", workspaceId: "ws1", projectId: null as string | null };
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

Deno.test("due dates: bare date becomes end of day UTC, junk becomes null", () => {
  assertEquals(motionDueDate("2026-11-14"), "2026-11-14T23:00:00.000Z");
  assertEquals(motionDueDate("2026-11-14T10:00:00Z"), "2026-11-14T10:00:00.000Z");
  assertEquals(motionDueDate("someday"), null);
  assertEquals(motionDueDate(null), null);
});

Deno.test("createMotionTask sends key header, workspace and auto-schedule only with a due date", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: MotionFetch = (url, init) => { calls.push({ url, init }); return Promise.resolve(ok({ id: "t1" })); };
  await createMotionTask(creds, { name: "Send proposal", priority: "HIGH" }, f);
  await createMotionTask({ ...creds, projectId: "p9" }, { name: "Call Blake", dueDate: "2026-11-14" }, f);
  assertEquals(calls[0].url, "https://api.usemotion.com/v1/tasks");
  assertEquals((calls[0].init.headers as Record<string, string>)["X-API-Key"], "k");
  const b0 = JSON.parse(calls[0].init.body as string);
  assertEquals(b0.workspaceId, "ws1");
  assertEquals(b0.autoScheduled, undefined);
  const b1 = JSON.parse(calls[1].init.body as string);
  assertEquals(b1.projectId, "p9");
  assertEquals(b1.dueDate, "2026-11-14T23:00:00.000Z");
  assertEquals(b1.autoScheduled.deadlineType, "SOFT");
});

Deno.test("a 400 on an auto-scheduled task retries once without auto-scheduling", async () => {
  const bodies: Record<string, unknown>[] = [];
  const f: MotionFetch = (_u, init) => {
    bodies.push(JSON.parse(init.body as string));
    return Promise.resolve(bodies.length === 1 ? new Response('{"message":"status not schedulable"}', { status: 400 }) : ok({ id: "t2" }));
  };
  const t = await createMotionTask(creds, { name: "x", dueDate: "2026-11-14" }, f);
  assertEquals(t.id, "t2");
  assertEquals(bodies.length, 2);
  assertEquals(bodies[1].autoScheduled, undefined);
});

Deno.test("itemKey ignores case and whitespace", async () => {
  assertEquals(await itemKey("Send  the Proposal"), await itemKey("send the proposal "));
});

// Minimal in-memory db for pushMeetingItemsToMotion: integrations, connection, claim table.
function fakeDb(connected: boolean) {
  const claims = new Map<string, Record<string, unknown>>();
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let op = "select"; let row: Record<string, unknown> = {}; const eqs: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (k: string, v: unknown) => { eqs[k] = v; return chain; },
        upsert: (r: Record<string, unknown>) => { op = "upsert"; row = r; return chain; },
        update: (r: Record<string, unknown>) => { op = "update"; row = r; return chain; },
        delete: () => { op = "delete"; return chain; },
        maybeSingle: () => {
          if (table === "integrations") return Promise.resolve({ data: { id: "i1" } });
          const sealed = JSON.stringify({ api_key: "k", workspace_id: "ws1" });
          return Promise.resolve({ data: connected ? { credentials_encrypted: sealed, status: "connected", account_info: {} } : null });
        },
        then: (res: (v: unknown) => unknown) => {
          const key = `${eqs.meeting_transcription_id ?? row.meeting_transcription_id}:${eqs.item_key ?? row.item_key}`;
          if (op === "upsert") {
            if (claims.has(key)) return res({ data: [] });
            claims.set(key, row); return res({ data: [{ id: "c" }] });
          }
          if (op === "update") { claims.set(key, { ...claims.get(key), ...row }); return res({ data: null }); }
          if (op === "delete") { claims.delete(key); return res({ data: null }); }
          return res({ data: null });
        },
      };
      void q;
      return chain;
    },
  };
  return { db: db as never, claims };
}

Deno.test("push: creates tasks once, skips repeats, nothing when Motion is not connected", async () => {
  let posts = 0;
  const f: MotionFetch = () => { posts++; return Promise.resolve(ok({ id: `t${posts}` })); };
  const meeting = { transcriptionId: "m1", title: "Kickoff" };
  const items = [{ item: "Send proposal" }, { item: "Call Blake", due: "2026-11-14" }];

  const off = fakeDb(false);
  assertEquals(await pushMeetingItemsToMotion(off.db, "o1", meeting, items, f), { pushed: 0, skipped: 0, failed: 0 });
  assertEquals(posts, 0);

  const on = fakeDb(true);
  assertEquals((await pushMeetingItemsToMotion(on.db, "o1", meeting, items, f)).pushed, 2);
  const again = await pushMeetingItemsToMotion(on.db, "o1", meeting, items, f);
  assertEquals([again.pushed, again.skipped], [0, 2]);
  assertEquals(posts, 2);
});

Deno.test("push: a failed Motion call releases its claim so the next import retries", async () => {
  const on = fakeDb(true);
  const bad: MotionFetch = () => Promise.resolve(new Response('{"message":"nope"}', { status: 500 }));
  const r = await pushMeetingItemsToMotion(on.db, "o1", { transcriptionId: "m2", title: "T" }, [{ item: "Do it" }], bad);
  assertEquals([r.pushed, r.failed], [0, 1]);
  assertEquals(on.claims.size, 0);
  const good: MotionFetch = () => Promise.resolve(ok({ id: "t9" }));
  assertEquals((await pushMeetingItemsToMotion(on.db, "o1", { transcriptionId: "m2", title: "T" }, [{ item: "Do it" }], good)).pushed, 1);
});
