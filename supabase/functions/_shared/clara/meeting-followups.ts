/**
 * Post-meeting client recaps, drafted by Clara and sent only after the owner approves them.
 *
 * Replaces the OS's "Built-in Meeting Follow-Ups" pipeline (meeting_follow_ups rows + the
 * meet-follow-up-generator / meet-follow-up-sender functions). For each external contact matched
 * to a meeting, per enabled channel, Clara drafts a recap (AI, with a deterministic template when
 * the model is unavailable) and files it as ONE approval in the OS approvals hub
 * (workflow_approval_queue, source='agent_approval'). clara-approved-sends delivers approved drafts:
 * email from Clara's mailbox (owner CC'd), texts from Clara's number, both held until
 * `send_after` (meeting end + delay) and outside the org's quiet hours, and both filed into
 * Conversations with metadata.source='meeting_follow_up'. Risk tier client_visible: never auto-sent.
 *
 * Settings: the clara.meeting_followups agent schedule's config.followup when such a row exists in
 * the org; otherwise the legacy org-level meeting_follow_up_settings row (kept until a later
 * cleanup, because the schedule row is cascade-deleted whenever Clara's agent user is). No settings
 * anywhere = disabled.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createApproval } from "./approvals.ts";

export type FollowUpChannel = "email" | "sms";

export interface FollowUpSettings {
  enabled: boolean;
  channels: FollowUpChannel[];
  sendDelayMinutes: number;
  respectQuietHours: boolean;
  excludeInternal: boolean;
  internalDomains: string[];
  toneInstructions: string | null;
  source: "schedule" | "legacy_table" | "default";
}

export const DEFAULT_DELAY_MINUTES = 120;
export const FOLLOWUP_TASK_KEY = "clara.meeting_followups";

const DISABLED: FollowUpSettings = {
  enabled: false, channels: ["email"], sendDelayMinutes: DEFAULT_DELAY_MINUTES, respectQuietHours: true,
  excludeInternal: true, internalDomains: [], toneInstructions: null, source: "default",
};

const channelsOf = (v: unknown): FollowUpChannel[] =>
  v === "both" ? ["email", "sms"] : v === "sms" ? ["sms"] : ["email"];

/** Pure: config.followup jsonb (or a legacy settings row) → settings. Unknown/missing keys take safe defaults. */
export function normalizeFollowUpConfig(raw: Record<string, unknown> | null | undefined, source: FollowUpSettings["source"]): FollowUpSettings {
  if (!raw || typeof raw !== "object") return { ...DISABLED, source };
  const delay = Number(raw.send_delay_minutes ?? raw.default_delay_minutes);
  const domains = Array.isArray(raw.internal_domains) ? raw.internal_domains : [];
  const tone = raw.tone_instructions ?? raw.ai_instructions;
  return {
    enabled: raw.enabled === true,
    channels: channelsOf(raw.channels ?? raw.default_channel),
    sendDelayMinutes: Number.isFinite(delay) && delay >= 0 ? Math.min(Math.round(delay), 7 * 24 * 60) : DEFAULT_DELAY_MINUTES,
    respectQuietHours: raw.respect_quiet_hours !== false,
    excludeInternal: raw.exclude_internal !== false,
    internalDomains: domains.map((d) => String(d).trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
    toneInstructions: typeof tone === "string" && tone.trim() ? tone.trim().slice(0, 2000) : null,
    source,
  };
}

export async function loadFollowUpSettings(db: SupabaseClient, orgId: string): Promise<FollowUpSettings> {
  const { data: sched } = await db.from("agent_task_schedules").select("config, updated_at")
    .eq("org_id", orgId).eq("task_key", FOLLOWUP_TASK_KEY).order("updated_at", { ascending: false }).limit(5);
  const withConfig = ((sched ?? []) as { config: Record<string, unknown> | null }[]).find((r) => r.config && typeof r.config.followup === "object" && r.config.followup);
  if (withConfig) return normalizeFollowUpConfig(withConfig.config!.followup as Record<string, unknown>, "schedule");
  const { data: legacy } = await db.from("meeting_follow_up_settings")
    .select("enabled, default_channel, default_delay_minutes, respect_quiet_hours, exclude_internal, internal_domains, ai_instructions")
    .eq("org_id", orgId).maybeSingle();
  if (legacy) return normalizeFollowUpConfig(legacy as Record<string, unknown>, "legacy_table");
  return { ...DISABLED };
}

// ── The meeting and the people ────────────────────────────────────────────────────────────

export interface FollowUpActionItem { description: string; assignee?: string | null; due_date?: string | null }

export interface FollowUpMeeting {
  meetingTranscriptionId: string;
  title: string;
  startedAt?: string | null;
  endedAt?: string | null;
  summary: string | null;
  keyPoints: string[];
  actionItems: FollowUpActionItem[];
  /** The transcript tripped the injection detector: draft from the template only. */
  injectionFlagged?: boolean;
}

export interface FollowUpContact { id: string; email: string | null; first_name: string | null; last_name?: string | null; phone: string | null }

export interface FollowUpDraftInput {
  channel: FollowUpChannel;
  contactName: string;
  firstName: string;
  meeting: FollowUpMeeting;
  toneInstructions: string | null;
}

export interface FollowUpDraft { subject: string | null; body: string }
export type FollowUpDrafter = (i: FollowUpDraftInput) => Promise<FollowUpDraft | null>;

export const FOLLOWUP_REF_PREFIX = "meeting-followup:";
export const followUpRef = (meetingTranscriptionId: string, contactId: string, channel: FollowUpChannel) =>
  `${FOLLOWUP_REF_PREFIX}${meetingTranscriptionId}:${contactId}:${channel}`;

// ── Prompts (ported from meet-follow-up-generator) ────────────────────────────────────────

const meetingDateText = (iso: string | null | undefined, tz: string) => {
  const d = iso ? new Date(iso) : new Date();
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" });
};

export function buildSmsPrompt(i: FollowUpDraftInput): string {
  const m = i.meeting;
  let prompt = `Generate a concise, professional follow-up SMS message (under 320 characters) for ${i.contactName} after a meeting titled "${m.title}".`;
  if (m.summary) prompt += `\n\nMeeting summary:\n${m.summary.substring(0, 800)}`;
  if (m.actionItems.length > 0) prompt += `\n\nKey action items:\n${m.actionItems.slice(0, 5).map((a) => `- ${a.description}`).join("\n")}`;
  if (i.toneInstructions) prompt += `\n\nAdditional tone/style instructions: ${i.toneInstructions}`;
  prompt += `\n\nRequirements:
- Keep it under 320 characters
- Be warm but professional
- Reference the meeting briefly
- Mention 1-2 key next steps if applicable
- Do not use placeholder brackets like [Name]
- Address the person by their first name
- Return ONLY the message text, no labels or prefixes`;
  return prompt;
}

export function buildEmailPrompt(i: FollowUpDraftInput, tz = "America/New_York"): string {
  const m = i.meeting;
  let prompt = `Generate a professional follow-up email for ${i.contactName} after a meeting titled "${m.title}" on ${meetingDateText(m.startedAt, tz)}.`;
  if (m.summary) prompt += `\n\nMeeting summary:\n${m.summary.substring(0, 1500)}`;
  if (m.keyPoints.length > 0) prompt += `\n\nKey discussion points:\n${m.keyPoints.slice(0, 8).map((p) => `- ${p}`).join("\n")}`;
  if (m.actionItems.length > 0) {
    prompt += `\n\nAction items:\n${m.actionItems.slice(0, 10).map((a) => {
      let line = `- ${a.description}`;
      if (a.assignee) line += ` (${a.assignee})`;
      if (a.due_date) line += ` - due ${meetingDateText(a.due_date, tz)}`;
      return line;
    }).join("\n")}`;
  }
  if (i.toneInstructions) prompt += `\n\nAdditional tone/style instructions: ${i.toneInstructions}`;
  prompt += `\n\nRequirements:
- Generate a subject line on the first line prefixed with "Subject: "
- Then a blank line, followed by the email body
- Include a greeting using the person's first name
- Briefly recap key discussion highlights
- List action items with clear ownership
- Close professionally with next steps
- Do not use placeholder brackets like [Name] or [Company]
- Keep it concise but thorough (under 500 words)
- Return ONLY the subject line and email body`;
  return prompt;
}

/** Pure: "Subject: ...\n\nbody" → parts (the generator's parsing). No subject line = whole text is the body. */
export function parseEmailDraft(fullText: string): FollowUpDraft {
  const text = fullText.trim();
  const subjectMatch = text.match(/^Subject:\s*(.+)/im);
  if (!subjectMatch) return { subject: null, body: text };
  return { subject: subjectMatch[1].trim().slice(0, 200), body: text.replace(/^Subject:\s*.+\n\n?/im, "").trim() };
}

/**
 * Deterministic fallback so a model outage (or a flagged transcript) never silently drops a recap.
 * With a summary it is the template the built-in pipeline seeded; without one, the generator's.
 */
export function templateFollowUp(i: FollowUpDraftInput): FollowUpDraft {
  const m = i.meeting;
  const first = i.firstName || "there";
  if (i.channel === "sms") {
    return m.summary
      ? { subject: null, body: `Hi ${first}, thanks for the time today. Quick recap: ${m.summary.slice(0, 400)}` }
      : { subject: null, body: `Hi ${first}, great connecting in our "${m.title}" meeting! I'll follow up on the action items we discussed. Let me know if you need anything in the meantime.` };
  }
  const items = m.actionItems.length ? m.actionItems.slice(0, 5).map((a) => `- ${a.description}`).join("\n") : "";
  const body = m.summary
    ? `Hi ${first}, thanks for the time today. Quick recap: ${m.summary.slice(0, 400)}${items ? `\n\nNext steps:\n${items}` : ""}`
    : `Hi ${first},\n\nThank you for taking the time to meet today. I wanted to follow up on our discussion and recap the key action items:\n\n${items || "- No specific action items recorded"}\n\nPlease let me know if I missed anything or if you have questions about next steps.\n\nBest regards`;
  return { subject: `Recap — ${m.title}`, body };
}

/** Pure: a model draft is usable only when it has real content (and an email has a subject, else the template's). */
export function finalizeDraft(i: FollowUpDraftInput, ai: FollowUpDraft | null): FollowUpDraft & { fromTemplate: boolean } {
  const body = ai?.body?.trim() ?? "";
  if (body.length < 20) return { ...templateFollowUp(i), fromTemplate: true };
  if (i.channel === "sms") return { subject: null, body: body.slice(0, 640), fromTemplate: false };
  return { subject: ai?.subject?.trim() || `Follow-up: ${i.meeting.title}`, body, fromTemplate: false };
}

/** Pure: when the recap may go out — meeting end (else now) + the delay. */
export function sendAfterFor(m: Pick<FollowUpMeeting, "endedAt" | "startedAt">, delayMinutes: number, now: Date): string {
  const end = m.endedAt ? Date.parse(m.endedAt) : NaN;
  const base = Number.isFinite(end) ? end : now.getTime();
  return new Date(base + delayMinutes * 60_000).toISOString();
}

/** Pure: is this address one of ours (internal domain or an org member)? */
export function isInternalEmail(email: string | null, s: Pick<FollowUpSettings, "excludeInternal" | "internalDomains">, teamEmails: Set<string>): boolean {
  const e = email?.trim().toLowerCase();
  if (!e) return false;
  if (teamEmails.has(e)) return true;
  if (!s.excludeInternal) return false;
  const domain = e.split("@")[1];
  return Boolean(domain && s.internalDomains.includes(domain));
}

// ── Filing ────────────────────────────────────────────────────────────────────────────────

export interface QueueResult { drafted: number; existing: number; skipped: number; enabled: boolean }

/**
 * One owner-approval per external contact per enabled channel. Idempotent on the external ref, and
 * an existing ref is checked BEFORE drafting so a reprocessed meeting never pays for a second model
 * call. Never throws for one contact's failure; the meeting filing must not depend on the recap.
 */
export async function queueMeetingFollowUps(
  db: SupabaseClient,
  d: { orgId: string; meeting: FollowUpMeeting; contacts: FollowUpContact[]; draft?: FollowUpDrafter; now?: Date; settings?: FollowUpSettings },
): Promise<QueueResult> {
  const s = d.settings ?? await loadFollowUpSettings(db, d.orgId);
  const out: QueueResult = { drafted: 0, existing: 0, skipped: 0, enabled: s.enabled };
  if (!s.enabled || !d.contacts.length) return out;
  const now = d.now ?? new Date();

  const { data: team } = await db.from("users").select("email").eq("organization_id", d.orgId);
  const teamEmails = new Set(((team ?? []) as { email: string | null }[]).map((u) => u.email?.trim().toLowerCase()).filter(Boolean) as string[]);
  const sendAfter = sendAfterFor(d.meeting, s.sendDelayMinutes, now);
  const seen = new Set<string>();

  for (const c of d.contacts) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (isInternalEmail(c.email, s, teamEmails)) { out.skipped++; continue; }
    const contactName = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.email || "there";
    const firstName = c.first_name?.trim() || contactName.split(" ")[0];
    for (const channel of s.channels) {
      const to = channel === "email" ? c.email?.trim() : c.phone?.trim();
      if (!to) { out.skipped++; continue; }
      const ref = followUpRef(d.meeting.meetingTranscriptionId, c.id, channel);
      try {
        const { data: ex } = await db.from("workflow_approval_queue").select("id")
          .eq("agent_slug", "clara").eq("external_ref", ref).eq("source", "agent_approval").maybeSingle();
        if (ex) { out.existing++; continue; }
        const input: FollowUpDraftInput = { channel, contactName, firstName, meeting: d.meeting, toneInstructions: s.toneInstructions };
        const ai = d.meeting.injectionFlagged || !d.draft ? null : await d.draft(input).catch(() => null);
        const draft = finalizeDraft(input, ai);
        const when = `${s.respectQuietHours ? "outside quiet hours, " : ""}no earlier than ${sendAfter}`;
        const log = { source: "meeting_follow_up", meeting_transcription_id: d.meeting.meetingTranscriptionId, channel, drafted_by: draft.fromTemplate ? "template" : "ai" };
        const r = await createApproval(db, {
          orgId: d.orgId, externalRef: ref, contactId: c.id, risk: "medium", riskTier: "client_visible",
          title: `Meeting recap ${channel === "sms" ? "text" : "email"} to ${contactName} — ${d.meeting.title}`,
          description: `Recap of "${d.meeting.title}" for ${contactName}${draft.fromTemplate ? " (template draft)" : ""}${d.meeting.injectionFlagged ? "; the transcript tripped the injection check, so this is the plain template" : ""}. Approve to send from Clara's ${channel === "sms" ? "number" : "mailbox"} ${when}.`,
          draft: channel === "sms"
            ? { kind: "sms", to, body: draft.body, contact_id: c.id, send_after: sendAfter, respect_quiet_hours: s.respectQuietHours, log }
            : { kind: "email", to: [to], subject: draft.subject ?? `Recap — ${d.meeting.title}`, body: draft.body, contact_id: c.id, send_after: sendAfter, respect_quiet_hours: s.respectQuietHours, log },
        });
        if (r.created) out.drafted++; else out.existing++;
      } catch (e) {
        out.skipped++;
        console.warn(`[meeting-followups] ${ref}: ${(e as Error).message}`);
      }
    }
  }
  return out;
}
