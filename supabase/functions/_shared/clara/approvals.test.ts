import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { createApproval, decide, deliverDecided, holdReason, listPending, type EmailDraft, type OutgoingSms } from "./approvals.ts";

const draft: EmailDraft = { kind: "email", to: ["pat@acme.com"], subject: "Checking in", body: "Hi Pat — anything to prioritize? — Clara", contact_id: "c1" };
const mk = (seed: Record<string, Record<string, unknown>[]> = {}, rpc?: (a: Record<string, unknown>) => unknown) =>
  new FakeSupabase(seed, { uniqueWhere: undefined, unique: { workflow_approval_queue: [["agent_slug", "external_ref"]] }, rpc: rpc ? { resolve_approval_decision: rpc } : {} });

Deno.test("a draft becomes ONE pending approval however often it is created, and the notification is left to the queue trigger", async () => {
  const f = mk(); const db = asClient(f);
  const a = { orgId: "o", externalRef: "stall:c1:2026-10", title: "Check-in to Pat", draft };
  assertEquals((await createApproval(db, a)).created, true);
  const again = await createApproval(db, a);
  assertEquals(again.created, false);
  assertEquals(f.rows("workflow_approval_queue").length, 1);
  assertEquals(f.rows("notifications").length, 0);
  assertEquals(f.rows("workflow_approval_queue")[0].status, "pending_approval");
});

Deno.test("the owner can see pending items and decide one through the audited RPC", async () => {
  const calls: Record<string, unknown>[] = [];
  const f = mk({ workflow_approval_queue: [
    { id: "a1", org_id: "o", status: "pending_approval", source: "agent_approval", title: "T", requested_at: "2026-10-20T00:00:00Z" },
    { id: "a2", org_id: "o", status: "approved", source: "agent_approval", title: "done", requested_at: "2026-10-19T00:00:00Z" },
    { id: "a3", org_id: "o2", status: "pending_approval", source: "agent_approval", title: "other org", requested_at: "2026-10-20T00:00:00Z" },
  ] }, (args) => { calls.push(args); return { status: "approved" }; });
  const db = asClient(f);
  assertEquals((await listPending(db, "o")).map((p) => p.id), ["a1"]);
  assertEquals(await decide(db, { approvalId: "a1", decision: "approve", ownerUserId: "owner", ownerEmail: "s@x.com" }), { status: "approved" });
  assertEquals([calls[0].p_decision, calls[0].p_user_id, calls[0].p_via_magic_link], ["approve", "owner", false]);
});

Deno.test("an RPC refusal (already decided, not an approver) surfaces as an error, never as success", async () => {
  const f = new FakeSupabase({}, { rpc: {} }); // no stub => error result
  let msg = "";
  try { await decide(asClient(f), { approvalId: "a1", decision: "approve", ownerUserId: "o", ownerEmail: null }); } catch (e) { msg = (e as Error).message; }
  assertEquals(msg.length > 0, true);
});

const decided = (id: string, status: string, d: unknown = { draft }) => ({ id, org_id: "o", source: "agent_approval", agent_slug: "clara", status, title: id, draft_content: d, external_ref: id, acked_at: null, resolved_at: "2026-10-20T00:00:00Z" });

Deno.test("only APPROVED drafts are sent; rejected/expired are closed without sending; each is acted on once", async () => {
  const sent: string[] = [];
  const f = mk({ workflow_approval_queue: [decided("ok", "approved"), decided("no", "rejected"), decided("late", "expired"), { ...decided("pending", "pending_approval"), }] });
  const db = asClient(f);
  const d = { sendEmail: (_o: string, m: { to: string[] }) => { sent.push(m.to.join()); return Promise.resolve(); } };
  assertEquals(await deliverDecided(db, d), { sent: 1, closed: 2, failed: 0, deferred: 0 });
  assertEquals(sent, ["pat@acme.com"]);
  assertEquals(await deliverDecided(db, d), { sent: 0, closed: 0, failed: 0, deferred: 0 }); // nothing re-sent
  assertEquals(f.rows("workflow_approval_queue").find((r) => r.id === "pending")!.acked_at, null);
});

Deno.test("a failed send is not acknowledged (retries) and the owner is told; an unusable draft sends nothing", async () => {
  const told: string[] = [];
  const f = mk({ workflow_approval_queue: [decided("bad", "approved", { draft: { kind: "email", to: [], subject: "", body: "" } }), decided("flaky", "approved")] });
  const db = asClient(f);
  const r = await deliverDecided(db, { sendEmail: () => Promise.reject(new Error("token expired")), onFailure: (_i, t, e) => { told.push(`${t}:${e}`); return Promise.resolve(); } });
  assertEquals(r, { sent: 0, closed: 0, failed: 2, deferred: 0 });
  assertEquals(told, ["flaky:token expired"]);
  assertEquals(f.rows("workflow_approval_queue").find((x) => x.id === "flaky")!.acked_at, null);
  assertEquals(typeof f.rows("workflow_approval_queue").find((x) => x.id === "bad")!.acked_at, "string");
});

// ── SMS drafts and delivery gating (meeting follow-ups) ───────────────────────────────────

const smsDraft = (over: Record<string, unknown> = {}) => ({ draft: { kind: "sms", to: "+15555550101", body: "Hi Pat, recap of today.", contact_id: "c1", log: { source: "meeting_follow_up" }, ...over } });
const quiet = () => Promise.resolve({ quiet: "21:00-09:00", tz: "America/New_York" });

Deno.test("an approved draft is held (not acked, not failed) until send_after, then sent once", async () => {
  const f = mk({ workflow_approval_queue: [decided("later", "approved", { draft: { ...draft, send_after: "2026-10-20T16:00:00Z" } })] });
  const db = asClient(f);
  const sent: string[] = [];
  const at = (iso: string) => ({ now: () => new Date(iso), sendEmail: (_o: string, m: { to: string[] }) => { sent.push(m.to.join()); return Promise.resolve(); } });
  assertEquals(await deliverDecided(db, at("2026-10-20T15:59:00Z")), { sent: 0, closed: 0, failed: 0, deferred: 1 });
  assertEquals(f.rows("workflow_approval_queue")[0].acked_at, null);
  assertEquals(await deliverDecided(db, at("2026-10-20T16:01:00Z")), { sent: 1, closed: 0, failed: 0, deferred: 0 });
  assertEquals(sent, ["pat@acme.com"]);
  assertEquals(await deliverDecided(db, at("2026-10-20T16:02:00Z")), { sent: 0, closed: 0, failed: 0, deferred: 0 });
});

Deno.test("quiet hours hold a draft that respects them (and only that one); a held row never blocks the ones behind it", async () => {
  const f = mk({ workflow_approval_queue: [
    decided("night-text", "approved", smsDraft({ respect_quiet_hours: true })),
    decided("night-mail-anyway", "approved", { draft: { ...draft, respect_quiet_hours: false } }),
  ] });
  const db = asClient(f);
  const texts: OutgoingSms[] = []; const mails: string[] = [];
  const deps = (iso: string) => ({
    now: () => new Date(iso), quietHours: quiet,
    sendEmail: (_o: string, m: { subject: string }) => { mails.push(m.subject); return Promise.resolve(); },
    sendSms: (_o: string, m: OutgoingSms) => { texts.push(m); return Promise.resolve(); },
  });
  // 02:00 ET: the text waits, the email that doesn't respect quiet hours goes.
  assertEquals(await deliverDecided(db, deps("2026-10-20T06:00:00Z")), { sent: 1, closed: 0, failed: 0, deferred: 1 });
  assertEquals([texts.length, mails.length], [0, 1]);
  // 10:00 ET: the text goes, with its contact and timeline metadata.
  assertEquals(await deliverDecided(db, deps("2026-10-20T14:00:00Z")), { sent: 1, closed: 0, failed: 0, deferred: 0 });
  assertEquals(texts[0], { to: "+15555550101", body: "Hi Pat, recap of today.", contact_id: "c1", log: { source: "meeting_follow_up" } });
});

Deno.test("SMS path: no SMS sender = wait; opted-out number = closed unsent; failed text = retried and reported", async () => {
  const f = mk({ workflow_approval_queue: [decided("t1", "approved", smsDraft()), decided("t2", "approved", smsDraft({ to: "+15555550199" }))] });
  const db = asClient(f);
  const email = { sendEmail: () => Promise.resolve() };
  assertEquals(await deliverDecided(db, email), { sent: 0, closed: 0, failed: 0, deferred: 2 });

  const told: string[] = [];
  const r = await deliverDecided(db, {
    ...email, smsOptedOut: (_o, p) => Promise.resolve(p === "+15555550199"),
    sendSms: () => Promise.reject(new Error("twilio down")), onFailure: (i) => { told.push(i); return Promise.resolve(); },
  });
  assertEquals(r, { sent: 0, closed: 1, failed: 1, deferred: 0 });
  assertEquals(told, ["t1"]);
  const rows = f.rows("workflow_approval_queue");
  assertEquals(rows.find((x) => x.id === "t1")!.acked_at, null);
  assertEquals(rows.find((x) => x.id === "t2")!.resolution_note, "not sent: the recipient has opted out of texts");

  const ok = await deliverDecided(db, { ...email, sendSms: () => Promise.resolve() });
  assertEquals(ok, { sent: 1, closed: 0, failed: 0, deferred: 0 });
});

Deno.test("holdReason is pure: scheduled beats quiet hours; no quiet spec means no hold", () => {
  const d = { kind: "sms" as const, to: "+1", body: "x", send_after: "2026-10-20T16:00:00Z", respect_quiet_hours: true };
  assertEquals(holdReason(d, new Date("2026-10-20T15:00:00Z"), { quiet: "21:00-09:00", tz: "America/New_York" }), "scheduled");
  assertEquals(holdReason({ ...d, send_after: null }, new Date("2026-10-20T06:00:00Z"), { quiet: "21:00-09:00", tz: "America/New_York" }), "quiet_hours");
  assertEquals(holdReason({ ...d, send_after: null }, new Date("2026-10-20T06:00:00Z"), { tz: "America/New_York" }), null);
});

Deno.test("an SMS draft becomes a clara_sms approval carrying its contact and the client_visible tier", async () => {
  const f = mk(); const db = asClient(f);
  await createApproval(db, { orgId: "o", externalRef: "meeting-followup:mt1:c1:sms", title: "Recap", riskTier: "client_visible", draft: { kind: "sms", to: "+15555550101", body: "Hi", contact_id: "c1" } });
  const row = f.rows("workflow_approval_queue")[0];
  assertEquals([row.action_type, row.contact_id, (row.draft_content as { risk_tier: string }).risk_tier], ["clara_sms", "c1", "client_visible"]);
});
