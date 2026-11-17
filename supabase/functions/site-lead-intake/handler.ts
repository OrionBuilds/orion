/**
 * site-lead-intake — receiver for the business website's (SITE_URL) form submissions.
 *
 * The site's server-side webhook sink (`lib/submissions/sinks/webhook.ts` in the site repo) POSTs the
 * submission envelope with an HMAC signature. We verify the raw body against SITE_WEBHOOK_SECRET,
 * then create/gap-fill the contact, reuse or open the Inbound / New Lead opportunity, store the
 * submission, and emit `form_submitted` to the outbox. The notification email goes out
 * asynchronously from notification-dispatcher, so this answers well inside the sink's 5 s limit.
 *
 * Public (verify_jwt=false in config.toml): the sink sends no apikey. Auth is the signature.
 */
import { getSupabaseClient } from "../_shared/auth.ts";
import { sendOrgEmail } from "../_shared/email-defaults.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  addContactTimeline, buildFormSubmittedPayload, emitFormSubmitted, findOrCreateOpenOpportunity,
  findSubmissionByKey, LEAD_ACTOR_USER_ID, LEAD_ORG_ID, recordFormSubmission, upsertContactByEmail,
} from "../_shared/lead-intake.ts";
import { envelopeToLead, parseEnvelope, SITE_HOST, SITE_URL } from "../_shared/site-envelope.ts";
import { SITE_BRAND } from "../_shared/site-mail.ts";
import { isObjectWithKind, parseLeadMagnetEnvelope, processLeadMagnet, type SendLeadMagnetEmail } from "../_shared/lead-magnet.ts";
import type { Db } from "../_shared/lead-intake.ts";
import { acknowledgeContact } from "../_shared/contact-ack.ts";
import { verifySiteSignature } from "../_shared/site-webhook-auth.ts";

const MAX_BODY_BYTES = 64 * 1024;

async function handleLeadMagnet(deps: IntakeDeps, env: Parameters<typeof processLeadMagnet>[2], idHeader: string | null): Promise<Response> {
  try {
    const out = await processLeadMagnet(deps.getDb(), { sendEmail: deps.sendEmail, orgId: LEAD_ORG_ID, actorUserId: LEAD_ACTOR_USER_ID, timeoutMs: deps.sendTimeoutMs, replyTo: Deno.env.get("SITE_LEAD_REPLY_TO") || undefined }, env, idHeader);
    return jsonResponse({ ok: true, ...out });
  } catch (e) {
    // Nothing was recorded, so there is no ref. Log loudly; the visitor still has the on-page link.
    console.error("[site-lead-intake] lead_magnet failed:", e instanceof Error ? e.message : e);
    return jsonResponse({ ok: false, accepted: false, error: "internal error" });
  }
}

export interface IntakeDeps {
  getDb: () => Db;
  secret: () => string | undefined;
  sendEmail: SendLeadMagnetEmail;
  now?: () => number;
  /** Mail-provider deadline; defaults to 2.5 s. */
  sendTimeoutMs?: number;
}

export const defaultDeps: IntakeDeps = {
  getDb: () => getSupabaseClient() as unknown as Db,
  secret: () => Deno.env.get("SITE_WEBHOOK_SECRET"),
  sendEmail: (db, orgId, o) => sendOrgEmail(db, orgId, o),
};

export async function handle(req: Request, deps: IntakeDeps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "method not allowed" }, 405);

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return jsonResponse({ ok: false, error: "payload too large" }, 413);

  const sig = await verifySiteSignature({
    rawBody,
    timestamp: req.headers.get("x-submission-timestamp"),
    signature: req.headers.get("x-submission-signature"),
    secret: deps.secret(),
    nowMs: deps.now?.(),
  });
  if (sig !== "ok") {
    console.warn(`[site-lead-intake] rejected: signature ${sig}`);
    return jsonResponse({ ok: false, error: `signature ${sig}` }, 401);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ ok: false, error: "invalid JSON" }, 400);
  }
  // lead_magnet never answers 4xx/5xx once the signature is good: the site fails the visitor's
  // download if its primary sink errors, and a retry could not fix a malformed envelope anyway.
  const isLeadMagnet = isObjectWithKind(json, "lead_magnet");
  if (isLeadMagnet) {
    const lm = parseLeadMagnetEnvelope(json);
    if (!lm.ok) {
      console.error(`[site-lead-intake] lead_magnet envelope rejected (not retryable): ${lm.error}`);
      return jsonResponse({ ok: false, accepted: false, error: lm.error });
    }
    return await handleLeadMagnet(deps, lm.value, req.headers.get("x-submission-id"));
  }
  const parsed = parseEnvelope(json);
  if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
  const env = parsed.value;
  const submissionIdHeader = req.headers.get("x-submission-id") || env.id;
  const idempotencyKey = `site:${submissionIdHeader}`;

  try {
    const db = deps.getDb();
    const lead = envelopeToLead(env);

    // Replays (the sink doesn't retry, but be safe): answer with what we already did.
    const seen = await findSubmissionByKey(db, idempotencyKey);
    if (seen) {
      const result = (seen.payload?._result ?? {}) as Record<string, unknown>;
      return jsonResponse({ ok: true, duplicate: true, ref: seen.id, id: seen.id, contact_id: seen.contact_id, opportunity_id: result.opportunity_id ?? null });
    }

    const { data: form } = await db.from("forms").select("id, name, public_slug, status")
      .eq("organization_id", LEAD_ORG_ID).eq("public_slug", lead.slug).maybeSingle();
    if (!form || form.status !== "published") {
      console.error(`[site-lead-intake] forms row missing or unpublished for slug ${lead.slug}`);
      return jsonResponse({ ok: false, error: `form ${lead.slug} is not configured` }, 500);
    }
    const source = `web_form_${lead.slug}`;

    const contact = await upsertContactByEmail(db, LEAD_ORG_ID, {
      email: lead.email, firstName: lead.firstName, lastName: lead.lastName, company: lead.company, jobTitle: lead.jobTitle,
    }, { source, brand: SITE_BRAND }); // website leads get the site's brand (Clara's sender)

    const opp = await findOrCreateOpenOpportunity(db, LEAD_ORG_ID, contact.id, {
      source, name: lead.opportunityName, description: lead.description,
    }, {
      created: { eventType: "created_from_form", summary: `Auto-created from ${SITE_HOST} ${lead.formLabel}`, payload: { form_id: form.id, submission_id: env.id } },
      reused: { eventType: "form_resubmitted", summary: `New ${lead.formLabel} submission from ${SITE_HOST}`, payload: { form_id: form.id, submission_id: env.id } },
    });

    const submission = await recordFormSubmission(db, LEAD_ORG_ID, {
      formId: form.id as string,
      contactId: contact.id,
      payload: { ...env, _site: SITE_HOST, _result: { contact_id: contact.id, opportunity_id: opp.id, contact_created: contact.created, opportunity_created: opp.created } },
      attribution: { ...lead.attribution, ip_address: req.headers.get("x-forwarded-for")?.split(",")[0] || undefined },
      idempotencyKey,
    });

    await addContactTimeline(db, contact.id, "form_submitted", {
      form_id: form.id, form_name: form.name, submission_id: submission.id, site: SITE_HOST,
      submitted_fields: env.answers.map((a) => a.questionId),
    }, LEAD_ACTOR_USER_ID);

    await emitFormSubmitted(db, LEAD_ORG_ID, buildFormSubmittedPayload({
      formId: form.id as string, formName: form.name as string, formSlug: lead.slug,
      submissionId: submission.id, contactId: contact.id, opportunityId: opp.id,
      firstName: lead.firstName, lastName: lead.lastName, email: lead.email, company: lead.company,
      landingPage: `${SITE_URL}${env.source.path}`,
      fields: [["Role", lead.jobTitle ?? ""], ...lead.fields],
    }));

    // Contact form only, and only for a submission we just recorded (a replay returned above; a lost
    // race comes back duplicate). It runs after the staff notification is written, so the optional email can never cost the owner the lead alert, and it
    // never affects the response: a failed email is logged and stored.
    let ack: string | undefined;
    if (env.kind === "contact" && !submission.duplicate) {
      const payload = { ...env, _site: SITE_HOST, _result: { contact_id: contact.id, opportunity_id: opp.id, contact_created: contact.created, opportunity_created: opp.created } };
      ack = (await acknowledgeContact(db, { sendEmail: deps.sendEmail, orgId: LEAD_ORG_ID, timeoutMs: deps.sendTimeoutMs, replyTo: Deno.env.get("SITE_LEAD_REPLY_TO") || undefined }, env, contact.id, { id: submission.id, payload })).status;
    }

    console.log(`[site-lead-intake] ${lead.slug}: contact ${contact.id} (${contact.created ? "new" : "existing"}), opportunity ${opp.id} (${opp.created ? "new" : "reused"}), submission ${submission.id}`);
    return jsonResponse({ ok: true, ref: submission.id, id: submission.id, contact_id: contact.id, opportunity_id: opp.id, ...(ack ? { ack_email: ack } : {}) });
  } catch (e) {
    console.error("[site-lead-intake] failed:", e instanceof Error ? e.message : e);
    return jsonResponse({ ok: false, error: "internal error" }, 500);
  }
}
