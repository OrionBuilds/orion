/**
 * CAIO documents for one engagement: the list, "new from template", and the document view/editor with the
 * placeholders panel, review/approval workflow, version history and print. The database re-checks every rule
 * (placeholders, approval fields, lock after approval) and its messages are shown inline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, FileText, History, Plus, Printer, RefreshCw, Save, Send, Sparkles, Trash2, Undo2 } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { SlideInDrawer } from '../ui/SlideInDrawer';
import { Switch } from '../factory/ui';
import {
  approveDocument, createDocumentFromTemplate, daysUntil, deleteDocument, documentVersions, fillPlaceholder,
  getDocument, getTemplate, listDocuments, listGateDefs, listRecords, listTemplates, placeholderCount, reviseDocument, unresolvedPlaceholders,
  updateDocument, type CaioDocument, type CaioDocumentRow, type CaioRecord, type CaioTemplateRow, type DocStatus, type DocumentVersion,
  type Engagement, type GateDef,
} from '../../services/caio';
import {
  generateDocument, latestInputUpdate, listDocumentFields, listGeneratedAt, setDocumentFieldStatus, type DocumentField,
} from '../../services/caioAutomation';
import { DueBadge, ErrorBox, formatDate } from './ui';
import { BTN, BTN_PRIMARY, DocumentEditor, INPUT, ProseView, type DocumentEditorHandle } from './DocumentEditor';
import { buildPrintHtml, groupTemplatesByMilestone, sanitizeEditorHtml } from './documentHtml';
import {
  approvalBlockersWithMarks, isDocumentStale, nonAiMarks, parseMarks, replaceMark, unwrapMark, unwrapMarks, type AutoMark,
} from './automationLogic';

export interface DocumentsPanelProps { engagement: Engagement; canManage: boolean }

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const STATUS_LABEL: Record<DocStatus, string> = { draft: 'Draft', in_review: 'In review', approved: 'Approved', superseded: 'Superseded' };
const STATUS_TONE: Record<DocStatus, 'muted' | 'warn' | 'good' | 'accent'> = { draft: 'muted', in_review: 'warn', approved: 'good', superseded: 'accent' };
const FILTERS: { key: DocStatus | 'all' | 'attention'; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'attention', label: 'Needs attention' }, { key: 'draft', label: 'Draft' },
  { key: 'in_review', label: 'In review' }, { key: 'approved', label: 'Approved' }, { key: 'superseded', label: 'Superseded' },
];

const needsAttention = (d: CaioDocumentRow) =>
  d.status === 'draft' || d.status === 'in_review' || (d.status === 'approved' && (daysUntil(d.next_review) ?? 1) < 0);

function StatusBadge({ status }: { status: DocStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function DocumentsPanel({ engagement, canManage }: DocumentsPanelProps) {
  const [docs, setDocs] = useState<CaioDocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<DocStatus | 'all' | 'attention'>('all');
  const [creating, setCreating] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<Record<string, string | null>>({});
  const [latestInput, setLatestInput] = useState<string | null>(null);
  // deep link: ?doc=<document id> opens that document
  const [openId, setOpenId] = useState<string | null>(() => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('doc')));

  const load = useCallback(async () => {
    try { setDocs(await listDocuments(engagement.id)); setError(null); } catch (e) { setError(msg(e)); setDocs([]); }
    // stale check inputs: best effort (the automation tables may not exist yet)
    try { const [g, l] = await Promise.all([listGeneratedAt(engagement.id), latestInputUpdate(engagement.id)]); setGeneratedAt(g); setLatestInput(l); } catch { setGeneratedAt({}); setLatestInput(null); }
  }, [engagement.id]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const all = docs ?? [];
    const f = filter === 'all' ? all : filter === 'attention' ? all.filter(needsAttention) : all.filter((d) => d.status === filter);
    return [...f].sort((a, b) => (a.template_number ?? 999) - (b.template_number ?? 999) || a.title.localeCompare(b.title) || a.version - b.version);
  }, [docs, filter]);
  const attentionCount = (docs ?? []).filter(needsAttention).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter documents" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-hud-gold ${filter === f.key ? 'border-hud-gold bg-hud-gold/15 text-hud-gold-soft' : 'border-hud-line-soft text-hud-cream-dim hover:bg-hud-bg-elev'}`}>
              {f.label}{f.key === 'attention' && attentionCount ? ` (${attentionCount})` : ''}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" className={BTN} onClick={() => void load()} aria-label="Refresh documents"><RefreshCw className="h-4 w-4" />Refresh</button>
          {canManage && <button type="button" className={BTN} aria-expanded={drafting} onClick={() => setDrafting((v) => !v)}><Sparkles className="h-4 w-4" />Draft with the OS</button>}
          {canManage && <button type="button" className={BTN_PRIMARY} onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New document</button>}
        </div>
      </div>

      {drafting && canManage && <DraftActions engagement={engagement} onDone={() => void load()} />}

      {error && <ErrorBox message={error} />}

      {docs === null ? (
        <div className="py-10 text-center text-sm text-hud-cream-mute">Loading documents…</div>
      ) : visible.length === 0 && !error ? (
        <div className="rounded-xl border border-dashed border-hud-line-soft py-10 text-center text-sm text-hud-cream-mute">
          {docs.length === 0 ? 'No documents yet. Start one from a template.' : 'No documents match this filter.'}
        </div>
      ) : visible.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-hud-line-soft">
          <table className="w-full min-w-[64rem] text-sm">
            <thead className="bg-hud-bg-card text-left text-[11px] uppercase tracking-wide text-hud-cream-mute">
              <tr>
                {['#', 'Document', 'System', 'Ver.', 'Status', 'Approver', 'Approved', 'Next review', 'Client', 'Updated'].map((h) => <th key={h} scope="col" className="px-3 py-2">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-hud-line-soft">
              {visible.map((d) => (
                <tr key={d.id} className="hover:bg-hud-bg-card/60">
                  <td className="px-3 py-2 font-mono text-hud-cream-dim">{d.template_number === null ? '–' : String(d.template_number).padStart(2, '0')}</td>
                  <td className="px-3 py-2"><button type="button" onClick={() => setOpenId(d.id)} className="text-left font-medium text-white hover:text-hud-gold-soft focus:outline-none focus-visible:underline">{d.title}</button>
                    {isDocumentStale(d, generatedAt[d.id], latestInput) && <Badge tone="warn" className="ml-2" title="A fact, record or source changed after this draft was prepared">stale: inputs changed since drafted</Badge>}</td>
                  <td className="px-3 py-2 font-mono text-xs text-hud-cream-dim">{d.system_key ?? '–'}</td>
                  <td className="px-3 py-2 text-hud-cream-dim">v{d.version}</td>
                  <td className="px-3 py-2"><StatusBadge status={d.status} /></td>
                  <td className="px-3 py-2 text-hud-cream-dim">{d.approver_name ?? '–'}</td>
                  <td className="px-3 py-2 text-hud-cream-dim">{formatDate(d.approved_at)}</td>
                  <td className="px-3 py-2">{d.status === 'approved' ? <DueBadge date={d.next_review} /> : <span className="text-hud-cream-mute">–</span>}</td>
                  <td className="px-3 py-2">{d.client_visible ? <Badge tone="accent">visible</Badge> : <span className="text-hud-cream-mute">–</span>}</td>
                  <td className="px-3 py-2 text-xs text-hud-cream-mute">{formatDate(d.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <NewDocumentDrawer engagement={engagement} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); void load(); setOpenId(id); }} />}
      {openId && <DocumentDrawer key={openId} id={openId} engagement={engagement} canManage={canManage} stale={isDocumentStale({ status: (docs ?? []).find((d) => d.id === openId)?.status ?? 'approved' }, generatedAt[openId], latestInput)} onClose={() => setOpenId(null)} onChanged={() => void load()} />}
    </div>
  );
}

// ── new document ────────────────────────────────────────────────────────────────────────────

function NewDocumentDrawer({ engagement, onClose, onCreated }: { engagement: Engagement; onClose: () => void; onCreated: (id: string) => void }) {
  const [templates, setTemplates] = useState<CaioTemplateRow[] | null>(null);
  const [systems, setSystems] = useState<CaioRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<CaioTemplateRow | null>(null);
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [systemKey, setSystemKey] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [t, s] = await Promise.all([listTemplates(), listRecords(engagement.id, 'ai_systems')]);
        if (!live) return;
        setTemplates(t.filter((x) => x.enabled)); setSystems(s);
      } catch (e) { if (live) { setError(msg(e)); setTemplates([]); } }
    })();
    return () => { live = false; };
  }, [engagement.id]);

  const systemLabel = (r: CaioRecord) => `${r.record_key} ${String(r.data.name ?? r.data.system_name ?? r.data.title ?? '').trim()}`.trim();
  const autoTitle = (t: CaioTemplateRow | null, sys: string) => (t ? `${t.title}${sys ? ` (${sys})` : ''}` : '');
  const groups = useMemo(() => groupTemplatesByMilestone(templates ?? []), [templates]);

  const pick = (t: CaioTemplateRow) => { setPicked(t); if (!titleTouched) setTitle(autoTitle(t, systemKey)); };
  const pickSystem = (k: string) => { setSystemKey(k); if (!titleTouched) setTitle(autoTitle(picked, k)); };

  const create = async () => {
    if (!picked) return;
    setBusy(true); setError(null);
    try {
      const full = await getTemplate(picked.id);
      if (!full) throw new Error('Template not found.');
      const doc = await createDocumentFromTemplate(engagement, full, { title, systemKey: systemKey || null });
      onCreated(doc.id);
    } catch (e) { setError(msg(e)); setBusy(false); }
  };

  return (
    <SlideInDrawer isOpen onClose={() => !busy && onClose()} width="xl" icon={<Plus className="h-5 w-5" />} title="New document" subtitle="Start from one of the delivery templates"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} disabled={busy || !picked || !title.trim()} onClick={() => void create()}>{busy ? 'Creating…' : 'Create and open'}</button>
        </div>
      }>
      <div className="space-y-5 p-6">
        {error && <ErrorBox message={error} />}
        {templates === null ? <div className="py-8 text-center text-sm text-hud-cream-mute">Loading templates…</div> : (
          <>
            <fieldset className="space-y-4">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-hud-cream-mute">Template</legend>
              {groups.length === 0 && <div className="text-sm text-hud-cream-mute">No enabled templates.</div>}
              {groups.map((g) => (
                <div key={g.label}>
                  <div className="mb-1 text-xs font-semibold text-hud-gold-soft">{g.label}</div>
                  <div className="space-y-1">
                    {g.items.map((t) => (
                      <label key={`${g.label}-${t.id}`} className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2 transition-colors ${picked?.id === t.id ? 'border-hud-gold bg-hud-gold/10' : 'border-hud-line-soft hover:bg-hud-bg-elev'}`}>
                        <input type="radio" name="template" className="mt-1 accent-[#c9a24a]" checked={picked?.id === t.id} onChange={() => pick(t)} />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-white"><span className="font-mono text-hud-cream-dim">{String(t.number).padStart(2, '0')}</span> {t.title}</span>
                          {t.when_to_use && <span className="block text-xs text-hud-cream-mute">{t.when_to_use}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </fieldset>

            <div className="space-y-3">
              <label className="block text-sm text-hud-cream-soft">Title
                <input className={`${INPUT} mt-1`} value={title} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} placeholder="Defaults from the template" />
              </label>
              <label className="block text-sm text-hud-cream-soft">System (optional)
                <select className={`${INPUT} mt-1`} value={systemKey} onChange={(e) => pickSystem(e.target.value)}>
                  <option value="">Not tied to a system</option>
                  {systems.map((s) => <option key={s.id} value={s.record_key}>{systemLabel(s)}</option>)}
                </select>
              </label>
              {systems.length === 0 && <p className="text-xs text-hud-cream-mute">No AI systems in the register yet. Add them in the AI Systems register to link a document.</p>}
            </div>
          </>
        )}
      </div>
    </SlideInDrawer>
  );
}

// ── document view / editor ──────────────────────────────────────────────────────────────────

type FillMode = 'fill' | 'na' | 'unknown';
interface PromptDraft { mode: FillMode; value: string; owner: string; due: string }
const EMPTY_DRAFT: PromptDraft = { mode: 'fill', value: '', owner: '', due: '' };

function DocumentDrawer({ id, engagement, canManage, stale, onClose, onChanged }: {
  id: string; engagement: Engagement; canManage: boolean; stale: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [doc, setDoc] = useState<CaioDocument | null>(null);
  const [html, setHtml] = useState('');
  const [loadKey, setLoadKey] = useState(0);
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const [evidence, setEvidence] = useState('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, PromptDraft>>({});
  const [approving, setApproving] = useState(false);
  const [appr, setAppr] = useState({ approver: '', ref: '', nextReview: '' });
  const [versions, setVersions] = useState<DocumentVersion[] | null>(null);
  const [viewing, setViewing] = useState<DocumentVersion | null>(null);
  const editor = useRef<DocumentEditorHandle>(null);
  const [fields, setFields] = useState<DocumentField[]>([]);
  // confirmations and edits of auto-filled values, written to caio_document_fields together with the body on save
  const [pending, setPending] = useState<Record<string, { status: 'confirmed' | 'edited'; value?: string }>>({});
  const [editingMark, setEditingMark] = useState<{ id: string; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((d: CaioDocument) => {
    setDoc(d); setHtml(d.body_html); setTitle(d.title); setOwner(d.owner_name ?? ''); setEvidence(d.evidence_link ?? '');
    setLoadKey((k) => k + 1); setDirty(false); setPending({}); setEditingMark(null);
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await getDocument(id);
      if (!d) { setError('Document not found.'); return; }
      apply(d); setError(null);
      setFields(await listDocumentFields(id).catch(() => []));
    } catch (e) { setError(msg(e)); }
  }, [id, apply]);
  useEffect(() => { void load(); }, [load]);

  // leaving the page with unsaved edits
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const status = doc?.status;
  const editable = canManage && (status === 'draft' || status === 'in_review');
  const locked = !editable;
  const placeholders = useMemo(() => unresolvedPlaceholders(html), [html]);
  const marks = useMemo(() => parseMarks(html), [html]);
  const blockers = doc ? approvalBlockersWithMarks({ body_html: html, approver_name: appr.approver, approval_ref: appr.ref, next_review: appr.nextReview || null }) : [];

  const close = () => {
    if (dirty && !window.confirm('You have unsaved changes. Leave without saving?')) return;
    onClose();
  };

  /** Run a server action, show its (already cleaned) message inline, refresh on success. */
  const run = async (fn: () => Promise<void>, after?: () => void) => {
    setBusy(true); setError(null);
    try { await fn(); after?.(); onChanged(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };

  const savePatch = () => ({
    body_html: sanitizeEditorHtml(html), owner_name: owner.trim() || null, evidence_link: evidence.trim() || null,
    ...(status === 'draft' ? { title: title.trim() || doc!.title } : {}),
  });
  /** Save the body, then record which auto-filled values were confirmed or edited. */
  const persist = async () => {
    await updateDocument(id, savePatch());
    const present = new Set(parseMarks(html).map((m) => m.id));
    const writes: Promise<void>[] = Object.entries(pending).map(([markId, p]) => setDocumentFieldStatus(id, markId, p.status, p.value));
    // a value the owner retyped inside the document no longer carries its mark: count it as edited
    for (const f of fields) if (f.status === 'auto' && !present.has(f.mark_id) && !pending[f.mark_id]) writes.push(setDocumentFieldStatus(id, f.mark_id, 'edited'));
    await Promise.all(writes);
  };
  const save = () => run(async () => { await persist(); await load(); });

  const setStatus = (next: DocStatus) => run(async () => {
    if (dirty) await persist();
    await updateDocument(id, { status: next });
    await load();
  });

  const approve = () => run(async () => {
    if (dirty) await persist();
    await approveDocument(id, { approver: appr.approver.trim(), ref: appr.ref.trim(), nextReview: appr.nextReview });
    setApproving(false);
    await load();
  });

  const revise = () => {
    if (!doc || !window.confirm(`Start version ${doc.version + 1}? The approved text stays in the version history and this document returns to draft.`)) return;
    void run(async () => { await reviseDocument(id); await load(); setVersions(null); setViewing(null); });
  };

  const toggleClient = (on: boolean) => {
    if (on && !window.confirm('Make this document visible to the client? It appears in the client portal when this engagement\'s portal is switched on.')) return;
    void run(async () => { await updateDocument(id, { client_visible: on }); await load(); });
  };

  const remove = () => {
    if (!window.confirm('Delete this draft? This cannot be undone.')) return;
    void run(async () => { await deleteDocument(id); }, onClose);
  };

  const print = () => {
    if (!doc) return;
    const w = window.open('', '_blank');
    if (!w) { setError('Unable to open the print window. Please allow popups for this site.'); return; }
    w.document.write(buildPrintHtml({
      title, client: engagement.client_legal_name, engagementCode: engagement.engagement_code, version: doc.version, status: STATUS_LABEL[doc.status],
      owner, approver: doc.approver_name, approvalRef: doc.approval_ref, approvedAt: doc.approved_at, nextReview: doc.next_review,
    }, html));
    w.document.close();
    w.onload = () => { setTimeout(() => w.print(), 300); };
  };

  const showHistory = () => {
    if (versions) { setVersions(null); setViewing(null); return; }
    void run(async () => { setVersions(await documentVersions(id)); });
  };

  const changeHtml = (next: string) => { setHtml(next); setLoadKey((k) => k + 1); setDirty(true); };
  const confirmMark = (m: AutoMark) => { changeHtml(unwrapMark(html, m.id)); setPending((p) => ({ ...p, [m.id]: { status: 'confirmed' } })); };
  const editMark = (m: AutoMark, text: string) => {
    if (!text.trim()) return;
    changeHtml(replaceMark(html, m.id, text)); setPending((p) => ({ ...p, [m.id]: { status: 'edited', value: text.trim() } })); setEditingMark(null);
  };
  const confirmAllNonAi = () => {
    const list = nonAiMarks(html);
    if (!list.length) return;
    changeHtml(unwrapMarks(html, (m) => m.resolver !== 'llm'));
    setPending((p) => ({ ...p, ...Object.fromEntries(list.map((m) => [m.id, { status: 'confirmed' as const }])) }));
  };
  const regenerate = () => {
    if (!doc || doc.template_number === null) return;
    if (!window.confirm('Regenerate this draft? Values you confirmed or edited are kept. Open placeholders and unconfirmed auto-filled values are rewritten.')) return;
    void run(async () => {
      if (dirty) await persist();
      const r = await generateDocument({ engagementId: engagement.id, templateNumber: doc.template_number!, systemKey: doc.system_key, documentId: id });
      setNotice(`Regenerated: ${r.filled ?? 0} values filled, ${r.unresolved?.length ?? 0} unresolved, ${r.needs_input?.length ?? 0} need your input.`);
      await load();
    });
  };

  const draftOf = (name: string) => drafts[name] ?? EMPTY_DRAFT;
  const setDraft = (name: string, patch: Partial<PromptDraft>) => setDrafts((d) => ({ ...d, [name]: { ...draftOf(name), ...patch } }));
  const fill = (name: string, value: string) => {
    setHtml((cur) => fillPlaceholder(cur, name, value));
    setLoadKey((k) => k + 1); setDirty(true);
    setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== name)));
  };

  return (
    <SlideInDrawer isOpen onClose={approving ? () => undefined : close} width="3xl" icon={<FileText className="h-5 w-5" />}
      title={doc ? `${doc.template_number === null ? '' : String(doc.template_number).padStart(2, '0') + ' '}${doc.title}` : 'Document'}
      subtitle={doc ? `Version ${doc.version}${doc.system_key ? ` · ${doc.system_key}` : ''} · updated ${formatDate(doc.updated_at)}` : undefined}>
      <div className="space-y-4 p-4 sm:p-6">
        {error && <ErrorBox message={error} />}
        {notice && <p className="text-sm text-hud-emerald" role="status">{notice}</p>}
        {!doc && !error && <div className="py-10 text-center text-sm text-hud-cream-mute">Loading…</div>}
        {doc && (
          <>
            {/* header controls */}
            <div className="space-y-3 rounded-xl border border-hud-line-soft bg-hud-bg-card/50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={doc.status} />
                {dirty && <Badge tone="warn" role="status">Unsaved changes</Badge>}
                {stale && <Badge tone="warn" title="A fact, record or source changed after this draft was prepared">stale: inputs changed since drafted</Badge>}
                {doc.status === 'approved' && <DueBadge date={doc.next_review} label="Review" />}
                <div className="ml-auto flex flex-wrap gap-2">
                  {canManage && editable && <button type="button" className={BTN_PRIMARY} disabled={busy || !dirty} onClick={() => void save()}><Save className="h-4 w-4" />{busy ? 'Saving…' : 'Save'}</button>}
                  {canManage && editable && doc.template_number !== null && <button type="button" className={BTN} disabled={busy} title="Keeps what you confirmed" onClick={regenerate}><Sparkles className="h-4 w-4" />Regenerate (keeps what you confirmed)</button>}
                  {canManage && doc.status === 'draft' && <button type="button" className={BTN} disabled={busy} onClick={() => void setStatus('in_review')}><Send className="h-4 w-4" />Send for review</button>}
                  {canManage && doc.status === 'in_review' && <button type="button" className={BTN} disabled={busy} onClick={() => void setStatus('draft')}><Undo2 className="h-4 w-4" />Back to draft</button>}
                  {canManage && (doc.status === 'draft' || doc.status === 'in_review') && <button type="button" className={BTN} disabled={busy} onClick={() => setApproving(true)}><Check className="h-4 w-4" />Approve</button>}
                  {canManage && doc.status === 'approved' && <button type="button" className={BTN} disabled={busy} onClick={revise}><Undo2 className="h-4 w-4" />Revise (new version)</button>}
                  <button type="button" className={BTN} onClick={print}><Printer className="h-4 w-4" />Print / Save as PDF</button>
                  <button type="button" className={BTN} aria-pressed={!!versions} onClick={showHistory}><History className="h-4 w-4" />Version history</button>
                  {canManage && doc.status === 'draft' && <button type="button" className={`${BTN} hover:!bg-hud-plum/20`} disabled={busy} onClick={remove}><Trash2 className="h-4 w-4" />Delete</button>}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-hud-cream-mute">Title
                  <input className={`${INPUT} mt-1`} value={title} disabled={!(canManage && status === 'draft')} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} />
                </label>
                <label className="block text-xs text-hud-cream-mute">Owner
                  <input className={`${INPUT} mt-1`} value={owner} disabled={locked} onChange={(e) => { setOwner(e.target.value); setDirty(true); }} placeholder="Named document owner" />
                </label>
                <label className="block text-xs text-hud-cream-mute sm:col-span-2">Evidence link
                  <div className="mt-1 flex gap-2">
                    <input className={INPUT} value={evidence} disabled={locked} inputMode="url" onChange={(e) => { setEvidence(e.target.value); setDirty(true); }} placeholder="Link to the access-controlled evidence" />
                    {evidence && /^https?:\/\//i.test(evidence) && <a className={BTN} href={evidence} target="_blank" rel="noopener noreferrer">Open</a>}
                  </div>
                </label>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-hud-cream-dim">
                <span>
                  {doc.approver_name ? <>Approved by <span className="text-hud-cream-soft">{doc.approver_name}</span>{doc.approval_ref ? ` (${doc.approval_ref})` : ''} on {formatDate(doc.approved_at)}</> : 'Not yet approved'}
                </span>
                <span className="flex items-center gap-2">
                  <span id="client-visible-label">Visible to client</span>
                  <Switch checked={doc.client_visible} label="Visible to client" disabled={!canManage || busy || (doc.status !== 'approved' && !doc.client_visible)} onChange={toggleClient} />
                </span>
              </div>
              {doc.status !== 'approved' && <p className="text-[11px] text-hud-cream-mute">A document can be shown to the client only once it is approved.</p>}
              {doc.status === 'approved' && <p className="text-[11px] text-hud-cream-mute">Approved text is locked. Use Revise to start a new version.</p>}
            </div>

            {/* version history */}
            {versions && (
              <div className="rounded-xl border border-hud-line-soft p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-hud-cream-mute">Version history</div>
                {versions.length === 0 ? <div className="text-sm text-hud-cream-mute">No approved versions yet.</div> : (
                  <ul className="divide-y divide-hud-line-soft text-sm">
                    {versions.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                        <span className="text-hud-cream-soft">v{v.version} · {v.status}{v.approver_name ? ` · ${v.approver_name}` : ''}{v.approval_ref ? ` (${v.approval_ref})` : ''} · {formatDate(v.approved_at ?? v.changed_at)}</span>
                        <button type="button" className={BTN} onClick={() => setViewing(v)}>View</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
              {/* body */}
              <div className="min-w-0">
                {viewing ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hud-gold/40 bg-hud-gold/10 px-3 py-2 text-sm text-hud-cream-soft">
                      <span>Viewing version {viewing.version} (read-only)</span>
                      <button type="button" className={BTN} onClick={() => setViewing(null)}>Back to current</button>
                    </div>
                    <div className="rounded-lg border border-hud-line-soft bg-hud-bg-deep/40 px-4 py-3"><ProseView html={viewing.body_html} /></div>
                  </div>
                ) : editable ? (
                  <DocumentEditor ref={editor} html={html} loadKey={loadKey} editable onChange={(h) => { setHtml(h); setDirty(true); }} />
                ) : (
                  <div className="rounded-lg border border-hud-line-soft bg-hud-bg-deep/40 px-4 py-3"><ProseView html={html} showMarks={doc.status !== 'approved'} /></div>
                )}
              </div>

              {/* placeholders */}
              <aside aria-label="Placeholders" className="space-y-2 lg:sticky lg:top-0 lg:self-start">
                {marks.length > 0 && (
                  <section aria-label="Auto-filled values to confirm" className="space-y-2 pb-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-hud-cream-mute">Auto-filled values to confirm ({marks.length})</div>
                    <p className="text-[11px] text-hud-cream-mute">Amber was drafted by the model, blue came from a fact or register, gray from the engagement. Approval stays blocked until each is confirmed.</p>
                    {editable && nonAiMarks(html).length > 0 && !viewing && (
                      <button type="button" className={BTN} onClick={confirmAllNonAi}>Confirm all non-AI values ({nonAiMarks(html).length})</button>
                    )}
                    <ul className="space-y-2">
                      {marks.map((m) => {
                        const field = fields.find((f) => f.mark_id === m.id);
                        const tone = m.resolver === 'llm' ? 'border-amber-400/50' : m.resolver === 'fact' || m.resolver === 'register' ? 'border-sky-400/50' : 'border-slate-400/50';
                        return (
                          <li key={m.id} className={`rounded-lg border bg-hud-bg-card/50 p-2 ${tone}`}>
                            <button type="button" className="block w-full text-left text-xs font-semibold text-hud-gold-soft hover:underline focus:outline-none focus-visible:underline"
                              onClick={() => editor.current?.focusMark(m.id)}>[{m.name}]{m.id.includes('#') ? ` ${m.id.slice(m.id.indexOf('#'))}` : ''}</button>
                            <div className="mt-0.5 break-words text-sm text-hud-cream-soft">{m.text}</div>
                            <div className="mt-0.5 text-[11px] text-hud-cream-mute">
                              {m.resolver === 'llm' ? 'drafted by the model' : m.resolver ?? 'auto'}{(m.conf ?? field?.confidence) ? `, ${m.conf ?? field?.confidence} confidence` : ''}{(m.ref || field?.source_ref) ? `, ${m.ref || field?.source_ref}` : ''}
                            </div>
                            {editable && !viewing && (editingMark?.id === m.id ? (
                              <form className="mt-1.5 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); editMark(m, editingMark.text); }}>
                                <input className={INPUT} aria-label={`Your value for ${m.name}`} value={editingMark.text} onChange={(e) => setEditingMark({ id: m.id, text: e.target.value })} />
                                <button type="submit" className={BTN} disabled={!editingMark.text.trim()}>Use</button>
                              </form>
                            ) : (
                              <div className="mt-1.5 flex gap-1.5">
                                <button type="button" className={BTN} aria-label={`Confirm ${m.name}`} onClick={() => confirmMark(m)}>Confirm</button>
                                <button type="button" className={BTN} aria-label={`Edit ${m.name}`} onClick={() => setEditingMark({ id: m.id, text: m.text })}>Edit</button>
                              </div>
                            ))}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
                <div className="text-xs font-semibold uppercase tracking-wide text-hud-cream-mute">Placeholders · {placeholders.length}</div>
                {placeholders.length === 0 ? (
                  <div role="status" className="rounded-lg border border-hud-emerald/40 bg-hud-emerald/10 px-3 py-2 text-sm text-hud-cream-soft">All placeholders resolved</div>
                ) : (
                  <ul className="space-y-2">
                    {placeholders.map((name) => {
                      const d = draftOf(name);
                      const canFill = editable && !viewing;
                      return (
                        <li key={name} className="rounded-lg border border-hud-line-soft bg-hud-bg-card/50 p-2">
                          <div className="flex items-start justify-between gap-2">
                            <button type="button" disabled={!canFill} onClick={() => editor.current?.focusPlaceholder(name)}
                              className="min-w-0 break-words text-left text-sm font-semibold text-hud-gold-soft hover:underline disabled:no-underline disabled:cursor-default focus:outline-none focus-visible:underline">[{name}]</button>
                            <Badge>{placeholderCount(html, name)}×</Badge>
                          </div>
                          {canFill && (
                            <div className="mt-2 space-y-1.5">
                              {d.mode === 'fill' && (
                                <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (d.value.trim()) fill(name, d.value); }}>
                                  <input className={INPUT} aria-label={`Value for ${name}`} value={d.value} onChange={(e) => setDraft(name, { value: e.target.value })} placeholder="Value" />
                                  <button type="submit" className={BTN} disabled={!d.value.trim()}>Fill everywhere</button>
                                </form>
                              )}
                              {d.mode === 'na' && (
                                <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (d.value.trim()) fill(name, `N/A: ${d.value.trim()}`); }}>
                                  <input className={INPUT} aria-label={`Reason ${name} is not applicable`} value={d.value} onChange={(e) => setDraft(name, { value: e.target.value })} placeholder="Reason it does not apply" />
                                  <button type="submit" className={BTN} disabled={!d.value.trim()}>Apply</button>
                                </form>
                              )}
                              {d.mode === 'unknown' && (
                                <form className="space-y-1.5" onSubmit={(e) => { e.preventDefault(); if (d.owner.trim() && d.due) fill(name, `Unknown: ${d.owner.trim()}, due ${d.due}`); }}>
                                  <input className={INPUT} aria-label={`Owner who will resolve ${name}`} value={d.owner} onChange={(e) => setDraft(name, { owner: e.target.value })} placeholder="Owner who will resolve it" />
                                  <div className="flex gap-1.5">
                                    <input className={INPUT} type="date" aria-label={`Due date for ${name}`} value={d.due} onChange={(e) => setDraft(name, { due: e.target.value })} />
                                    <button type="submit" className={BTN} disabled={!d.owner.trim() || !d.due}>Apply</button>
                                  </div>
                                </form>
                              )}
                              <div className="flex gap-1 text-xs" role="group" aria-label={`How to resolve ${name}`}>
                                {(['fill', 'na', 'unknown'] as FillMode[]).map((m) => (
                                  <button key={m} type="button" aria-pressed={d.mode === m} onClick={() => setDraft(name, { mode: m })}
                                    className={`rounded-md px-2 py-0.5 ${d.mode === m ? 'bg-hud-bg-elev text-white' : 'text-hud-cream-mute hover:text-white'}`}>
                                    {m === 'fill' ? 'Value' : m === 'na' ? 'N/A' : 'Unknown'}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="text-[11px] text-hud-cream-mute">N/A needs a reason. Unknown needs an owner and a due date. Delete table rows that do not apply and add rows for the real scope.</p>
              </aside>
            </div>
          </>
        )}
      </div>

      {approving && doc && (
        <SlideInDrawer isOpen onClose={() => !busy && setApproving(false)} width="md" title="Approve document" subtitle={`${doc.title} · version ${doc.version}`}
          footer={
            <div className="flex justify-end gap-2">
              <button type="button" className={BTN} disabled={busy} onClick={() => setApproving(false)}>Cancel</button>
              <button type="button" className={BTN_PRIMARY} disabled={busy || blockers.length > 0} onClick={() => void approve()}>{busy ? 'Approving…' : 'Approve'}</button>
            </div>
          }>
          <div className="space-y-3 p-6">
            {error && <ErrorBox message={error} />}
            <label className="block text-sm text-hud-cream-soft">Approver name
              <input className={`${INPUT} mt-1`} value={appr.approver} onChange={(e) => setAppr({ ...appr, approver: e.target.value })} /></label>
            <label className="block text-sm text-hud-cream-soft">Approval reference
              <input className={`${INPUT} mt-1`} value={appr.ref} onChange={(e) => setAppr({ ...appr, ref: e.target.value })} placeholder="Decision, minute or ticket reference" /></label>
            <label className="block text-sm text-hud-cream-soft">Next review date
              <input className={`${INPUT} mt-1`} type="date" value={appr.nextReview} onChange={(e) => setAppr({ ...appr, nextReview: e.target.value })} /></label>
            {blockers.length > 0 ? (
              <div role="status" className="rounded-lg border border-hud-rust/40 bg-hud-rust/10 px-3 py-2 text-sm text-hud-cream-soft">
                <div className="mb-1 font-semibold">Still needed before approval</div>
                <ul className="list-disc pl-5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              </div>
            ) : <div role="status" className="rounded-lg border border-hud-emerald/40 bg-hud-emerald/10 px-3 py-2 text-sm text-hud-cream-soft">Ready to approve. The approved text will be locked.</div>}
          </div>
        </SlideInDrawer>
      )}
    </SlideInDrawer>
  );
}

// ── draft with the OS ───────────────────────────────────────────────────────────────────────

interface DraftStep { key: string; label: string; state: 'waiting' | 'running' | 'done' | 'failed'; detail?: string }

/** Draft one document, or a whole gate pack, with caio-generate. Templates run one at a time; each result is listed. */
function DraftActions({ engagement, onDone }: { engagement: Engagement; onDone: () => void }) {
  const [templates, setTemplates] = useState<CaioTemplateRow[] | null>(null);
  const [gates, setGates] = useState<GateDef[]>([]);
  const [systems, setSystems] = useState<CaioRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [systemKey, setSystemKey] = useState('');
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([listTemplates(), listGateDefs(), listRecords(engagement.id, 'ai_systems')]).then(([t, g, s]) => {
      if (live) { setTemplates(t.filter((x) => x.enabled)); setGates(g); setSystems(s); }
    }).catch((e) => { if (live) { setError(msg(e)); setTemplates([]); } });
    return () => { live = false; };
  }, [engagement.id]);

  const runAll = async (items: { number: number; label: string; systemKey?: string | null }[]) => {
    setRunning(true); setError(null);
    const list: DraftStep[] = items.map((i) => ({ key: `${i.number}-${i.systemKey ?? ''}`, label: i.label, state: 'waiting' }));
    setSteps(list);
    const patch = (idx: number, change: Partial<DraftStep>) => setSteps((cur) => cur.map((x, j) => (j === idx ? { ...x, ...change } : x)));
    for (let i = 0; i < items.length; i++) {
      patch(i, { state: 'running' });
      try {
        const r = await generateDocument({ engagementId: engagement.id, templateNumber: items[i].number, systemKey: items[i].systemKey });
        patch(i, { state: 'done', detail: `${r.created ? 'created' : 'updated'}; ${r.filled ?? 0} filled, ${r.unresolved?.length ?? 0} unresolved, ${r.needs_input?.length ?? 0} need your input` });
      } catch (e) {
        patch(i, { state: 'failed', detail: msg(e) });
      }
    }
    setRunning(false);
    onDone();
  };

  const labelOf = (n: number) => { const t = (templates ?? []).find((x) => x.number === n); return `${String(n).padStart(2, '0')} ${t?.title ?? `Template ${n}`}`; };
  const chosen = (templates ?? []).find((t) => String(t.number) === pick);

  return (
    <div className="space-y-3 rounded-xl border border-hud-line-soft bg-hud-bg-card/50 p-3">
      {error && <ErrorBox message={error} />}
      {templates === null ? <div className="text-sm text-hud-cream-mute" role="status">Loading templates...</div> : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-xs text-hud-cream-mute">Template
              <select className={`${INPUT} mt-1 min-w-[16rem]`} value={pick} disabled={running} onChange={(e) => setPick(e.target.value)}>
                <option value="">Choose a template</option>
                {templates.map((t) => <option key={t.id} value={String(t.number)}>{labelOf(t.number)}</option>)}
              </select>
            </label>
            {systems.length > 0 && (
              <label className="block text-xs text-hud-cream-mute">System (optional)
                <select className={`${INPUT} mt-1`} value={systemKey} disabled={running} onChange={(e) => setSystemKey(e.target.value)}>
                  <option value="">Not tied to a system</option>
                  {systems.map((s) => <option key={s.id} value={s.record_key}>{s.record_key}</option>)}
                </select>
              </label>
            )}
            <button type="button" className={BTN_PRIMARY} disabled={running || !chosen}
              onClick={() => chosen && void runAll([{ number: chosen.number, label: labelOf(chosen.number), systemKey: systemKey || null }])}>Draft this document</button>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Draft a gate pack">
            {gates.map((g) => (
              <button key={g.gate_key} type="button" className={BTN} disabled={running || g.required_templates.length === 0}
                onClick={() => void runAll(g.required_templates.map((n) => ({ number: n, label: labelOf(n) })))}>Draft the {g.label} pack</button>
            ))}
          </div>
          <p className="text-[11px] text-hud-cream-mute">Drafts are never approved or shown to the client. Every auto-filled value is marked until you confirm it.</p>
        </>
      )}
      {steps.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Drafting progress" role="status">
          {steps.map((st) => (
            <li key={st.key} className="flex flex-wrap items-center gap-2 text-hud-cream-soft">
              <Badge tone={st.state === 'done' ? 'good' : st.state === 'failed' ? 'bad' : st.state === 'running' ? 'warn' : 'muted'}>{st.state}</Badge>
              <span>{st.label}</span>
              {st.detail && <span className={`text-xs ${st.state === 'failed' ? 'text-hud-plum' : 'text-hud-cream-mute'}`}>{st.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default DocumentsPanel;
