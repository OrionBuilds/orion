/**
 * caio-source-ingest — owner JWT. Uploads interview material (multipart) or acts on sources / OS meetings (JSON actions).
 *
 *   multipart: engagement_id, kind?, department?, interviewees?, consent ("true" only when the owner ticked permission), files[]
 *   JSON:      {action:"link-meeting"|"allow-source"|"block-source"|"ignore-meeting", ...}
 *
 * Text is extracted, VTT cleaned, scanned for PII (counts only), hashed (dedupe) and stored with the original in the private
 * caio-sources bucket. A source with PII flags or without consent starts 'needs_review'; nothing is processed until the owner clears it.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { extractUserContext } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { canUseClara } from "../_shared/clara/agent-thread.ts";
import { extractDocumentText, normalizeMime } from "../_shared/document-text.ts";
import { scanPii } from "../_shared/caio/pii.ts";
import {
  ALLOWED_EXT, MAX_FILES, MAX_FILE_BYTES, allowSource, blockSource, cleanVtt, fileExt, ignoreMeeting, insertSource, linkMeeting,
  processStatusFor, safeName, sha256Hex, titleFromFilename,
} from "../_shared/caio/ingest.ts";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const KINDS = ["transcript", "summary", "interview_notes", "public_research", "policy", "other"];
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "") || null;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  const db = serviceClient();
  const user = await extractUserContext(req, db);
  if (!user) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!(await canUseClara(db, user.id, denoEnv).catch(() => false))) return json({ ok: false, error: "Only the account owner can add CAIO sources" }, 403);
  const orgId = user.orgId as string;
  const now = new Date();

  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
      let r;
      switch (b.action) {
        case "link-meeting":
          r = await linkMeeting(db, { orgId, userId: user.id, engagementId: str("engagement_id"), meetingId: str("meeting_transcription_id"), consent: b.consent === true, consentNote: str("consent_note"), department: str("department"), now });
          break;
        case "allow-source": r = await allowSource(db, { orgId, userId: user.id, sourceId: str("source_id"), now }); break;
        case "block-source": r = await blockSource(db, { orgId, sourceId: str("source_id") }); break;
        case "ignore-meeting": r = await ignoreMeeting(db, { orgId, meetingId: str("meeting_transcription_id") }); break;
        default: return json({ ok: false, error: "Unknown action" }, 400);
      }
      return r.ok ? json({ ok: true, ...(r.source ? { sources: [r.source], skipped: [] } : {}) }) : json({ ok: false, error: r.error }, r.status ?? 400);
    }

    const form = await req.formData();
    const engagementId = String(form.get("engagement_id") ?? "");
    const { data: eng } = await db.from("caio_engagements").select("id, process_personal_data").eq("id", engagementId).eq("org_id", orgId).maybeSingle();
    if (!eng) return json({ ok: false, error: "Engagement not found" }, 404);
    const kind = KINDS.includes(String(form.get("kind"))) ? String(form.get("kind")) : "transcript";
    const consent = String(form.get("consent") ?? "") === "true";
    const department = clip(form.get("department"), 120), interviewees = clip(form.get("interviewees"), 300);
    const files = form.getAll("files[]").concat(form.getAll("files")).filter((f): f is File => f instanceof File);
    if (!files.length) return json({ ok: false, error: "No files" }, 400);

    const sources: unknown[] = [], skipped: { filename: string; reason: string }[] = [];
    for (const f of files.slice(0, MAX_FILES)) {
      const name = f.name || "file";
      const ext = fileExt(name);
      if (!ALLOWED_EXT.includes(ext)) { skipped.push({ filename: name, reason: "unsupported file type" }); continue; }
      if (f.size > MAX_FILE_BYTES) { skipped.push({ filename: name, reason: "larger than 25 MB" }); continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      let text = "", noText = false;
      if (ext === "vtt" || ext === "txt" || ext === "md") text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      else {
        const x = await extractDocumentText(bytes, normalizeMime(f.type, name), name);
        text = x.text; noText = x.status !== "extracted";
        if (x.status === "failed" || x.status === "unsupported" || x.status === "too_large") { skipped.push({ filename: name, reason: "could not read this file" }); continue; }
      }
      text = ext === "vtt" || /^\s*WEBVTT/.test(text) ? cleanVtt(text) : text.replace(/\r\n?/g, "\n").trim();
      noText = noText || !text.trim();
      const pii = scanPii(text);
      const path = `${orgId}/${engagementId}/${crypto.randomUUID()}-${safeName(name)}`;
      const up = await db.storage.from("caio-sources").upload(path, bytes, { contentType: f.type || "application/octet-stream", upsert: false });
      if (up.error) { skipped.push({ filename: name, reason: "could not store the original" }); continue; }
      const r = await insertSource(db, {
        org_id: orgId, engagement_id: engagementId, kind, title: titleFromFilename(name), department, interviewees,
        text_content: text, text_hash: await sha256Hex(text), pii_flags: pii, storage_path: path, original_filename: safeName(name), mime: f.type || null,
        process_status: processStatusFor({ pii, consent, fromMeeting: false, attested: false, allowPersonalData: Boolean((eng as { process_personal_data?: boolean } | null)?.process_personal_data) }),
        consent_attested_by: consent ? user.id : null, consent_attested_at: consent ? now.toISOString() : null,
        extraction_status: noText ? "no_text" : "pending",
      });
      if (r.source) sources.push(r.source);
      else {
        await db.storage.from("caio-sources").remove([path]).catch(() => {});
        skipped.push({ filename: name, reason: r.duplicate ? "already added" : "could not save" });
      }
    }
    for (const f of files.slice(MAX_FILES)) skipped.push({ filename: f.name, reason: "more than 10 files" });
    return json({ ok: true, sources, skipped });
  } catch (e) {
    console.error("[caio-source-ingest]", (e as Error).message.slice(0, 200));
    return json({ ok: false, error: "Something went wrong" }, 500);
  }
});
