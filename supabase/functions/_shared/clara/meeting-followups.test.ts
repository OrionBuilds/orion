import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import {
  type FollowUpDraftInput, type FollowUpMeeting, finalizeDraft, followUpRef, isInternalEmail, loadFollowUpSettings,
  normalizeFollowUpConfig, parseEmailDraft, queueMeetingFollowUps, sendAfterFor, templateFollowUp,
} from "./meeting-followups.ts";
import { approvedSendDeps, draftMeetingFollowUp } from "./runtime.ts";

const NOW = new Date("2026-10-20T15:00:00Z");
const meeting: FollowUpMeeting = {
  meetingTranscriptionId: "mt1", title: "Acme kickoff", startedAt: "2026-10-20T13:00:00Z", endedAt: "2026-10-20T14:00:00Z",
  summary: "We agreed the new checkout ships in two phases.", keyPoints: ["Two phases"], actionItems: [{ description: "Send the phase-1 scope" }],
};
const pat = { id: "c1", email: "pat@acme.com", first_name: "Pat", last_name: "Lee", phone: "+15555550101" };
const teammate = { id: "c2", email: "sam@example.com", first_name: "Sam", last_name: null, phone: "+15555550102" };
const legacy = (over: Record<string, unknown> = {}) => ({
  org_id: "o", enabled: true, default_channel: "both", default_delay_minutes: 120, respect_quiet_hours: true,
  exclude_internal: true, internal_domains: ["example.com"], ai_instructions: "Keep it short.", ...over,
});
const mk = (seed: Record<string, Record<string, unknown>[]> = {}) =>
  new FakeSupabase({ users: [{ id: "u1", organization_id: "o", email: "jordan@example.com" }], meeting_follow_up_settings: [legacy()], ...seed },
    { unique: { workflow_approval_queue: [["agent_slug", "external_ref"]] } });
const input = (channel: "email" | "sms"): FollowUpDraftInput => ({ channel, contactName: "Pat Lee", firstName: "Pat", meeting, toneInstructions: null });

// ── settings ────────────────────────────────────────────────────────────────────────────

Deno.test("settings: the clara.meeting_followups schedule's config.followup wins over the legacy table", async () => {
  const f = mk({ agent_task_schedules: [{ org_id: "o", task_key: "clara.meeting_followups", updated_at: "2026-10-20T00:00:00Z",
    config: { followup: { enabled: true, channels: "sms", send_delay_minutes: 30, tone_instructions: "Casual." } } }] });
  const s = await loadFollowUpSettings(asClient(f), "o");
  assertEquals([s.source, s.enabled, s.channels, s.sendDelayMinutes, s.toneInstructions], ["schedule", true, ["sms"], 30, "Casual."]);
});

Deno.test("settings: no schedule row (the agent user was deleted) falls back to the org-level legacy row; nothing at all = disabled", async () => {
  const s = await loadFollowUpSettings(asClient(mk({ agent_task_schedules: [{ org_id: "o", task_key: "clara.meeting_followups", config: {} }] })), "o");
  assertEquals([s.source, s.enabled, s.channels, s.sendDelayMinutes, s.toneInstructions, s.internalDomains], ["legacy_table", true, ["email", "sms"], 120, "Keep it short.", ["example.com"]]);
  const none = await loadFollowUpSettings(asClient(new FakeSupabase({})), "o");
  assertEquals([none.source, none.enabled], ["default", false]);
  assertEquals(normalizeFollowUpConfig({ enabled: true, send_delay_minutes: -5, internal_domains: ["@Acme.COM "] }, "schedule").sendDelayMinutes, 120);
  assertEquals(normalizeFollowUpConfig({ internal_domains: ["@Acme.COM "] }, "schedule").internalDomains, ["acme.com"]);
});

// ── drafting ────────────────────────────────────────────────────────────────────────────

Deno.test("draft fallback: a failed or empty model draft becomes the static template (summary recap, email subject)", () => {
  const e = finalizeDraft(input("email"), null);
  assertEquals([e.fromTemplate, e.subject, e.body.startsWith("Hi Pat, thanks for the time today. Quick recap: We agreed")], [true, "Recap — Acme kickoff", true]);
  assertEquals(finalizeDraft(input("sms"), { subject: null, body: "ok" }).fromTemplate, true);
  const noSummary = templateFollowUp({ ...input("sms"), meeting: { ...meeting, summary: null } });
  assertEquals(noSummary.body.includes('"Acme kickoff"'), true);
  const ai = finalizeDraft(input("email"), { subject: null, body: "Hi Pat, here is the recap of today's meeting." });
  assertEquals([ai.fromTemplate, ai.subject], [false, "Follow-up: Acme kickoff"]);
});

Deno.test("subject parsing (ported from the generator) and the model seam: real draft parsed, outage → null", async () => {
  assertEquals(parseEmailDraft("Subject: Recap: kickoff\n\nHi Pat,\nThanks."), { subject: "Recap: kickoff", body: "Hi Pat,\nThanks." });
  assertEquals(parseEmailDraft("Hi Pat, no subject here"), { subject: null, body: "Hi Pat, no subject here" });
  const env = { get: (k: string) => ({ ANTHROPIC_API_KEY: "k" } as Record<string, string>)[k] };
  let sentBody = "";
  const ok = (async (_u: unknown, init?: RequestInit) => {
    sentBody = String(init?.body);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Subject: Great meeting\n\nHi Pat, thanks for today." }] }), { status: 200 });
  }) as typeof fetch;
  const d = await draftMeetingFollowUp(env, { ...input("email"), toneInstructions: "Be brief." }, { fetch: ok });
  assertEquals(d, { subject: "Great meeting", body: "Hi Pat, thanks for today." });
  assertEquals(sentBody.includes("Additional tone/style instructions: Be brief."), true);
  const down = (() => Promise.resolve(new Response("overloaded", { status: 529 }))) as typeof fetch;
  assertEquals(await draftMeetingFollowUp(env, input("sms"), { fetch: down }), null);
  assertEquals(await draftMeetingFollowUp({ get: () => undefined }, input("sms"), { fetch: ok }), null);
});

Deno.test("send_after = meeting end + delay (now + delay when the end is unknown); internal addresses are skipped", () => {
  assertEquals(sendAfterFor(meeting, 120, NOW), "2026-10-20T16:00:00.000Z");
  assertEquals(sendAfterFor({ startedAt: null, endedAt: null }, 30, NOW), "2026-10-20T15:30:00.000Z");
  const s = { excludeInternal: true, internalDomains: ["example.com"] };
  assertEquals(isInternalEmail("sam@example.com", s, new Set()), true);
  assertEquals(isInternalEmail("sam@example.com", { ...s, excludeInternal: false }, new Set()), false);
  assertEquals(isInternalEmail("me@gmail.com", { ...s, excludeInternal: false }, new Set(["me@gmail.com"])), true);
});

// ── filing ──────────────────────────────────────────────────────────────────────────────

Deno.test("one client_visible approval per external contact per channel, deduped by meeting:contact:channel ref", async () => {
  const f = mk(); const db = asClient(f);
  let calls = 0;
  const draft = (i: FollowUpDraftInput) => { calls++; return Promise.resolve(i.channel === "sms" ? { subject: null, body: "Hi Pat, thanks for today! Phase-1 scope coming." } : null); };
  const r = await queueMeetingFollowUps(db, { orgId: "o", meeting, contacts: [pat, teammate], draft, now: NOW });
  assertEquals([r.drafted, r.skipped], [2, 1]);
  const rows = f.rows("workflow_approval_queue");
  assertEquals(rows.map((x) => x.external_ref).sort(), [followUpRef("mt1", "c1", "email"), followUpRef("mt1", "c1", "sms")].sort());
  assertEquals(followUpRef("mt1", "c1", "sms"), "meeting-followup:mt1:c1:sms");
  const sms = rows.find((x) => x.action_type === "clara_sms")!;
  const dc = sms.draft_content as { risk_tier: string; approval_required: boolean; draft: Record<string, unknown> };
  assertEquals([sms.status, sms.contact_id, dc.risk_tier, dc.approval_required], ["pending_approval", "c1", "client_visible", true]);
  assertEquals([dc.draft.kind, dc.draft.to, dc.draft.send_after, dc.draft.respect_quiet_hours], ["sms", "+15555550101", "2026-10-20T16:00:00.000Z", true]);
  assertEquals((dc.draft.log as { source: string }).source, "meeting_follow_up");
  const email = (rows.find((x) => x.action_type === "clara_email")!.draft_content as { draft: Record<string, unknown> }).draft;
  assertEquals([email.to, email.subject], [["pat@acme.com"], "Recap — Acme kickoff"]); // model returned nothing → template

  // Reprocessing the same meeting: nothing new, and no second model call.
  const again = await queueMeetingFollowUps(db, { orgId: "o", meeting, contacts: [pat], draft, now: NOW });
  assertEquals([again.drafted, again.existing, calls], [0, 2, 2]);
  assertEquals(f.rows("workflow_approval_queue").length, 2);
});

Deno.test("disabled settings, a contact without a phone, or a flagged transcript (template only) behave", async () => {
  const off = mk({ meeting_follow_up_settings: [legacy({ enabled: false })] });
  assertEquals((await queueMeetingFollowUps(asClient(off), { orgId: "o", meeting, contacts: [pat], now: NOW })).drafted, 0);
  assertEquals(off.rows("workflow_approval_queue").length, 0);

  const f = mk(); let called = false;
  const r = await queueMeetingFollowUps(asClient(f), {
    orgId: "o", meeting: { ...meeting, injectionFlagged: true }, contacts: [{ ...pat, phone: null }],
    draft: () => { called = true; return Promise.resolve({ subject: "x", body: "an injected draft that should never be used" }); }, now: NOW,
  });
  assertEquals([r.drafted, r.skipped, called], [1, 1, false]);
  assertEquals((f.rows("workflow_approval_queue")[0].draft_content as { draft: { subject: string } }).draft.subject, "Recap — Acme kickoff");
});

// ── the real SMS seam: Clara's number, Twilio, and the Conversations timeline ───────────

Deno.test("approved SMS goes out from Clara's number and is filed with metadata.source='meeting_follow_up'", async () => {
  const f = new FakeSupabase({
    twilio_numbers: [{ org_id: "o", agent_label: "Clara", phone_number: "+15555550000" }],
    conversations: [], messages: [], dnc_numbers: [{ org_id: "o", phone_number: "+15555550199" }],
  });
  const env = { get: (k: string) => ({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", CLARA_USER_ID: "clara" } as Record<string, string>)[k] };
  const posted: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) => {
    posted.push(`${String(u)} ${String(init?.body)}`);
    return Promise.resolve(new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 }));
  }) as typeof fetch;
  try {
    const deps = approvedSendDeps(asClient(f), env);
    await deps.sendSms!("o", { to: "+15555550101", body: "Hi Pat, recap.", contact_id: "c1", log: { source: "meeting_follow_up", meeting_transcription_id: "mt1" } });
    assertEquals(posted.length, 1);
    assertEquals([posted[0].includes("api.twilio.com"), posted[0].includes("From=%2B15555550000")], [true, true]);
    const msg = f.rows("messages")[0];
    const meta = msg.metadata as Record<string, unknown>;
    assertEquals([msg.contact_id, msg.channel, msg.direction, meta.source, meta.meeting_transcription_id, meta.from_number], ["c1", "sms", "outbound", "meeting_follow_up", "mt1", "+15555550000"]);
    assertEquals(f.rows("conversations").length, 1);
    assertEquals([await deps.smsOptedOut!("o", "+15555550199"), await deps.smsOptedOut!("o", "+15555550101")], [true, false]);
  } finally {
    globalThis.fetch = orig;
  }
});
