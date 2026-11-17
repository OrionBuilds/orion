/**
 * Acknowledgement email for a website contact-form submission (envelope kind "contact").
 * Clara tells the submitter the message arrived. Plain text, no promised timeframe, no link.
 * Only the contact form gets one: the assessments are not acknowledged here.
 */
import type { Db } from "./lead-intake.ts";
import { splitName } from "./lead-intake.ts";
import { sendSiteMail, siteOwner, type EmailResult, type SiteMailDeps } from "./site-mail.ts";
import type { SiteEnvelope } from "./site-envelope.ts";

type Row = Record<string, unknown>;

/** The "what do you need help with" answer, for the one-line recap. Empty when the form didn't carry it. */
export function helpTypeOf(env: Pick<SiteEnvelope, "answers">): string {
  const a = env.answers.find((x) => x.questionId === "help_type");
  return (a?.display ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function buildContactAckEmail(i: { firstName: string; helpType: string; unsubscribeUrl: string | null }): { subject: string; text: string } {
  const owner = siteOwner();
  const lines = [
    `Hi ${i.firstName || "there"},`,
    "",
    `Thanks for getting in touch. Your message reached ${owner || "our team"}, and someone will follow up with you.`,
  ];
  if (i.helpType) lines.push("", `You told us you're looking for help with: ${i.helpType}.`);
  lines.push(
    "",
    `If you want to add something, just reply to this email and it will reach ${owner || "our team"}.`,
    "",
    "Clara",
    owner ? `${owner}'s assistant (I'm an AI assistant)` : "I'm an AI assistant",
  );
  if (i.unsubscribeUrl) lines.push("", `Don't want emails like this? Unsubscribe: ${i.unsubscribeUrl}`);
  return { subject: "We got your message", text: lines.join("\n") };
}

/**
 * Send the acknowledgement once, for a new (non-replayed) submission, and record the outcome on the
 * submission. Never throws and never retries: a failure is logged and stored, and the submission stands.
 */
export async function acknowledgeContact(
  db: Db,
  deps: SiteMailDeps,
  env: SiteEnvelope,
  contactId: string,
  submission: { id: string; payload: Row },
): Promise<EmailResult> {
  const { firstName } = splitName(env.contact.name);
  const helpType = helpTypeOf(env);
  const result = await sendSiteMail(db, deps, {
    to: env.contact.email, toName: env.contact.name, contactId,
    category: "contact-ack", args: { form: env.formName },
    build: (unsubscribeUrl) => buildContactAckEmail({ firstName, helpType, unsubscribeUrl }),
  });
  if (result.status === "failed") console.error(`[contact-ack] email to contact ${contactId} failed (submission ${submission.id}): ${result.error}`);
  try {
    const prior = (submission.payload._result as Row | undefined) ?? {};
    const { error } = await db.from("form_submissions")
      .update({ payload: { ...submission.payload, _result: { ...prior, ack_email: result } } }).eq("id", submission.id);
    if (error) console.error("[contact-ack] could not record result:", error.message);
  } catch (e) {
    console.error("[contact-ack] could not record result:", e instanceof Error ? e.message : e);
  }
  return result;
}
