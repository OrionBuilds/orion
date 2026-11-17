/**
 * signature-send — send a proposal or contract for e-signature.
 *
 * Server-side equivalent of the client-orchestrated flow
 * (freeze -> createSignatureRequest -> sendSignatureRequestEmail), so agents /
 * the MCP server can trigger e-signature without the browser. Handles both
 * proposals and contracts and three modes: send (default), resend, void.
 *
 * The signing token is 32 random bytes as hex; only its SHA-256 hash is stored
 * (access_token_hash), matching how the public sign pages verify it.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ProposalReviewError, type ReviewFlag, reviewProposalSections, unacknowledgedFlags } from "../_shared/proposal-review.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getResendEnvCreds } from "../_shared/resend.ts";
import { sendOrgEmail } from "../_shared/email-defaults.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const APP_URL =
  Deno.env.get("APP_BASE_URL") ||
  Deno.env.get("APP_URL") ||
  Deno.env.get("PUBLIC_SITE_URL") ||
  "https://app.example.com";

type DocType = "proposal" | "contract";

interface DocConfig {
  docTable: string;
  reqTable: string;
  auditTable: string;
  fk: string;
  sectionsTable: string;
  lineItemsTable: string | null;
  setStatusSent: boolean;
}

const CONFIG: Record<DocType, DocConfig> = {
  proposal: {
    docTable: "proposals",
    reqTable: "proposal_signature_requests",
    auditTable: "proposal_audit_events",
    fk: "proposal_id",
    sectionsTable: "proposal_sections",
    lineItemsTable: "proposal_line_items",
    setStatusSent: true,
  },
  contract: {
    docTable: "contracts",
    reqTable: "contract_signature_requests",
    auditTable: "contract_audit_events",
    fk: "contract_id",
    sectionsTable: "contract_sections",
    lineItemsTable: null,
    setStatusSent: false,
  },
};

interface Payload {
  document_type: DocType;
  document_id: string;
  signer_name?: string;
  signer_email?: string;
  expires_in_days?: number;
  mode?: "send" | "resend" | "void";
  /** Keys (flagKey) of the proposal review flags a person has seen and is sending anyway. Anything newer is not covered. */
  acknowledged_flags?: string[];
}

/** JSON with object keys sorted recursively: jsonb storage reorders keys, so two equal values must still compare equal. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomTokenHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  let body: Payload;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const docType = body.document_type;
  if (docType !== "proposal" && docType !== "contract") {
    return json({ error: "document_type must be 'proposal' or 'contract'" }, 400);
  }
  if (!body.document_id) return json({ error: "document_id is required" }, 400);
  const cfg = CONFIG[docType];
  const mode = body.mode ?? "send";
  // Reject any unsupported mode up front so a malformed or newer caller cannot fall through to the
  // default SEND block and bypass the proposal review gate.
  if (mode !== "send" && mode !== "resend" && mode !== "void") {
    return json({ error: "mode must be 'send', 'resend' or 'void'" }, 400);
  }

  // Identify the calling user (for created_by + org scoping).
  const anon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data: { user }, error: authErr } = await anon.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: userRow } = await supabase
    .from("users")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  const userOrgId = userRow?.organization_id;
  if (!userOrgId) return json({ error: "User has no organization" }, 403);

  // Load the document and confirm it belongs to the caller's org.
  const { data: doc, error: docErr } = await supabase
    .from(cfg.docTable)
    .select("id, org_id, title, total_value, currency, contact_id")
    .eq("id", body.document_id)
    .maybeSingle();
  if (docErr || !doc) return json({ error: `${docType} not found` }, 404);
  if (doc.org_id !== userOrgId) return json({ error: "Forbidden" }, 403);

  const orgId = doc.org_id as string;

  try {
    // ── VOID ──────────────────────────────────────────────────────────────
    if (mode === "void") {
      // A signed document is final: refuse before touching the request (the database refuses the status change too).
      const { data: cur } = await supabase.from(cfg.docTable).select("signature_status").eq("id", doc.id).maybeSingle();
      if (cur && cur.signature_status === "signed") {
        return json({ error: "A signed document cannot be voided.", code: "already_signed" }, 409);
      }
      const { data: latest } = await supabase
        .from(cfg.reqTable)
        .select("id")
        .eq(cfg.fk, doc.id)
        .not("status", "in", "(voided,signed)")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latest) {
        // Conditional on the request not being signed: a signer finalizing between the check above and this write must
        // win, and zero matched rows means exactly that.
        const { data: voidedReq, error: voidReqErr } = await supabase
          .from(cfg.reqTable)
          .update({ status: "voided" })
          .eq("id", latest.id)
          .not("status", "in", "(voided,signed)")
          .select("id");
        if (voidReqErr) return json({ error: `Could not void the signature request: ${voidReqErr.message}` }, 500);
        if (!voidedReq || voidedReq.length === 0) {
          return json({ error: "The signature request was signed or changed while voiding; nothing was voided.", code: "already_signed" }, 409);
        }
      }
      const { error: voidDocErr } = await supabase.from(cfg.docTable).update({ signature_status: "voided" }).eq("id", doc.id);
      if (voidDocErr) return json({ error: `Could not void the document: ${voidDocErr.message}` }, 500);
      await audit(supabase, cfg, doc.id, orgId, "voided", user.id, { request_id: latest?.id ?? null });
      return json({ ok: true, mode: "void", request_id: latest?.id ?? null });
    }

    // Money documents are not sent OR resent with unresolved NEEDS PRICING / CONFIRM SCOPE markers or a pricing
    // table that does not add up, unless a person acknowledged exactly these flags (recorded in the audit log).
    let reviewFlags: ReviewFlag[] = [];
    // The rows the gate reviewed are the rows the snapshot is built from, so an edit saved in between cannot be sent unreviewed.
    let reviewedSections: Array<Record<string, unknown>> | null = null;
    if (docType === "proposal" && (mode === "send" || mode === "resend")) {
      const { data: gateSections, error: gateErr } = await supabase
        .from(cfg.sectionsTable)
        .select("title, content, section_type, sort_order")
        .eq(cfg.fk, doc.id)
        .order("sort_order", { ascending: true });
      // Fail closed: a failed read must never be treated as a proposal with no sections (and therefore no
      // flags), which would let an unreviewed proposal through the server-side gate.
      if (gateErr) return json({ error: `Could not load proposal sections for review: ${gateErr.message}` }, 500);
      reviewedSections = gateSections || [];
      reviewFlags = reviewProposalSections((gateSections || []).map((s) => ({ title: String(s.title ?? ""), content: String(s.content ?? "") })));
      const open = unacknowledgedFlags(reviewFlags, body.acknowledged_flags);
      if (open.length > 0) {
        return json({ error: new ProposalReviewError(open).message, code: "review_flags", flags: open }, 409);
      }
      if (reviewFlags.length > 0) {
        // The acknowledgment must be on record before anything is sent.
        const ack = await supabase.from(cfg.auditTable).insert({
          org_id: orgId, [cfg.fk]: doc.id, event_type: "review_flags_acknowledged", actor_type: "user", actor_id: user.id,
          metadata: { flags: reviewFlags },
        });
        if (ack.error) return json({ error: `Could not record the review acknowledgment: ${ack.error.message}` }, 500);
      }
    }

    // Once the document is locked (signature_status set, so edits are refused), review the live sections again before
    // anything is emailed: a save that landed between the gate query and the lock must not reach the signer
    // unreviewed. On a finding the request is voided, which also makes the proposal editable again.
    // Compensation for a request that must not go out. Always conditional: a signer may finalize at any moment, and a
    // signed request must never be overwritten. Returns a Response when the caller must stop with it instead of its own
    // (the request was signed meanwhile, or the void itself failed and the request id is reported so it can be voided by
    // hand), null when the request is voided. `alsoDoc` also voids the (already locked) document.
    const compensate = async (requestId: string, reason: string, alsoDoc: boolean): Promise<Response | null> => {
      const { data: rows, error: voidErr } = await supabase
        .from(cfg.reqTable)
        .update({ status: "voided" })
        .eq("id", requestId)
        .not("status", "in", "(voided,signed)")
        .select("id");
      if (voidErr) {
        return json({
          error: `Could not void signature request ${requestId} (${voidErr.message}). Nothing was sent, but the request is still live: void it from the document page before sending again.`,
          code: "cleanup_failed", request_id: requestId,
        }, 500);
      }
      if (!rows || rows.length === 0) {
        return json({ error: "The signature request was signed or changed while it was being checked; nothing was changed.", code: "already_signed" }, 409);
      }
      if (alsoDoc) {
        const { error: docVoidErr } = await supabase.from(cfg.docTable).update({ signature_status: "voided" }).eq("id", doc.id);
        if (docVoidErr) {
          // The database refuses to change a signed document's status: the signer finalized after the request void above.
          // Do not report the original reason or audit a void that did not happen.
          console.error("[signature-send] could not void the document after voiding the request:", docVoidErr.message);
          return json({
            error: "The document changed state while it was being checked (it may have just been signed); nothing was sent. Check its signature status.",
            code: "already_signed", request_id: requestId,
          }, 409);
        }
      }
      await audit(supabase, cfg, doc.id, orgId, "voided", user.id, { request_id: requestId, reason });
      return null;
    };

    type Frozen = {
      hash?: string;
      lineItems?: unknown[];
      sections?: Array<Record<string, unknown>>;
      header?: { title: unknown; total_value: unknown; currency: unknown; valid_until?: unknown };
      /** Resend only: the frozen snapshot may come from the browser flow, so compare content too, and ignore line-item order
       *  (older snapshots did not store it). */
      resend?: boolean;
      /** Resend of a legacy snapshot whose line items carry no sort_order. */
      ignoreItemOrder?: boolean;
    };
    const reviewAfterLock = async (requestId: string, frozen: Frozen = {}): Promise<Response | null> => {
      const expectedHash = frozen.hash;
      const expectedLineItems = frozen.lineItems;
      if (docType !== "proposal") return null;
      const { data: liveSections, error: liveErr } = await supabase
        .from(cfg.sectionsTable)
        .select("title, content, section_type, sort_order")
        .eq(cfg.fk, doc.id)
        .order("sort_order", { ascending: true });
      const open = liveErr
        ? null
        : unacknowledgedFlags(
          reviewProposalSections((liveSections || []).map((s) => ({ title: String(s.title ?? ""), content: String(s.content ?? "") }))),
          body.acknowledged_flags,
        );
      if (liveErr || (open && open.length > 0)) {
        const aborted = await compensate(requestId, "review_after_lock", true);
        if (aborted) return aborted;
        if (liveErr) return json({ error: "Could not re-check the proposal after locking it; nothing was sent." }, 500);
        return json({ error: new ProposalReviewError(open!).message, code: "review_flags", flags: open }, 409);
      }
      if (expectedLineItems && cfg.lineItemsTable) {
        // The signer RPC returns the live line items, so they must still equal what was frozen (compared as an
        // order-independent set). They are immutable now that the proposal is locked.
        const { data: liveItems, error: itemsErr } = await supabase
          .from(cfg.lineItemsTable)
          .select("name, description, quantity, unit_price, discount_percent, sort_order")
          .eq(cfg.fk, doc.id);
        const canon = (xs: unknown[]) => JSON.stringify(xs.map((x) => {
          const { sort_order: _order, ...rest } = x as Record<string, unknown>;
          return stableStringify(frozen.ignoreItemOrder ? rest : x);
        }).sort());
        if (itemsErr || canon(liveItems || []) !== canon(expectedLineItems)) {
          const aborted = await compensate(requestId, itemsErr ? "line_items_check_failed" : "line_items_changed_after_freeze", true);
          if (aborted) return aborted;
          if (itemsErr) return json({ error: "Could not re-check the proposal after locking it; nothing was sent." }, 500);
          return json({ error: "The proposal changed while it was being sent. Review it and send it again.", code: "proposal_changed" }, 409);
        }
      }
      if (frozen.sections) {
        // The signer RPC returns each section's live type and order, which the content hash does not cover.
        const meta = (xs: Array<Record<string, unknown>>) =>
          JSON.stringify(xs.map((x) => JSON.stringify(frozen.resend
            ? { t: x.title, ty: x.section_type, o: x.sort_order, c: x.content }
            : { t: x.title, ty: x.section_type, o: x.sort_order })).sort());
        if (meta((liveSections || []) as Array<Record<string, unknown>>) !== meta(frozen.sections)) {
          const aborted = await compensate(requestId, "section_metadata_changed_after_freeze", true);
          if (aborted) return aborted;
          return json({ error: "The proposal changed while it was being sent. Review it and send it again.", code: "proposal_changed" }, 409);
        }
      }
      if (frozen.header) {
        const withValidUntil = "valid_until" in (frozen.header as Record<string, unknown>);
        const { data: liveDoc, error: headerErr } = await supabase.from(cfg.docTable).select((withValidUntil ? "title, total_value, currency, valid_until" : "title, total_value, currency") as string).eq("id", doc.id).maybeSingle();
        const h = (x: Record<string, unknown> | null | undefined) =>
          JSON.stringify([x?.title ?? null, String(x?.total_value ?? ""), x?.currency ?? null, withValidUntil ? (x?.valid_until ?? null) : null]);
        if (headerErr || !liveDoc || h(liveDoc as unknown as Record<string, unknown>) !== h(frozen.header as Record<string, unknown>)) {
          const aborted = await compensate(requestId, headerErr ? "header_check_failed" : "header_changed_after_freeze", true);
          if (aborted) return aborted;
          if (headerErr) return json({ error: "Could not re-check the proposal after locking it; nothing was sent." }, 500);
          return json({ error: "The proposal changed while it was being sent. Review it and send it again.", code: "proposal_changed" }, 409);
        }
      }
      if (expectedHash) {
        // The snapshot was frozen before the lock; an edit in between would leave it stale. The rows are now immutable,
        // so rebuild the snapshot from them and require it to match what was frozen.
        const rebuilt = `<div class="signed-document">${(liveSections || [])
          .map((s) => `<section><h2>${escapeHtml(String(s.title ?? ""))}</h2>${String(s.content ?? "")}</section>`)
          .join("")}</div>`;
        if ((await sha256Hex(rebuilt)) !== expectedHash) {
          const aborted = await compensate(requestId, "changed_after_freeze", true);
          if (aborted) return aborted;
          return json({ error: "The proposal changed while it was being sent. Review it and send it again.", code: "proposal_changed" }, 409);
        }
      }
      return null;
    };

    // ── RESEND ────────────────────────────────────────────────────────────
    if (mode === "resend") {
      const { data: latest } = await supabase
        .from(cfg.reqTable)
        .select("id, signer_name, signer_email, access_token_hash, viewed_at, status")
        .eq(cfg.fk, doc.id)
        .not("status", "in", "(voided,signed)")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!latest) return json({ error: "No active signature request to resend" }, 404);

      // A resend re-locks a proposal that may have been edited since it was frozen (a declined request leaves it
      // editable). The signer RPC reads live rows, so they must still equal the stored snapshot. Load it before
      // changing anything and fail closed: without a snapshot there is nothing to validate against.
      let resendFrozen: Frozen = {};
      if (docType === "proposal") {
        const { data: snap, error: snapErr } = await supabase.from(cfg.docTable).select("frozen_json_snapshot").eq("id", doc.id).maybeSingle();
        const fj = (snap?.frozen_json_snapshot || null) as Record<string, unknown> | null;
        if (snapErr || !fj) {
          return json({ error: "Could not verify the proposal against its frozen snapshot; nothing was resent. Void the request and send again." }, snapErr ? 500 : 409);
        }
        const items = (fj.line_items as unknown[] | undefined) ?? undefined;
        resendFrozen = {
          resend: true,
          sections: fj.sections as Array<Record<string, unknown>> | undefined,
          lineItems: items,
          // Order is compared whenever the snapshot recorded it; only a legacy snapshot without sort_order ignores it.
          ignoreItemOrder: Array.isArray(items) && items.length > 0 && !("sort_order" in (items[0] as Record<string, unknown>)),
          header: {
            title: fj.title, total_value: fj.total_value, currency: fj.currency,
            ...("valid_until" in fj ? { valid_until: fj.valid_until } : {}),
          },
        };
      }

      const raw = randomTokenHex();
      const hash = await sha256Hex(raw);
      const { data: rotated, error: rotateErr } = await supabase
        .from(cfg.reqTable)
        .update({ access_token_hash: hash, viewed_at: null, status: "pending" })
        .eq("id", latest.id)
        .not("status", "in", "(voided,signed)")
        .select("id");
      if (rotateErr || !rotated || rotated.length === 0) {
        // The one-live-request index (a fresh send won) or a signature/void in between: nothing was changed, nothing is sent.
        return json({
          error: rotateErr?.code === "23505"
            ? "Another signature request is already live for this proposal. Nothing was resent."
            : "The signature request changed while resending. Nothing was resent.",
          code: "resend_conflict",
        }, 409);
      }
      const docUpdate: Record<string, unknown> = { signature_status: "pending_signature" };
      if (cfg.setStatusSent) docUpdate.status = "sent";
      const { error: relockErr } = await supabase.from(cfg.docTable).update(docUpdate).eq("id", doc.id);
      if (relockErr) {
        // Put the request back exactly as it was: nothing was sent and the slot it held must not leak.
        // Only while the request still carries the token this resend rotated in: if a signer finalized in between, the
        // request is signed and must not be overwritten.
        await supabase
          .from(cfg.reqTable)
          .update({ access_token_hash: latest.access_token_hash, viewed_at: latest.viewed_at, status: latest.status })
          .eq("id", latest.id)
          .eq("access_token_hash", hash)
          .eq("status", "pending");
        return json({ error: `Could not lock the document for signing: ${relockErr.message}` }, 500);
      }
      const blockedResend = await reviewAfterLock(latest.id, resendFrozen);
      if (blockedResend) return blockedResend;
      await audit(supabase, cfg, doc.id, orgId, "resent", user.id, { request_id: latest.id });

      const signingUrl = `${APP_URL}/sign/${docType}/${latest.id}?token=${encodeURIComponent(raw)}`;
      const email = await sendEmail(supabase, cfg, orgId, latest.id, {
        signerName: latest.signer_name || "there",
        signerEmail: latest.signer_email,
        title: doc.title || "Document",
        signingUrl,
      });
      return json({ ok: true, mode: "resend", request_id: latest.id, signing_url: signingUrl, email });
    }

    // ── SEND (default) ────────────────────────────────────────────────────
    if (docType === "proposal") {
      // A proposal already out for signature (or signed) is resent or voided, never sent again: the database lock
      // would refuse the freeze, and a second live request on a signed proposal must never exist.
      const { data: cur } = await supabase.from(cfg.docTable).select("signature_status").eq("id", doc.id).maybeSingle();
      if (cur && ["pending_signature", "viewed", "signed"].includes(String(cur.signature_status))) {
        return json({ error: "This proposal is already out for signature. Resend or void the request instead.", code: "already_sent" }, 409);
      }
    }
    if (!body.signer_email) return json({ error: "signer_email is required to send" }, 400);
    const signerName = body.signer_name || "there";
    const signerEmail = body.signer_email;
    const expiresInDays = body.expires_in_days ?? 14;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    // Freeze: snapshot the sections + a document hash. The public sign pages
    // render live sections and only use frozen_html_snapshot for the hash, so a
    // deterministic concatenation is self-consistent.
    const sectionList = reviewedSections ?? (await supabase
      .from(cfg.sectionsTable)
      .select("title, content, section_type, sort_order")
      .eq(cfg.fk, doc.id)
      .order("sort_order", { ascending: true })).data ?? [];

    const htmlSnapshot = `<div class="signed-document">${sectionList
      .map((s) => `<section><h2>${escapeHtml(String(s.title ?? ""))}</h2>${String(s.content ?? "")}</section>`)
      .join("")}</div>`;
    const documentHash = await sha256Hex(htmlSnapshot);
    const jsonSnapshot: Record<string, unknown> = {
      title: doc.title,
      total_value: doc.total_value,
      currency: doc.currency,
      sections: sectionList,
    };
    if (cfg.lineItemsTable) {
      const { data: lineItems } = await supabase
        .from(cfg.lineItemsTable)
        .select("name, description, quantity, unit_price, discount_percent, sort_order")
        .eq(cfg.fk, doc.id);
      jsonSnapshot.line_items = lineItems || [];
    }
    // Create the signature request.
    const raw = randomTokenHex();
    const hash = await sha256Hex(raw);
    const { data: request, error: reqErr } = await supabase
      .from(cfg.reqTable)
      .insert({
        org_id: orgId,
        [cfg.fk]: doc.id,
        contact_id: doc.contact_id ?? null,
        signer_name: signerName,
        signer_email: signerEmail,
        access_token_hash: hash,
        status: "pending",
        expires_at: expiresAt.toISOString(),
        created_by_user_id: user.id,
      })
      .select("id")
      .single();
    if (reqErr) {
      // The unique index on live requests is the mutex: a concurrent send for the same proposal lost the race.
      if ((reqErr as { code?: string }).code === "23505") {
        return json({ error: "This proposal is already out for signature. Resend or void the request instead.", code: "already_sent" }, 409);
      }
      throw reqErr;
    }

    const { error: freezeErr } = await supabase
      .from(cfg.docTable)
      .update({
        frozen_html_snapshot: htmlSnapshot,
        frozen_json_snapshot: jsonSnapshot,
        frozen_document_hash: documentHash,
      })
      .eq("id", doc.id);
    if (freezeErr) {
      const aborted = await compensate(request.id, "freeze_failed", false);
      if (aborted) return aborted;
      return json({ error: `Could not freeze the document: ${freezeErr.message}` }, 500);
    }


    const docUpdate: Record<string, unknown> = {
      signature_status: "pending_signature",
      expires_at: expiresAt.toISOString(),
      signature_request_id: request.id,
      signer_name: signerName,
      signer_email: signerEmail,
    };
    if (cfg.setStatusSent) docUpdate.status = "sent";
    const { error: lockErr } = await supabase.from(cfg.docTable).update(docUpdate).eq("id", doc.id);
    if (lockErr) {
      // Nothing is sent on a request that is not backed by a locked document.
      const aborted = await compensate(request.id, "lock_failed", false);
      if (aborted) return aborted;
      return json({ error: `Could not lock the document for signing: ${lockErr.message}` }, 500);
    }

    const blockedSend = await reviewAfterLock(request.id, {
      hash: documentHash,
      lineItems: jsonSnapshot.line_items as unknown[] | undefined,
      sections: sectionList as Array<Record<string, unknown>>,
      header: { title: doc.title, total_value: doc.total_value, currency: doc.currency },
    });
    if (blockedSend) return blockedSend;

    await audit(supabase, cfg, doc.id, orgId, "sent_for_signature", user.id, {
      signer_name: signerName,
      signer_email: signerEmail,
      expires_at: expiresAt.toISOString(),
    });

    const signingUrl = `${APP_URL}/sign/${docType}/${request.id}?token=${encodeURIComponent(raw)}`;
    const email = await sendEmail(supabase, cfg, orgId, request.id, {
      signerName,
      signerEmail,
      title: doc.title || "Document",
      signingUrl,
      contactId: (doc.contact_id as string | null) ?? null,
    });

    return json({
      ok: true,
      mode: "send",
      request_id: request.id,
      signing_url: signingUrl,
      expires_at: expiresAt.toISOString(),
      email,
    });
  } catch (err) {
    console.error("[signature-send] Error:", err);
    return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

async function audit(
  supabase: ReturnType<typeof createClient>,
  cfg: DocConfig,
  docId: string,
  orgId: string,
  eventType: string,
  actorId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await supabase.from(cfg.auditTable).insert({
      org_id: orgId,
      [cfg.fk]: docId,
      event_type: eventType,
      actor_type: "user",
      actor_id: actorId,
      metadata,
    });
  } catch (e) {
    console.warn("[signature-send] audit insert failed:", (e as Error).message);
  }
}

async function sendEmail(
  supabase: ReturnType<typeof createClient>,
  cfg: DocConfig,
  orgId: string,
  requestId: string,
  p: { signerName: string; signerEmail: string; title: string; signingUrl: string; contactId?: string | null },
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const creds = getResendEnvCreds();
  if (!creds) {
    await setSendStatus(supabase, cfg, requestId, "failed", undefined, "Resend not configured");
    return { success: false, error: "Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL)" };
  }

  // Org Email Services Defaults (from, reply-to). A signature request is transactional: no
  // unsubscribe link and never blocked by a marketing suppression.
  const html = buildEmailHtml(p);
  const result = await sendOrgEmail(supabase, orgId, {
    contactId: p.contactId ?? null,
    to: p.signerEmail,
    toName: p.signerName,
    subject: `Please review and sign: ${p.title}`,
    html,
    categories: ["signature_request"],
    transactional: true,
  });

  await setSendStatus(
    supabase,
    cfg,
    requestId,
    result.ok ? "sent" : "failed",
    result.messageId,
    result.error,
  );
  return { success: result.ok, messageId: result.messageId, error: result.error };
}

async function setSendStatus(
  supabase: ReturnType<typeof createClient>,
  cfg: DocConfig,
  requestId: string,
  status: "sent" | "failed",
  messageId?: string,
  error?: string,
): Promise<void> {
  try {
    const update: Record<string, unknown> = {
      send_status: status,
      provider_message_id: messageId ?? null,
      send_error: status === "failed" ? (error ?? "Unknown error") : null,
    };
    if (status === "sent") update.last_sent_at = new Date().toISOString();
    await supabase.from(cfg.reqTable).update(update).eq("id", requestId);
  } catch (e) {
    // send-status columns are best-effort; don't fail the send over them.
    console.warn("[signature-send] send-status update skipped:", (e as Error).message);
  }
}

function buildEmailHtml(p: { signerName: string; title: string; signingUrl: string }): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <h1 style="font-size:20px;margin:0 0 16px;">Signature requested</h1>
    <p style="font-size:15px;line-height:1.5;margin:0 0 8px;">Hi ${escapeHtml(p.signerName)},</p>
    <p style="font-size:15px;line-height:1.5;margin:0 0 24px;">You've been asked to review and sign <strong>${escapeHtml(p.title)}</strong>.</p>
    <p style="margin:0 0 28px;">
      <a href="${p.signingUrl}" style="display:inline-block;background:#0891b2;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Review &amp; sign</a>
    </p>
    <p style="font-size:12px;color:#64748b;line-height:1.5;margin:0;">If the button doesn't work, copy and paste this link:<br>${p.signingUrl}</p>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
