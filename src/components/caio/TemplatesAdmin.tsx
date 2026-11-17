/**
 * CAIO templates admin: the 40 delivery templates. Everyone with read access sees the rendered body; the owner
 * can edit it, replace it from a Word file, bulk-import files named "NN ... .docx" and enable or disable templates.
 * Editing a template never changes documents already created from it; re-seeding never overwrites an edited one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, FileText, Pencil, RefreshCw, Upload } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { SlideInDrawer } from '../ui/SlideInDrawer';
import { Switch } from '../factory/ui';
import {
  getTemplate, importTemplateBody, listTemplates, unresolvedPlaceholders, updateTemplate,
  type CaioTemplate, type CaioTemplateRow,
} from '../../services/caio';
import { ErrorBox, formatDate } from './ui';
import { BTN, BTN_PRIMARY, DocumentEditor, ProseView } from './DocumentEditor';
import { matchDocxFiles, sanitizeDocHtml } from './documentHtml';

export interface TemplatesAdminProps { canManage: boolean }

const SOURCE_TONE = { seed: 'muted', edited: 'accent', import: 'good' } as const;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function docxToHtml(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.default.convertToHtml({ arrayBuffer });
  return sanitizeDocHtml(result.value);
}

interface BulkItem { file: string; number: number | null; template: CaioTemplateRow | null; html: string | null; error: string | null }

export function TemplatesAdmin({ canManage }: TemplatesAdminProps) {
  const [rows, setRows] = useState<CaioTemplateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [bulk, setBulk] = useState<BulkItem[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const bulkInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setRows(await listTemplates()); setError(null); } catch (e) { setError(msg(e)); setRows([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const sorted = useMemo(() => [...(rows ?? [])].sort((a, b) => a.number - b.number), [rows]);

  const toggle = async (t: CaioTemplateRow, enabled: boolean) => {
    setRows((cur) => cur?.map((r) => (r.id === t.id ? { ...r, enabled } : r)) ?? cur);
    try { await updateTemplate(t.id, { enabled }); setError(null); } catch (e) { setError(msg(e)); void load(); }
  };

  const pickBulk = async (files: FileList | null) => {
    if (!files?.length) return;
    setNotice(null);
    setBulkBusy(true);
    try {
      const list = Array.from(files);
      const matches = matchDocxFiles(list.map((f) => f.name), sorted);
      const items: BulkItem[] = [];
      for (let i = 0; i < list.length; i++) {
        const m = matches[i];
        const template = m.template !== null ? sorted.find((t) => t.number === m.number) ?? null : null;
        if (!template) { items.push({ file: m.file, number: m.number, template: null, html: null, error: null }); continue; }
        try { items.push({ file: m.file, number: m.number, template, html: await docxToHtml(list[i]), error: null }); }
        catch (e) { items.push({ file: m.file, number: m.number, template, html: null, error: `Could not read the file: ${msg(e)}` }); }
      }
      setBulk(items);
    } finally {
      setBulkBusy(false);
      if (bulkInput.current) bulkInput.current.value = '';
    }
  };

  const bulkReady = (bulk ?? []).filter((b) => b.template && b.html);

  const confirmBulk = async () => {
    setBulkBusy(true);
    const failed: string[] = [];
    let done = 0;
    for (const b of bulkReady) {
      try { await importTemplateBody(b.template!.id, b.html!); done++; } catch (e) { failed.push(`${b.file}: ${msg(e)}`); }
    }
    setBulkBusy(false);
    setBulk(null);
    setNotice(`Replaced ${done} template${done === 1 ? '' : 's'}.${failed.length ? ` Failed: ${failed.join('; ')}` : ''}`);
    await load();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl text-xs text-hud-cream-mute">
          The 40 delivery templates. Editing a template does not change documents already created from it, and re-seeding never overwrites a template that has been edited or imported.
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN} onClick={() => void load()} aria-label="Refresh templates"><RefreshCw className="h-4 w-4" />Refresh</button>
          {canManage && (
            <>
              <button type="button" className={BTN} disabled={bulkBusy} onClick={() => bulkInput.current?.click()}><FileUp className="h-4 w-4" />Import .docx files</button>
              <input ref={bulkInput} type="file" multiple accept=".docx" className="hidden" aria-label="Import .docx files named NN ...docx"
                onChange={(e) => void pickBulk(e.target.files)} />
            </>
          )}
        </div>
      </div>

      {error && <ErrorBox message={error} />}
      {notice && <div role="status" className="rounded-lg border border-hud-emerald/40 bg-hud-emerald/10 px-3 py-2 text-sm text-hud-cream-soft">{notice}</div>}

      {rows === null ? (
        <div className="py-10 text-center text-sm text-hud-cream-mute">Loading templates…</div>
      ) : sorted.length === 0 && !error ? (
        <div className="py-10 text-center text-sm text-hud-cream-mute">No templates yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hud-line-soft">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="bg-hud-bg-card text-left text-[11px] uppercase tracking-wide text-hud-cream-mute">
              <tr>
                <th scope="col" className="px-3 py-2">#</th><th scope="col" className="px-3 py-2">Template</th>
                <th scope="col" className="px-3 py-2">Milestones</th><th scope="col" className="px-3 py-2">Feeds</th>
                <th scope="col" className="px-3 py-2">Ver.</th><th scope="col" className="px-3 py-2">Source</th>
                <th scope="col" className="px-3 py-2 text-right">Prompts</th><th scope="col" className="px-3 py-2">Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hud-line-soft">
              {sorted.map((t) => (
                <tr key={t.id} className={`hover:bg-hud-bg-card/60 ${t.enabled ? '' : 'opacity-60'}`}>
                  <td className="px-3 py-2 font-mono text-hud-cream-dim">{String(t.number).padStart(2, '0')}</td>
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => setOpenId(t.id)} className="text-left font-medium text-white hover:text-hud-gold-soft focus:outline-none focus-visible:underline">{t.title}</button>
                  </td>
                  <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{t.milestones.map((m) => <Badge key={m}>{m}</Badge>)}</div></td>
                  <td className="px-3 py-2 text-xs text-hud-cream-dim">{t.feeds.length ? t.feeds.join(', ') : '–'}</td>
                  <td className="px-3 py-2 text-hud-cream-dim">v{t.version}</td>
                  <td className="px-3 py-2"><Badge tone={SOURCE_TONE[t.source] ?? 'muted'}>{t.source}</Badge></td>
                  <td className="px-3 py-2 text-right text-hud-cream-dim">{t.placeholders.length}</td>
                  <td className="px-3 py-2"><Switch checked={t.enabled} disabled={!canManage} label={`${t.enabled ? 'Disable' : 'Enable'} template ${t.number}`} onChange={(v) => void toggle(t, v)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && <TemplateDrawer id={openId} canManage={canManage} onClose={() => setOpenId(null)} onChanged={() => void load()} />}

      <SlideInDrawer isOpen={!!bulk} onClose={() => !bulkBusy && setBulk(null)} title="Import .docx files" subtitle="Files are matched to templates by their two-digit number prefix" width="xl"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button type="button" className={BTN} disabled={bulkBusy} onClick={() => setBulk(null)}>Cancel</button>
            <button type="button" className={BTN_PRIMARY} disabled={bulkBusy || bulkReady.length === 0} onClick={() => void confirmBulk()}>
              {bulkBusy ? 'Replacing…' : `Replace ${bulkReady.length} template${bulkReady.length === 1 ? '' : 's'}`}
            </button>
          </div>
        }>
        <div className="space-y-3 p-6 text-sm">
          <p className="text-hud-cream-mute">Matched templates will have their body replaced (a new version, source "import"). Documents already created are not changed. Nothing is replaced until you confirm.</p>
          <ul className="divide-y divide-hud-line-soft rounded-lg border border-hud-line-soft">
            {(bulk ?? []).map((b) => (
              <li key={b.file} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0 break-all text-hud-cream-soft">{b.file}</span>
                {b.error ? <Badge tone="bad">{b.error}</Badge>
                  : b.template ? <Badge tone="good">→ {String(b.template.number).padStart(2, '0')} {b.template.title} · {unresolvedPlaceholders(b.html ?? '').length} prompts</Badge>
                    : <Badge tone="warn">{b.number === null ? 'no NN prefix, skipped' : `no template ${String(b.number).padStart(2, '0')}, skipped`}</Badge>}
              </li>
            ))}
          </ul>
        </div>
      </SlideInDrawer>
    </div>
  );
}

function TemplateDrawer({ id, canManage, onClose, onChanged }: { id: string; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const [tpl, setTpl] = useState<CaioTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'import'>('view');
  const [draft, setDraft] = useState('');
  const [loadKey, setLoadKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importHtml, setImportHtml] = useState<string | null>(null);
  const [importName, setImportName] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const t = await getTemplate(id);
      if (!t) { setError('Template not found.'); return; }
      setTpl(t); setDraft(t.body_html); setLoadKey((k) => k + 1); setDirty(false); setError(null);
    } catch (e) { setError(msg(e)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const close = () => {
    if (mode === 'edit' && dirty && !window.confirm('Discard your unsaved changes to this template?')) return;
    onClose();
  };

  const save = async () => {
    if (!tpl) return;
    setBusy(true);
    try { await updateTemplate(tpl.id, { body_html: draft }); setMode('view'); await load(); onChanged(); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(null);
    try { setImportHtml(await docxToHtml(file)); setImportName(file.name); setMode('import'); }
    catch (e) { setError(`Could not read the file: ${msg(e)}`); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  };

  const confirmImport = async () => {
    if (!tpl || importHtml === null) return;
    if (!window.confirm(`Replace the body of template ${tpl.number} with "${importName}"? This creates a new template version. Existing documents are not changed.`)) return;
    setBusy(true);
    try { await importTemplateBody(tpl.id, importHtml); setImportHtml(null); setMode('view'); await load(); onChanged(); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };

  const importPrompts = importHtml ? unresolvedPlaceholders(importHtml) : [];

  return (
    <SlideInDrawer isOpen onClose={close} width="2xl" icon={<FileText className="h-5 w-5" />}
      title={tpl ? `${String(tpl.number).padStart(2, '0')} ${tpl.title}` : 'Template'}
      subtitle={tpl ? `v${tpl.version} · ${tpl.source} · updated ${formatDate(tpl.updated_at)}` : undefined}>
      <div className="space-y-4 p-6">
        {error && <ErrorBox message={error} />}
        {!tpl && !error && <div className="py-10 text-center text-sm text-hud-cream-mute">Loading…</div>}
        {tpl && (
          <>
            {tpl.when_to_use && <p className="text-sm text-hud-cream-dim"><span className="font-semibold text-hud-cream-soft">When to use:</span> {tpl.when_to_use}</p>}
            <p className="text-xs text-hud-cream-mute">Editing this template does not change documents already created from it.</p>

            {canManage && (
              <div className="flex flex-wrap gap-2">
                {mode !== 'edit' && <button type="button" className={BTN} disabled={busy} onClick={() => { setDraft(tpl.body_html); setLoadKey((k) => k + 1); setDirty(false); setMode('edit'); }}><Pencil className="h-4 w-4" />Edit</button>}
                <button type="button" className={BTN} disabled={busy} onClick={() => fileInput.current?.click()}><Upload className="h-4 w-4" />Replace from .docx</button>
                <input ref={fileInput} type="file" accept=".docx" className="hidden" aria-label="Replace template from a .docx file" onChange={(e) => void pickFile(e.target.files?.[0])} />
              </div>
            )}

            {mode === 'view' && (
              <div className="rounded-lg border border-hud-line-soft bg-hud-bg-deep/40 px-4 py-3"><ProseView html={tpl.body_html} /></div>
            )}

            {mode === 'edit' && (
              <>
                <DocumentEditor html={draft} loadKey={loadKey} editable onChange={(h) => { setDraft(h); setDirty(true); }} />
                <div className="flex justify-end gap-2">
                  <button type="button" className={BTN} disabled={busy} onClick={() => { if (!dirty || window.confirm('Discard your unsaved changes?')) setMode('view'); }}>Cancel</button>
                  <button type="button" className={BTN_PRIMARY} disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save template'}</button>
                </div>
              </>
            )}

            {mode === 'import' && importHtml !== null && (
              <div className="space-y-3">
                <div className="text-sm text-hud-cream-soft">Preview of <span className="font-semibold">{importName}</span></div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-hud-cream-dim">
                  {importPrompts.length === 0 ? <Badge tone="warn">no bold [UPPER CASE] prompts detected</Badge>
                    : <><span>{importPrompts.length} prompt{importPrompts.length === 1 ? '' : 's'} detected:</span>{importPrompts.map((p) => <Badge key={p} tone="accent">[{p}]</Badge>)}</>}
                </div>
                <div className="max-h-[50dvh] overflow-y-auto rounded-lg border border-hud-line-soft bg-hud-bg-deep/40 px-4 py-3"><ProseView html={importHtml} /></div>
                <div className="flex justify-end gap-2">
                  <button type="button" className={BTN} disabled={busy} onClick={() => { setImportHtml(null); setMode('view'); }}>Cancel</button>
                  <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void confirmImport()}>{busy ? 'Replacing…' : 'Replace template body'}</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </SlideInDrawer>
  );
}

export default TemplatesAdmin;
