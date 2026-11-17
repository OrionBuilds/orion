/**
 * Source gathering for the AI proposal / contract generators.
 *
 * Collects, beyond meetings (handled in the generators):
 *   - documents attached to the opportunity, the contact and linked projects (file_attachments +
 *     project_files), SAM.gov solicitation documents among them, plus files the user picked
 *     explicitly (`file_ids`) and client-side uploads;
 *   - a concise project summary (tasks, change requests, support tickets, notes).
 *
 * Text for each file comes from document_texts; missing/stale text is fetched through an injected
 * ContentFetcher (see source-content.ts) and cached there. Prompt size is bounded by per-document
 * and total caps, filled in priority order (solicitation documents first for government bids).
 *
 * Shared verbatim by proposal-ai-generate and contract-ai-generate so both stay consistent.
 */
import { extractDocumentText, normalizeMime, type ExtractionResult } from "./document-text.ts";
import { type Db, type DocumentTextRow, loadDocumentTexts, saveDocumentText } from "./document-store.ts";

export const DOC_PER_FILE_CAP = 150_000;
export const DOC_TOTAL_CAP = 600_000;
export const PROJECT_SUMMARY_CAP = 8_000;
/** Below this many characters left in the total budget a document is omitted, not stubbed. */
const MIN_USEFUL_CHARS = 2_000;
/** Bounds on fetching + extracting text that was not cached yet, per generation request. */
export const MAX_FRESH_EXTRACTIONS = 12;
export const FRESH_EXTRACTION_BUDGET_MS = 60_000;

export type DocOrigin = "solicitation" | "upload" | "selected" | "opportunity" | "project" | "contact";

export interface SourceFile {
  id: string;
  name: string;
  mime_type: string;
  provider: string | null;
  storage_path: string | null;
  /** The provider's own id (Drive file id / Graph item id / SAM key). */
  drive_file_id: string;
  user_id: string;
  size_bytes: number;
  updated_at: string | null;
  origins: DocOrigin[];
}

export interface LinkedProject {
  id: string;
  name: string;
  status: string | null;
  link: "opportunity" | "proposal" | "contact" | "selected";
}

const FILE_COLS = "id, name, mime_type, provider, storage_path, drive_file_id, user_id, size_bytes, updated_at, organization_id, is_deleted";

/** Projects tied to this deal: by opportunity or proposal (auto), by contact (offered), or explicit. */
export async function listLinkedProjects(
  db: Db,
  args: { orgId: string; opportunityId?: string | null; proposalId?: string | null; contactId?: string | null; projectIds?: string[] },
): Promise<LinkedProject[]> {
  const out = new Map<string, LinkedProject>();
  const add = (rows: unknown, link: LinkedProject["link"]) => {
    for (const p of (rows ?? []) as { id: string; name: string; status: string | null }[]) {
      if (!out.has(p.id)) out.set(p.id, { id: p.id, name: p.name, status: p.status ?? null, link });
    }
  };
  const q = () => db.from("projects").select("id, name, status").eq("org_id", args.orgId);
  if (args.projectIds?.length) add((await q().in("id", args.projectIds)).data, "selected");
  if (args.opportunityId) add((await q().eq("opportunity_id", args.opportunityId)).data, "opportunity");
  if (args.proposalId) add((await q().eq("proposal_id", args.proposalId)).data, "proposal");
  if (args.contactId) add((await q().eq("contact_id", args.contactId)).data, "contact");
  return [...out.values()];
}

/**
 * Files attached to the opportunity / contact / given projects, plus explicitly selected ids.
 * Everything is filtered to the org and to non-deleted rows; selected ids from another org are
 * silently dropped.
 */
export async function listSourceFiles(
  db: Db,
  args: {
    orgId: string;
    opportunityId?: string | null;
    contactId?: string | null;
    projectIds?: string[];
    selectedFileIds?: string[];
    includeAttached?: boolean;
    excludeFileIds?: string[];
  },
): Promise<SourceFile[]> {
  const origins = new Map<string, Set<DocOrigin>>();
  const mark = (id: string | null | undefined, o: DocOrigin) => {
    if (!id) return;
    (origins.get(id) ?? origins.set(id, new Set()).get(id)!).add(o);
  };

  // Attachment origins are always resolved (they label documents in the prompt); with
  // includeAttached === false only the explicitly selected ids are kept.
  if (args.opportunityId) {
    const { data } = await db.from("file_attachments").select("drive_file_id")
      .eq("organization_id", args.orgId).eq("entity_type", "opportunities").eq("entity_id", args.opportunityId);
    for (const r of (data ?? []) as { drive_file_id: string }[]) mark(r.drive_file_id, "opportunity");
  }
  if (args.contactId) {
    const { data } = await db.from("file_attachments").select("drive_file_id")
      .eq("organization_id", args.orgId).eq("entity_type", "contacts").eq("entity_id", args.contactId);
    for (const r of (data ?? []) as { drive_file_id: string }[]) mark(r.drive_file_id, "contact");
  }
  if (args.projectIds?.length) {
    const { data } = await db.from("project_files").select("drive_file_id")
      .eq("org_id", args.orgId).in("project_id", args.projectIds);
    for (const r of (data ?? []) as { drive_file_id: string | null }[]) mark(r.drive_file_id, "project");
  }
  const selected = new Set(args.selectedFileIds ?? []);
  if (args.includeAttached === false) {
    for (const id of [...origins.keys()]) if (!selected.has(id)) origins.delete(id);
  }
  for (const id of selected) if (!origins.has(id)) mark(id, "selected");
  for (const id of args.excludeFileIds ?? []) {
    // An explicit pick wins over an exclusion of the same id.
    if (!selected.has(id)) origins.delete(id);
  }

  const ids = [...origins.keys()];
  if (ids.length === 0) return [];
  const { data } = await db.from("drive_files").select(FILE_COLS).eq("organization_id", args.orgId).in("id", ids);
  const files: SourceFile[] = [];
  for (const f of (data ?? []) as (SourceFile & { is_deleted: boolean; organization_id: string })[]) {
    if (f.is_deleted || f.organization_id !== args.orgId) continue;
    const o = origins.get(f.id)!;
    if (f.provider === "sam_gov") o.add("solicitation");
    files.push({
      id: f.id, name: f.name, mime_type: f.mime_type, provider: f.provider ?? null, storage_path: f.storage_path ?? null,
      drive_file_id: f.drive_file_id, user_id: f.user_id, size_bytes: Number(f.size_bytes ?? 0), updated_at: f.updated_at ?? null,
      origins: [...o],
    });
  }
  // Stable order: as discovered (attachment order), solicitation docs keep notice order by name.
  return files.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

export type FetchedContent =
  | { ok: true; bytes: Uint8Array; mime: string }
  | { ok: false; status: "too_large" | "unsupported" | "failed"; error: string };

export type ContentFetcher = (file: SourceFile) => Promise<FetchedContent>;

/** Version marker for a cached extraction: SAM docs are immutable; provider files use updated_at. */
export function sourceVersion(f: SourceFile): string {
  return f.provider === "sam_gov" ? `sam:${f.size_bytes}` : `${f.provider ?? "google"}:${f.updated_at ?? ""}:${f.size_bytes}`;
}

/**
 * Returns text rows for every file, fetching + extracting (and caching) the ones with no usable
 * cached text, within MAX_FRESH_EXTRACTIONS / FRESH_EXTRACTION_BUDGET_MS. Files that could not be
 * processed in budget are absent from the map.
 */
export async function ensureDocumentTexts(
  db: Db,
  orgId: string,
  files: SourceFile[],
  fetcher: ContentFetcher,
  opts: { maxFresh?: number; budgetMs?: number; now?: () => number } = {},
): Promise<Map<string, DocumentTextRow>> {
  const now = opts.now ?? Date.now;
  const started = now();
  const cached = await loadDocumentTexts(db, orgId, files.map((f) => f.id));
  let fresh = 0;
  for (const f of files) {
    const row = cached.get(f.id);
    const version = sourceVersion(f);
    const usable = row && row.status !== "failed" && (row.source_version === version || f.provider === "sam_gov");
    if (usable) continue;
    if (fresh >= (opts.maxFresh ?? MAX_FRESH_EXTRACTIONS) || now() - started > (opts.budgetMs ?? FRESH_EXTRACTION_BUDGET_MS)) continue;
    fresh++;
    const got = await fetcher(f).catch((e): FetchedContent => ({ ok: false, status: "failed", error: String((e as Error)?.message ?? e) }));
    let result: ExtractionResult;
    let mime = f.mime_type;
    if (got.ok) {
      mime = normalizeMime(got.mime, f.name);
      result = await extractDocumentText(got.bytes, mime, f.name);
    } else {
      result = { status: got.status, text: "", pageCount: null, extractor: "none", error: got.error.slice(0, 500) };
    }
    await saveDocumentText(db, { orgId, driveFileId: f.id, result, mime, sourceVersion: version });
    cached.set(f.id, {
      drive_file_id: f.id, status: result.status, text_content: result.text, char_count: result.text.length,
      page_count: result.pageCount, error: result.error ?? null, source_version: version,
    });
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Prompt assembly (pure)
// ---------------------------------------------------------------------------

export interface PromptDoc {
  id: string;
  name: string;
  origin: DocOrigin;
  text: string;
}

export interface UsedDoc {
  id: string;
  name: string;
  origin: DocOrigin;
  chars: number;
  truncated: boolean;
}

export interface OmittedDoc {
  id: string;
  name: string;
  origin: DocOrigin;
  reason: string;
}

export interface AssembledDocs {
  docs: (UsedDoc & { text: string })[];
  used: UsedDoc[];
  omitted: OmittedDoc[];
}

const ORDER_GOV: DocOrigin[] = ["solicitation", "upload", "selected", "opportunity", "project", "contact"];
const ORDER_COMMERCIAL: DocOrigin[] = ["upload", "selected", "opportunity", "project", "contact", "solicitation"];

/** The strongest origin of a file (for ordering + labelling). */
export function primaryOrigin(origins: DocOrigin[], isGovernment: boolean): DocOrigin {
  const order = isGovernment ? ORDER_GOV : ORDER_COMMERCIAL;
  return [...origins].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? "selected";
}

/** Orders documents by priority and applies the per-document and total character caps. */
export function assembleDocuments(
  docs: PromptDoc[],
  opts: { isGovernment: boolean; perDocCap?: number; totalCap?: number },
): AssembledDocs {
  const per = opts.perDocCap ?? DOC_PER_FILE_CAP;
  let remaining = opts.totalCap ?? DOC_TOTAL_CAP;
  const order = opts.isGovernment ? ORDER_GOV : ORDER_COMMERCIAL;
  const sorted = docs
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (order.indexOf(a.d.origin) - order.indexOf(b.d.origin)) || a.i - b.i)
    .map((x) => x.d);

  const out: AssembledDocs = { docs: [], used: [], omitted: [] };
  for (const d of sorted) {
    const text = d.text.trim();
    if (!text) {
      out.omitted.push({ id: d.id, name: d.name, origin: d.origin, reason: "no text" });
      continue;
    }
    if (remaining < MIN_USEFUL_CHARS) {
      out.omitted.push({ id: d.id, name: d.name, origin: d.origin, reason: "total context cap reached" });
      continue;
    }
    const limit = Math.min(per, remaining);
    const truncated = text.length > limit;
    const kept = truncated ? text.slice(0, limit) : text;
    remaining -= kept.length;
    const used: UsedDoc = { id: d.id, name: d.name, origin: d.origin, chars: kept.length, truncated };
    out.used.push(used);
    out.docs.push({ ...used, text: kept });
  }
  return out;
}

const ORIGIN_LABEL: Record<DocOrigin, string> = {
  solicitation: "SAM.gov solicitation document",
  upload: "uploaded by the author",
  selected: "selected by the author",
  opportunity: "attached to the opportunity",
  project: "attached to the project",
  contact: "attached to the client",
};

/** Renders assembled documents as prompt text (empty string when there are none). */
export function renderDocuments(a: AssembledDocs, opts: { isGovernment: boolean; heading?: string }): string {
  if (a.docs.length === 0) return "";
  const sol = a.docs.filter((d) => d.origin === "solicitation");
  const rest = a.docs.filter((d) => d.origin !== "solicitation");
  const block = (d: AssembledDocs["docs"][number]) =>
    `\n\n--- Document: ${d.name} (${ORIGIN_LABEL[d.origin]}) ---\n${d.text}${d.truncated ? "\n[document truncated]" : ""}`;
  let s = "";
  if (sol.length > 0) {
    s += `\n\nSOLICITATION DOCUMENTS (downloaded from SAM.gov — authoritative for requirements, Section L instructions, Section M evaluation criteria, CLINs, deadlines and compliance items${opts.isGovernment ? "; follow them over any other source" : ""}):`;
    s += sol.map(block).join("");
  }
  if (rest.length > 0) {
    s += `\n\n${opts.heading ?? "Reference Documents (context for this proposal)"}:`;
    s += rest.map(block).join("");
  }
  if (a.omitted.length > 0) {
    s += `\n\n[Not included: ${a.omitted.map((o) => `${o.name} (${o.reason})`).join("; ")}]`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Project context
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string; name: string; description: string | null; status: string | null; priority: string | null;
  start_date: string | null; target_end_date: string | null; actual_end_date: string | null;
  budget_amount: number | null; actual_cost: number | null; currency: string | null; progress_percent: number | null;
  risk_level: string | null;
}

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Pure: a concise, capped project brief. */
export function summarizeProject(
  p: ProjectRow,
  tasks: { title: string; status: string | null; due_date: string | null }[],
  changes: { title: string; status: string | null; request_type: string | null; cost_impact: number | null; timeline_impact_days: number | null; description: string | null }[],
  tickets: { subject: string | null; title: string | null; status: string | null; priority: string | null; description: string | null }[],
  notes: { body: string; created_at: string }[],
  cap = PROJECT_SUMMARY_CAP,
): string {
  const lines: string[] = [];
  lines.push(`Project: ${p.name} — status ${p.status ?? "n/a"}${p.priority ? `, priority ${p.priority}` : ""}${p.risk_level ? `, risk ${p.risk_level}` : ""}`);
  const dates = [p.start_date && `start ${p.start_date}`, p.target_end_date && `target end ${p.target_end_date}`, p.actual_end_date && `ended ${p.actual_end_date}`].filter(Boolean);
  if (dates.length) lines.push(`Dates: ${dates.join(", ")}`);
  if (p.budget_amount != null) {
    lines.push(`Budget: ${p.currency ?? "USD"} ${Number(p.budget_amount).toLocaleString("en-US")}${p.actual_cost != null ? ` (spent ${Number(p.actual_cost).toLocaleString("en-US")})` : ""}${p.progress_percent != null ? `, ${p.progress_percent}% complete` : ""}`);
  }
  if (p.description) lines.push(`Description: ${clip(p.description, 1500)}`);
  if (tasks.length) {
    const done = tasks.filter((t) => ["done", "completed", "complete"].includes((t.status ?? "").toLowerCase())).length;
    lines.push(`Tasks: ${tasks.length} total, ${done} done, ${tasks.length - done} open`);
    for (const t of tasks.slice(0, 25)) lines.push(`- [${t.status ?? "?"}] ${clip(t.title, 140)}${t.due_date ? ` (due ${t.due_date})` : ""}`);
    if (tasks.length > 25) lines.push(`- … ${tasks.length - 25} more`);
  }
  if (changes.length) {
    lines.push(`Change requests (${changes.length}):`);
    for (const c of changes.slice(0, 10)) {
      const impact = [c.cost_impact != null && `cost ${c.cost_impact}`, c.timeline_impact_days != null && `+${c.timeline_impact_days}d`].filter(Boolean).join(", ");
      lines.push(`- [${c.status ?? "?"}] ${clip(c.title, 140)}${c.request_type ? ` (${c.request_type})` : ""}${impact ? ` — ${impact}` : ""}${c.description ? `: ${clip(c.description, 200)}` : ""}`);
    }
  }
  if (tickets.length) {
    lines.push(`Support tickets (${tickets.length}):`);
    for (const t of tickets.slice(0, 10)) {
      lines.push(`- [${t.status ?? "?"}${t.priority ? `/${t.priority}` : ""}] ${clip(t.subject ?? t.title ?? "Ticket", 140)}${t.description ? `: ${clip(t.description, 200)}` : ""}`);
    }
  }
  if (notes.length) {
    lines.push("Recent notes:");
    for (const n of notes.slice(0, 5)) lines.push(`- (${n.created_at.slice(0, 10)}) ${clip(n.body, 400)}`);
  }
  const text = lines.join("\n");
  const marker = "\n[project summary truncated]";
  return text.length > cap ? text.slice(0, cap - marker.length) + marker : text;
}

/** Loads and summarises the given projects (org-scoped). */
export async function loadProjectSummaries(db: Db, orgId: string, projectIds: string[]): Promise<{ id: string; name: string; text: string }[]> {
  if (projectIds.length === 0) return [];
  const { data: projects } = await db.from("projects")
    .select("id, name, description, status, priority, start_date, target_end_date, actual_end_date, budget_amount, actual_cost, currency, progress_percent, risk_level")
    .eq("org_id", orgId).in("id", projectIds);
  const out: { id: string; name: string; text: string }[] = [];
  for (const p of (projects ?? []) as ProjectRow[]) {
    const [tasks, changes, tickets, notes] = await Promise.all([
      db.from("project_tasks").select("title, status, due_date").eq("org_id", orgId).eq("project_id", p.id).order("sort_order", { ascending: true }).limit(200),
      db.from("project_change_requests").select("title, status, request_type, cost_impact, timeline_impact_days, description").eq("org_id", orgId).eq("project_id", p.id).order("created_at", { ascending: false }).limit(20),
      db.from("project_support_tickets").select("subject, title, status, priority, description").eq("org_id", orgId).eq("project_id", p.id).order("created_at", { ascending: false }).limit(20),
      db.from("project_notes").select("body, created_at").eq("org_id", orgId).eq("project_id", p.id).is("deleted_at", null).order("created_at", { ascending: false }).limit(5),
    ]);
    out.push({
      id: p.id,
      name: p.name,
      // deno-lint-ignore no-explicit-any
      text: summarizeProject(p, (tasks.data ?? []) as any[], (changes.data ?? []) as any[], (tickets.data ?? []) as any[], (notes.data ?? []) as any[]),
    });
  }
  return out;
}

export function renderProjects(projects: { name: string; text: string }[]): string {
  if (projects.length === 0) return "";
  return `\n\nPROJECT CONTEXT (existing work with this client — reflect delivered scope, open change requests and known issues):\n` +
    projects.map((p) => p.text).join("\n\n");
}

// ---------------------------------------------------------------------------
// One-call orchestration used by both generators
// ---------------------------------------------------------------------------

export interface GatherRequest {
  orgId: string;
  opportunityId?: string | null;
  contactId?: string | null;
  proposalId?: string | null;
  isGovernment: boolean;
  /** Auto-include documents attached to the opportunity / contact / linked projects (default true). */
  includeAttachedDocuments?: boolean;
  fileIds?: string[];
  excludeFileIds?: string[];
  /** Auto-include projects linked to the opportunity / proposal (default true). */
  includeLinkedProjects?: boolean;
  projectIds?: string[];
  uploadedDocuments?: { name: string; text: string }[];
  fetcher: ContentFetcher;
  /** Heading for non-solicitation documents in the prompt. */
  documentsHeading?: string;
}

export interface GatheredSources {
  documentsText: string;
  projectsText: string;
  documents: UsedDoc[];
  omittedDocuments: OmittedDoc[];
  projects: { id: string; name: string }[];
}

export async function gatherSources(db: Db, r: GatherRequest): Promise<GatheredSources> {
  const linked = await listLinkedProjects(db, {
    orgId: r.orgId,
    opportunityId: r.includeLinkedProjects === false ? null : r.opportunityId,
    proposalId: r.includeLinkedProjects === false ? null : r.proposalId,
    projectIds: r.projectIds,
  });
  const projectIds = linked.map((p) => p.id);

  const files = await listSourceFiles(db, {
    orgId: r.orgId,
    opportunityId: r.opportunityId,
    contactId: r.contactId,
    projectIds,
    selectedFileIds: r.fileIds,
    excludeFileIds: r.excludeFileIds,
    includeAttached: r.includeAttachedDocuments,
  });
  const texts = await ensureDocumentTexts(db, r.orgId, files, r.fetcher);

  const promptDocs: PromptDoc[] = [];
  const omitted: OmittedDoc[] = [];
  for (const f of files) {
    const origin = primaryOrigin(f.origins, r.isGovernment);
    const t = texts.get(f.id);
    if (!t) { omitted.push({ id: f.id, name: f.name, origin, reason: "text not extracted yet (try again)" }); continue; }
    if (t.status !== "extracted") {
      omitted.push({ id: f.id, name: f.name, origin, reason: t.status === "no_text" ? "no text layer (scanned)" : (t.error ?? t.status) });
      continue;
    }
    promptDocs.push({ id: f.id, name: f.name, origin, text: t.text_content });
  }
  for (const [i, u] of (r.uploadedDocuments ?? []).entries()) {
    if (u && typeof u.text === "string") promptDocs.push({ id: `upload-${i}`, name: String(u.name ?? `Upload ${i + 1}`), origin: "upload", text: u.text });
  }

  const assembled = assembleDocuments(promptDocs, { isGovernment: r.isGovernment });
  assembled.omitted.unshift(...omitted);
  const projects = await loadProjectSummaries(db, r.orgId, projectIds);
  return {
    documentsText: renderDocuments(assembled, { isGovernment: r.isGovernment, heading: r.documentsHeading }),
    projectsText: renderProjects(projects),
    documents: assembled.used,
    omittedDocuments: assembled.omitted,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
  };
}
