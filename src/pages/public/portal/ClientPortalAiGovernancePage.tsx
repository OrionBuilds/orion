import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ShieldCheck, FileText, ChevronDown, ChevronRight, ArrowLeft, Printer, Loader2 } from 'lucide-react';
import {
  getCaioPortal, getCaioPortalDocument,
  type CaioPortalResult, type CaioPortalDocument, type CaioPortalRegister,
} from '../../../services/clientPortalCaio';
import {
  gateStatus, safeUrl, sanitizeCaioHtml, truncateText, formatCaioDate, cellToText, printDocument,
} from '../../../utils/caioPortal';

const TONE: Record<string, string> = {
  neutral: 'bg-hud-bg-mid text-hud-cream-mute',
  good: 'bg-hud-emerald/15 text-hud-emerald',
  warn: 'bg-hud-rust/15 text-hud-rust',
  stop: 'bg-hud-plum/15 text-hud-plum',
};

function Empty({ text }: { text: string }) {
  return (
    <div className="bg-hud-bg-elev rounded-2xl border border-hud-line text-center py-12 px-4">
      <ShieldCheck className="w-10 h-10 text-hud-cream-soft mx-auto mb-3" />
      <p className="text-sm text-hud-cream-dim">{text}</p>
    </div>
  );
}

function Cell({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  const text = cellToText(value);
  if (!text) return <span className="text-hud-cream-dim">—</span>;
  const url = safeUrl(text);
  if (url) {
    return <a href={url} target="_blank" rel="noopener noreferrer" className="text-hud-teal underline break-all">{text}</a>;
  }
  const { text: short, truncated } = truncateText(text);
  return (
    <span className="whitespace-pre-wrap break-words">
      {open || !truncated ? text : short}
      {truncated && (
        <button onClick={() => setOpen(!open)} className="ml-1 text-xs text-hud-teal underline">
          {open ? 'less' : 'more'}
        </button>
      )}
    </span>
  );
}

function RegisterSection({ register }: { register: CaioPortalRegister }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-hud-bg-elev rounded-2xl border border-hud-line overflow-hidden">
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 sm:px-5 py-4 text-left">
        {open ? <ChevronDown className="w-4 h-4 flex-none" /> : <ChevronRight className="w-4 h-4 flex-none" />}
        <span className="text-sm font-semibold text-hud-cream-soft flex-1 min-w-0">{register.title}</span>
        <span className="text-xs text-hud-cream-mute">{register.rows.length} {register.rows.length === 1 ? 'entry' : 'entries'}</span>
      </button>
      {open && (
        <div className="px-4 sm:px-5 pb-4 space-y-3">
          {register.purpose && <p className="text-sm text-hud-cream-mute">{register.purpose}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-hud-line">
                  {register.columns.map((c) => (
                    <th key={c.field_key} className="py-2 pr-4 text-xs font-semibold text-hud-cream-mute whitespace-nowrap">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-hud-line">
                {register.rows.map((r) => (
                  <tr key={r.record_key} className="align-top">
                    {register.columns.map((c) => (
                      <td key={c.field_key} className="py-2 pr-4 min-w-[8rem] text-hud-cream-soft">
                        <Cell value={r.data?.[c.field_key]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function DocumentReader({ doc, onBack }: { doc: CaioPortalDocument; onBack: () => void }) {
  const html = useMemo(() => sanitizeCaioHtml(doc.body_html), [doc.body_html]);
  const [blocked, setBlocked] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <button onClick={onBack} className="text-sm text-hud-teal flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <button onClick={() => setBlocked(!printDocument(doc.title, html))}
          className="text-sm px-3 py-1.5 rounded-lg border border-hud-line text-hud-cream-soft flex items-center gap-1.5">
          <Printer className="w-4 h-4" /> Print / Save as PDF
        </button>
      </div>
      {blocked && <p className="text-xs text-hud-rust">Your browser blocked the print window. Allow pop-ups and try again.</p>}
      <div>
        <h2 className="text-lg font-bold text-hud-cream-soft">{doc.title}</h2>
        <p className="text-xs text-hud-cream-mute mt-0.5">
          Version {doc.version ?? '—'} · Approved {formatCaioDate(doc.approved_at)}
          {doc.next_review ? ` · Next review ${formatCaioDate(doc.next_review)}` : ''}
        </p>
      </div>
      <div className="bg-hud-bg-elev rounded-2xl border border-hud-line p-4 sm:p-6 text-sm text-hud-cream-soft leading-relaxed overflow-x-auto
        [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-lg [&_h2]:font-bold [&_h3]:font-semibold [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5
        [&_table]:w-full [&_th]:border [&_td]:border [&_th]:border-hud-line [&_td]:border-hud-line [&_th]:p-2 [&_td]:p-2 [&_a]:text-hud-teal [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3"
        dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function ClientPortalAiGovernancePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [data, setData] = useState<CaioPortalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<CaioPortalDocument | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getCaioPortal(projectId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load this page.'); });
    return () => { cancelled = true; };
  }, [projectId]);

  async function openDoc(id: string) {
    if (!projectId) return;
    setDocLoading(true); setDocError(null);
    try { setDoc(await getCaioPortalDocument(projectId, id)); }
    catch { setDocError('This document could not be opened.'); }
    finally { setDocLoading(false); }
  }

  if (error) return <Empty text="We could not load this page right now. Please try again shortly." />;
  if (!data) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-hud-gold" /></div>;
  }
  if (doc) return <DocumentReader doc={doc} onBack={() => setDoc(null)} />;
  if (!data.enabled) return <Empty text="Your adviser has not published anything here yet." />;

  const registers = data.registers.filter((r) => r.rows.length > 0);
  const nothing = data.gates.length === 0 && data.documents.length === 0 && registers.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-hud-cream-soft">AI governance</h2>
        {data.engagement.client && <p className="text-sm text-hud-cream-mute mt-0.5">{data.engagement.client}</p>}
      </div>

      {nothing && <Empty text="Your adviser has not published anything here yet." />}

      {data.gates.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-hud-cream-soft">Milestones</h3>
          <div className="bg-hud-bg-elev rounded-2xl border border-hud-line divide-y divide-hud-line">
            {data.gates.map((g) => {
              const s = gateStatus(g.status);
              return (
                <div key={g.gate_key} className="flex items-center gap-3 px-4 sm:px-5 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-hud-cream-soft">{g.label}</div>
                    <div className="text-xs text-hud-cream-mute">Due {formatCaioDate(g.due_date)}</div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-1 rounded-full whitespace-nowrap ${TONE[s.tone]}`}>{s.label}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {data.documents.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-hud-cream-soft">Documents</h3>
          {docError && <p className="text-xs text-hud-rust">{docError}</p>}
          <div className="bg-hud-bg-elev rounded-2xl border border-hud-line divide-y divide-hud-line">
            {data.documents.map((d) => (
              <button key={d.id} onClick={() => openDoc(d.id)} disabled={docLoading}
                className="w-full flex items-center gap-3 px-4 sm:px-5 py-3 text-left hover:bg-hud-bg-mid/40 disabled:opacity-60">
                <FileText className="w-5 h-5 text-hud-cream-mute flex-none" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-hud-cream-soft break-words">{d.title}</div>
                  <div className="text-xs text-hud-cream-mute">
                    Version {d.version ?? '—'} · Approved {formatCaioDate(d.approved_at)}
                    {d.next_review ? ` · Next review ${formatCaioDate(d.next_review)}` : ''}
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-hud-cream-soft flex-none" />
              </button>
            ))}
          </div>
        </section>
      )}

      {registers.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-hud-cream-soft">Registers</h3>
          {registers.map((r) => <RegisterSection key={r.register_key} register={r} />)}
        </section>
      )}
    </div>
  );
}

/** Home-page card: renders only when the engagement's portal is on. */
export function AiGovernanceHomeLink({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getCaioPortal(projectId).then((d) => { if (!cancelled) setEnabled(d.enabled); }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);
  if (!enabled) return null;
  return (
    <button onClick={() => navigate(`/client-portal/projects/${projectId}/ai-governance`)}
      className="w-full flex items-center gap-3 bg-hud-bg-elev rounded-2xl border border-hud-line px-5 py-4 text-left hover:bg-hud-bg-mid/40">
      <ShieldCheck className="w-5 h-5 text-hud-gold flex-none" />
      <span className="flex-1 text-sm font-semibold text-hud-cream-soft">AI governance</span>
      <ChevronRight className="w-4 h-4 text-hud-cream-soft" />
    </button>
  );
}

export default ClientPortalAiGovernancePage;
