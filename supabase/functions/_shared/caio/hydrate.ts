/**
 * CAIO document hydration: the PURE half of generation (no db, no model).
 *
 * A template (or an existing draft, when merging) holds bold placeholders `<strong>[NAME]</strong>`. The class of
 * each name comes from caio_placeholder_defs. This module fills the deterministic classes (engagement, computed,
 * fact (confirmed only), register incl. row / form-table expansion) as marked, escaped values, and reports what
 * is left: the unresolved names and the `llm` targets for the narrative step. `human` placeholders are never
 * filled. Text outside placeholders is never changed (rows and form tables are only DUPLICATED, never edited).
 *
 * Marks: <mark data-auto="NAME[#n]" data-resolver data-conf data-ref>VALUE</mark>. The mark id is the
 * placeholder name; the 2nd, 3rd... occurrence in one document is NAME#2, NAME#3 (first free id, so ids stay
 * stable when earlier values were confirmed). The UI confirms a mark by replacing it with its plain value.
 *
 * Merge (regenerate a draft): pass the existing body as `html` plus `existingFields`. Marks whose field row is
 * 'auto' are refreshed (or reverted to the placeholder when the source no longer supports them); confirmed or
 * edited text, and anything the owner typed, is left alone. Rows/tables that were expanded carry `data-rec`
 * (and their register marks carry `data-ref="record:KEY"`), so a regenerate never expands them twice.
 */

export type Resolver = "engagement" | "computed" | "register" | "fact" | "llm" | "human";
export type Confidence = "high" | "medium" | "low";

export interface PlaceholderDef { name: string; resolver: Resolver; target: string }
export interface EngagementInfo {
  client_legal_name?: string | null; engagement_code?: string | null; register_owner?: string | null; executive_sponsor?: string | null;
  [k: string]: unknown;
}
export interface FactInput { id?: string; fact_key: string; value: string; status: string; source_id?: string | null }
export interface RecordInput {
  id: string; register_key: string; record_key: string | null; system_key: string | null; data: Record<string, unknown>;
}
export interface ExistingField { mark_id: string; placeholder?: string; status: "auto" | "confirmed" | "edited" | "rejected" }

export interface HydrateInput {
  /** Template body, or the existing draft body when merging. */
  html: string;
  defs: PlaceholderDef[];
  engagement: EngagementInfo;
  facts: FactInput[];
  records: RecordInput[];
  /** The template's `feeds` (register keys): preferred first when a register placeholder has several candidates. */
  feeds?: string[];
  systemKey?: string | null;
  /** UTC date, YYYY-MM-DD. */
  today: string;
  docVersion: number;
  docStatus?: string;
  /** register_key -> field keys that are ids (fall back to record_key when the data lacks them). */
  idFields?: Record<string, string[]>;
  /** Presence means the html is an existing draft: field rows decide which marks may be refreshed. */
  existingFields?: ExistingField[];
  /** Merge only: also revert unconfirmed llm marks to placeholders so the narrative step redrafts them. */
  refreshLlm?: boolean;
}

export interface Fill {
  markId: string; placeholder: string; value: string; resolver: Exclude<Resolver, "human">;
  sourceRef: string; sourceIds: string[]; confidence: Confidence;
}
export interface LlmTarget {
  name: string; markId: string;
  /** Index among the bold `[NAME]` placeholders of the returned html (see applyNarrative). */
  occurrence: number;
  /** Nearest label and heading, so the model knows what the slot is for. */
  hint: string;
}
export interface HydrateResult {
  html: string; fills: Fill[];
  unresolved: { name: string; resolver: string }[];
  llmTargets: LlmTarget[];
}

const NAME_CHARS = "[A-Z0-9][A-Z0-9 /&'.,()-]*";
const bold = () => new RegExp(`<(strong|b)>\\s*\\[(${NAME_CHARS})\\]\\s*</\\1>`, "g");
const markRe = () => /<mark\b[^>]*\bdata-auto="[^"]*"[^>]*>[\s\S]*?<\/mark>/g;
const combined = () => new RegExp(`<mark\\b[^>]*\\bdata-auto="[^"]*"[^>]*>[\\s\\S]*?</mark>|<(strong|b)>\\s*\\[(${NAME_CHARS})\\]\\s*</\\1>`, "g");

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
};
const unescapeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Port of caio_has_secret (migration 20261105100000). */
export function hasSecret(p: string): boolean {
  return /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9/+_.-]{12,})/i.test(p);
}

/** Plain text of an html fragment (marks included as their value). */
export function htmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

interface Resolved { value: string; ref: string; sourceIds: string[]; confidence: Confidence }

const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !Array.isArray(v)) return null;
  const s = (Array.isArray(v) ? v.filter((x) => x !== null && typeof x !== "object").join(", ") : String(v)).replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/^\[[^\]]*\]$/.test(s)) return null;   // a prompt, not a value
  if (hasSecret(s)) return null;
  return s;
};

function parseRegisterTarget(target: string): { reg: string; field: string }[] {
  return target.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
    const i = t.indexOf(".");
    return i > 0 ? { reg: t.slice(0, i), field: t.slice(i + 1) } : { reg: "", field: "" };
  }).filter((c) => c.reg && c.field);
}

const mark = (id: string, r: Exclude<Resolver, "human">, conf: Confidence, ref: string, value: string) =>
  `<mark data-auto="${escapeHtml(id)}" data-resolver="${r}" data-conf="${conf}" data-ref="${escapeHtml(ref)}">${escapeHtml(value)}</mark>`;

const recKey = (r: RecordInput) => r.record_key ?? r.id;

export function hydrate(input: HydrateInput): HydrateResult {
  const defs = new Map(input.defs.map((d) => [d.name, d]));
  const feeds = input.feeds ?? [];
  const confirmed = new Map(input.facts.filter((f) => f.status === "confirmed").map((f) => [f.fact_key, f]));
  const systemKey = input.systemKey ?? null;
  const fieldStatus = new Map((input.existingFields ?? []).map((f) => [f.mark_id, f.status]));
  const merging = input.existingFields !== undefined;

  // ── record scope ────────────────────────────────────────────────────────────────────────
  const byReg = new Map<string, RecordInput[]>();
  for (const r of input.records) { if (!byReg.has(r.register_key)) byReg.set(r.register_key, []); byReg.get(r.register_key)!.push(r); }
  const scoped = (reg: string): RecordInput[] => {
    const all = byReg.get(reg) ?? [];
    if (!systemKey) return all;
    if (reg === "ai_systems") return all.filter((r) => r.record_key === systemKey || r.system_key === systemKey);
    // a register that carries system keys is narrowed to this system; one that does not is shared
    return all.some((r) => r.system_key) ? all.filter((r) => r.system_key === systemKey) : all;
  };
  const feedRank = (reg: string) => { const i = feeds.indexOf(reg); return i < 0 ? 999 : i; };
  const candidates = (def: PlaceholderDef) => {
    const list = parseRegisterTarget(def.target).map((c, i) => ({ ...c, i }));
    return list.sort((a, b) => feedRank(a.reg) - feedRank(b.reg) || a.i - b.i);
  };

  const fieldValue = (rec: RecordInput, field: string): string | null => {
    const v = clean(rec.data?.[field]);
    if (v !== null) return v;
    if ((input.idFields?.[rec.register_key] ?? []).includes(field) && rec.data?.[field] === undefined && rec.record_key) return clean(rec.record_key);
    return null;
  };

  function resolve(def: PlaceholderDef, bound: RecordInput | null): Resolved | null {
    switch (def.resolver) {
      case "engagement": {
        const v = clean(input.engagement[def.target]);
        return v ? { value: v, ref: `engagement:${def.target}`, sourceIds: [], confidence: "high" } : null;
      }
      case "computed": {
        let v: string | null = null;
        if (def.target === "today") v = input.today;
        else if (def.target === "doc_version") v = String(input.docVersion);
        else if (def.target === "doc_status") v = input.docStatus ?? "Draft";
        else if (def.target === "system_key") v = systemKey;
        v = clean(v);
        return v ? { value: v, ref: `computed:${def.target}`, sourceIds: [], confidence: "high" } : null;
      }
      case "fact": {
        const f = confirmed.get(def.target);
        const v = f ? clean(f.value) : null;
        return v ? { value: v, ref: `fact:${def.target}`, sourceIds: f!.source_id ? [f!.source_id] : [], confidence: "high" } : null;
      }
      case "register": {
        const cands = candidates(def);
        if (bound) {
          const c = cands.find((x) => x.reg === bound.register_key);
          if (c) {
            const v = fieldValue(bound, c.field);
            return v ? { value: v, ref: `record:${recKey(bound)}`, sourceIds: [], confidence: "high" } : null;
          }
        }
        // Not inside an expanded row: only an unambiguous record (exactly one in scope) may fill.
        for (const c of cands) {
          const recs = scoped(c.reg);
          if (recs.length !== 1) continue;
          const v = fieldValue(recs[0], c.field);
          if (v) return { value: v, ref: `record:${recKey(recs[0])}`, sourceIds: [], confidence: "high" };
        }
        return null;
      }
      default:
        return null;   // llm and human are never filled here
    }
  }

  // ── phase 1: row and form-table expansion ───────────────────────────────────────────────
  const registerNames = (frag: string): PlaceholderDef[] => {
    const out: PlaceholderDef[] = [];
    for (const m of frag.matchAll(bold())) { const d = defs.get(m[2]); if (d?.resolver === "register") out.push(d); }
    return out;
  };
  /** The register that serves most of these placeholders among registers with records in scope. */
  const pickRegister = (list: PlaceholderDef[]): string | null => {
    const count = new Map<string, number>();
    for (const d of list) for (const reg of new Set(parseRegisterTarget(d.target).map((c) => c.reg))) {
      if (scoped(reg).length) count.set(reg, (count.get(reg) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const [reg, n] of count) {
      if (best === null || n > count.get(best)! || (n === count.get(best)! && feedRank(reg) < feedRank(best))) best = reg;
    }
    return best;
  };
  const withRec = (open: string, tag: string, reg: string, rec: RecordInput) =>
    open.replace(new RegExp(`^<${tag}\\b`), `<${tag} data-rec="${escapeHtml(`${reg}/${recKey(rec)}`)}"`);

  const isFormTable = (table: string): boolean => {
    const head = table.match(/<thead[\s\S]*?<\/thead>/);
    if (!head || (head[0].match(/<th\b/g) ?? []).length !== 2) return false;
    const body = table.match(/<tbody[\s\S]*?<\/tbody>/);
    if (!body) return false;
    const rows = [...body[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    if (rows.length < 2) return false;
    let withReg = 0;
    for (const r of rows) {
      const cells = [...r.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      if (cells.length !== 2 || bold().test(cells[0])) return false;
      if (registerNames(cells[1]).length) withReg++;
    }
    return withReg >= 2;
  };

  let html = input.html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/g, (table) => {
    const open = table.match(/^<table\b[^>]*>/)![0];
    if (attr(open, "data-rec") !== null) return table;
    if (isFormTable(table)) {
      if (/<mark\b[^>]*data-resolver="register"/.test(table)) return table;
      const reg = pickRegister(registerNames(table));
      if (!reg) return table;
      return scoped(reg).map((rec) => table.replace(open, () => withRec(open, "table", reg, rec))).join("\n");
    }
    return table.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/g, (tr) => {
      if (/<th\b/.test(tr)) return tr;
      const open = tr.match(/^<tr\b[^>]*>/)![0];
      if (attr(open, "data-rec") !== null || /<mark\b[^>]*data-resolver="register"/.test(tr)) return tr;
      const names = registerNames(tr);
      if (!names.length) return tr;
      const reg = pickRegister(names);
      if (!reg) return tr;
      return scoped(reg).map((rec) => tr.replace(open, () => withRec(open, "tr", reg, rec))).join("");
    });
  });

  // ── binding ranges: which record an expanded row / table (or a row of bound marks) refers to ──
  const recordByKey = (key: string) => input.records.find((r) => recKey(r) === key) ?? null;
  const recordByRec = (v: string): RecordInput | null => {
    const i = v.indexOf("/");
    const reg = unescapeAttr(v.slice(0, i)), key = unescapeAttr(v.slice(i + 1));
    return input.records.find((r) => r.register_key === reg && recKey(r) === key) ?? null;
  };
  const ranges: { start: number; end: number; rec: RecordInput | null }[] = [];
  for (const m of [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g), ...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)]) {
    const open = m[0].match(/^<[a-z]+\b[^>]*>/)![0];
    const dr = attr(open, "data-rec");
    let rec: RecordInput | null = dr !== null ? recordByRec(dr) : null;
    if (!rec && m[0].startsWith("<tr")) {
      const mk = m[0].match(/<mark\b[^>]*data-resolver="register"[^>]*>/);
      const ref = mk ? attr(mk[0], "data-ref") : null;
      if (ref?.startsWith("record:")) rec = recordByKey(unescapeAttr(ref.slice(7)));
    }
    if (rec) ranges.push({ start: m.index!, end: m.index! + m[0].length, rec });
  }
  const boundAt = (p: number): RecordInput | null => {
    let best: { len: number; rec: RecordInput } | null = null;
    for (const r of ranges) if (p >= r.start && p < r.end && (!best || r.end - r.start < best.len)) best = { len: r.end - r.start, rec: r.rec! };
    return best?.rec ?? null;
  };

  // ── phase 2: one left-to-right pass ─────────────────────────────────────────────────────
  const used = new Set<string>([...fieldStatus.keys()]);
  for (const m of html.matchAll(markRe())) { const id = attr(m[0], "data-auto"); if (id) used.add(unescapeAttr(id)); }
  const nextId = (name: string) => {
    let id = name, n = 1;
    while (used.has(id)) { n++; id = `${name}#${n}`; }
    used.add(id);
    return id;
  };
  const fills: Fill[] = [];
  const baseName = (id: string) => id.replace(/#\d+$/, "");

  html = html.replace(combined(), (m, _t: string | undefined, name: string | undefined, off: number) => {
    if (name === undefined) {
      // an existing mark
      const open = m.match(/^<mark\b[^>]*>/)![0];
      const id = unescapeAttr(attr(open, "data-auto") ?? "");
      if ((fieldStatus.get(id) ?? "auto") !== "auto") return m;
      const pname = baseName(id);
      const def = defs.get(pname);
      if (!def) return m;
      const kind = attr(open, "data-resolver");
      if (def.resolver === "llm") return input.refreshLlm ? `<strong>[${pname}]</strong>` : m;
      if (!merging) return m;
      let bound: RecordInput | null = null;
      if (def.resolver === "register") {
        const ref = attr(open, "data-ref");
        bound = ref?.startsWith("record:") ? recordByKey(unescapeAttr(ref.slice(7))) : boundAt(off);
      }
      const r = resolve(def, bound);
      if (!r) return kind === def.resolver ? `<strong>[${pname}]</strong>` : m;
      fills.push({ markId: id, placeholder: pname, value: r.value, resolver: def.resolver as Fill["resolver"], sourceRef: r.ref, sourceIds: r.sourceIds, confidence: r.confidence });
      return mark(id, def.resolver as Exclude<Resolver, "human">, r.confidence, r.ref, r.value);
    }
    const def = defs.get(name);
    if (!def || def.resolver === "human" || def.resolver === "llm") return m;
    const r = resolve(def, def.resolver === "register" ? boundAt(off) : null);
    if (!r) return m;
    const id = nextId(name);
    fills.push({ markId: id, placeholder: name, value: r.value, resolver: def.resolver, sourceRef: r.ref, sourceIds: r.sourceIds, confidence: r.confidence });
    return mark(id, def.resolver, r.confidence, r.ref, r.value);
  });

  // ── what is left ────────────────────────────────────────────────────────────────────────
  const unresolved: { name: string; resolver: string }[] = [];
  const seen = new Set<string>();
  const llmTargets: LlmTarget[] = [];
  const occ = new Map<string, number>();
  for (const m of html.matchAll(bold())) {
    const name = m[2];
    const idx = occ.get(name) ?? 0;
    occ.set(name, idx + 1);
    const def = defs.get(name);
    if (!seen.has(name)) { seen.add(name); unresolved.push({ name, resolver: def?.resolver ?? "unmapped" }); }
    if (def?.resolver === "llm" && idx === 0) {
      llmTargets.push({ name, markId: nextId(name), occurrence: 0, hint: hintAt(html, m.index!) });
    }
  }
  return { html, fills, unresolved, llmTargets };
}

/** Nearest label cell and heading before a position. */
function hintAt(html: string, pos: number): string {
  const before = html.slice(0, pos);
  const rowStart = before.lastIndexOf("<tr");
  let label = "";
  if (rowStart >= 0) {
    const cells = [...before.slice(rowStart).matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)];
    if (cells.length) label = htmlToText(cells[0][1]);
  }
  const hs = [...before.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/g)];
  const heading = hs.length ? htmlToText(hs[hs.length - 1][1]) : "";
  return [label && `label: ${label.slice(0, 120)}`, heading && `section: ${heading.slice(0, 100)}`].filter(Boolean).join("; ");
}

export interface NarrativeFill { name: string; text: string; confidence: Confidence; sourceIds: string[] }

/**
 * Write validated narrative values into the html returned by hydrate (same string, untouched since).
 * Each target's first bold `[NAME]` becomes an llm mark; other occurrences stay placeholders.
 */
export function applyNarrative(html: string, targets: LlmTarget[], values: NarrativeFill[]): { html: string; fills: Fill[] } {
  const fills: Fill[] = [];
  let out = html;
  for (const v of values) {
    const t = targets.find((x) => x.name === v.name);
    if (!t) continue;
    let i = 0, done = false;
    const ref = v.sourceIds.length ? v.sourceIds.map((s) => `source:${s}`).join(",") : "";
    out = out.replace(bold(), (m, _t: string, name: string) => {
      if (name !== v.name || done) return m;
      if (i++ !== t.occurrence) return m;
      done = true;
      return mark(t.markId, "llm", v.confidence, ref, v.text);
    });
    if (done) fills.push({ markId: t.markId, placeholder: v.name, value: v.text, resolver: "llm", sourceRef: ref, sourceIds: v.sourceIds, confidence: v.confidence });
  }
  return { html: out, fills };
}

/** Distinct bold placeholders still in a body (what the database would count as unresolved). */
export function unresolvedNames(html: string): string[] {
  return [...new Set([...html.matchAll(bold())].map((m) => m[2]))].sort();
}
