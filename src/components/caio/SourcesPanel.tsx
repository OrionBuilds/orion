/** Sources: upload interview material, review flagged sources, link OS meetings and resolve meetings that need a client. */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Upload } from 'lucide-react';
import { Panel } from '../agent-health/ui';
import { getErrorMessage } from '../../lib/errors';
import type { Engagement } from '../../services/caio';
import {
  allowSource, blockSource, ignoreMeeting, linkMeeting, listLinkableMeetings, listNeedsLink, listSources, uploadSources,
  type CaioSource, type MeetingOption, type NeedsLinkMeeting, type SourceKind,
} from '../../services/caioAutomation';
import { ErrorBox, ToneBadge, formatDate } from './ui';
import { btnGhost, btnPrimary, inputCls, labelCls } from './styles';
import { checkFiles } from './automationLogic';

export interface SourcesPanelProps { engagement: Engagement; canManage: boolean }

const ACCEPT = '.docx,.pdf,.txt,.md,.vtt';
const KINDS: { value: SourceKind; label: string }[] = [
  { value: 'transcript', label: 'Interview transcript' }, { value: 'summary', label: 'Summary' }, { value: 'interview_notes', label: 'Interview notes' },
  { value: 'public_research', label: 'Public research' }, { value: 'policy', label: 'Policy or document' }, { value: 'other', label: 'Other' },
];
const PII_LABEL: Record<string, string> = { ssn: 'a Social Security-style number', account_number: 'an account number', card_number: 'a payment card number', secret: 'a password or key', api_key: 'a password or key' };

function statusChip(s: CaioSource) {
  if (s.process_status === 'blocked') return <ToneBadge tone="bad">blocked</ToneBadge>;
  if (s.process_status === 'needs_review') return <ToneBadge tone="warn">needs review</ToneBadge>;
  return <ToneBadge tone="good">ready</ToneBadge>;
}
function extractionChip(s: CaioSource) {
  switch (s.extraction_status) {
    case 'done': return <ToneBadge tone="good">extraction done</ToneBadge>;
    case 'failed': return <ToneBadge tone="bad">extraction failed</ToneBadge>;
    case 'no_text': return <ToneBadge tone="warn">no text found</ToneBadge>;
    case 'running': return <ToneBadge tone="muted">extracting</ToneBadge>;
    case 'skipped': return <ToneBadge tone="muted">skipped</ToneBadge>;
    default: return <ToneBadge tone="muted">extraction pending</ToneBadge>;
  }
}

export function SourcesPanel({ engagement, canManage }: SourcesPanelProps) {
  const [sources, setSources] = useState<CaioSource[] | null>(null);
  const [needsLink, setNeedsLink] = useState<NeedsLinkMeeting[] | null>(null);
  const [meetings, setMeetings] = useState<MeetingOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // upload form
  const [files, setFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<{ name: string; reason: string }[]>([]);
  const [kind, setKind] = useState<SourceKind>('transcript');
  const [department, setDepartment] = useState('');
  const [interviewees, setInterviewees] = useState('');
  const [consent, setConsent] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  // meeting link form
  const [meetingId, setMeetingId] = useState('');
  const [meetingConsent, setMeetingConsent] = useState(false);

  const load = useCallback(async () => {
    const [s, n, m] = await Promise.allSettled([listSources(engagement.id), listNeedsLink(), listLinkableMeetings()]);
    const errs: string[] = [];
    if (s.status === 'fulfilled') setSources(s.value); else { setSources([]); errs.push(getErrorMessage(s.reason, 'Could not load sources')); }
    if (n.status === 'fulfilled') setNeedsLink(n.value); else { setNeedsLink([]); errs.push(getErrorMessage(n.reason, 'Could not load meetings that need a client')); }
    if (m.status === 'fulfilled') setMeetings(m.value); else { setMeetings([]); errs.push(getErrorMessage(m.reason, 'Could not load meetings')); }
    setError(errs.length ? errs.join(' ') : null);
  }, [engagement.id]);
  useEffect(() => { void load(); }, [load]);

  const addFiles = (list: FileList | File[]) => {
    const merged = [...files, ...Array.from(list)];
    const r = checkFiles(merged);
    setFiles(r.ok); setRejected(r.rejected);
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); if (canManage) addFiles(e.dataTransfer.files); };

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key); setError(null); setNotice(null);
    try { const msg = await fn(); if (msg) setNotice(msg); await load(); } catch (e) { setError(getErrorMessage(e, 'The request failed')); } finally { setBusy(null); }
  };

  const upload = () => run('upload', async () => {
    const res = await uploadSources({ engagementId: engagement.id, files, kind, department, interviewees, consent });
    setFiles([]); setRejected([]); setConsent(false);
    const skipped = res.skipped.length ? ` ${res.skipped.length} skipped: ${res.skipped.map((s) => `${s.filename} (${s.reason})`).join('; ')}.` : '';
    return `${res.sources.length} source${res.sources.length === 1 ? '' : 's'} added.${skipped}`;
  });

  const link = (id: string) => run(`link-${id}`, async () => {
    await linkMeeting(engagement.id, id, { consent: true });
    setMeetingId(''); setMeetingConsent(false);
    return 'Meeting linked.';
  });

  return (
    <div className="space-y-4">
      {error && <ErrorBox message={error} />}
      {notice && <p className="text-sm text-hud-emerald" role="status">{notice}</p>}

      {canManage && (
        <Panel title="Add interview material">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (consent && files.length) void upload(); }}>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
              className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center text-sm ${dragging ? 'border-hud-gold bg-hud-gold/10' : 'border-hud-line-soft'}`}>
              <Upload className="h-5 w-5 text-hud-cream-dim" aria-hidden="true" />
              <p className="text-hud-cream-soft">Drop files here, or choose them. Accepted: .docx .pdf .txt .md .vtt, up to 25 MB each, 10 at a time.</p>
              <button type="button" className={btnGhost} onClick={() => picker.current?.click()}>Choose files</button>
              <input ref={picker} type="file" multiple accept={ACCEPT} className="sr-only" aria-label="Choose interview files" tabIndex={-1}
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            </div>
            {files.length > 0 && (
              <ul className="space-y-1 text-sm text-hud-cream-soft" aria-label="Files to upload">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-hud-bg-card/60 px-3 py-1.5">
                    <span className="min-w-0 truncate">{f.name} <span className="text-hud-cream-mute">({Math.max(1, Math.round(f.size / 1024))} KB)</span></span>
                    <button type="button" className="text-xs text-hud-cream-dim hover:text-white" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
            {rejected.length > 0 && <ul className="text-xs text-hud-rust" role="alert">{rejected.map((r) => <li key={r.name}>{r.name}: {r.reason}</li>)}</ul>}
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="src-kind" className={labelCls}>Kind</label>
                <select id="src-kind" className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as SourceKind)}>
                  {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="src-dept" className={labelCls}>Department (optional)</label>
                <input id="src-dept" className={inputCls} value={department} onChange={(e) => setDepartment(e.target.value)} />
              </div>
              <div>
                <label htmlFor="src-who" className={labelCls}>Interviewees (optional)</label>
                <input id="src-who" className={inputCls} value={interviewees} onChange={(e) => setInterviewees(e.target.value)} placeholder="Names and roles" />
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm text-hud-cream-soft">
              <input type="checkbox" className="mt-1 accent-[#c9a24a]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>I have permission to process this material</span>
            </label>
            <button type="submit" className={btnPrimary} disabled={busy === 'upload' || !consent || files.length === 0}>
              {busy === 'upload' ? 'Uploading...' : files.length > 1 ? `Upload ${files.length} files` : 'Upload file'}
            </button>
          </form>
        </Panel>
      )}

      <Panel title={`Sources${sources ? ` (${sources.length})` : ''}`}>
        {sources === null ? <p className="text-sm text-hud-cream-mute" role="status">Loading sources...</p>
          : sources.length === 0 ? <p className="text-sm text-hud-cream-mute">No sources yet. Upload a transcript or link a meeting.</p> : (
            <ul className="divide-y divide-hud-line-soft">
              {sources.map((s) => (
                <li key={s.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-white">{s.title}</div>
                      <div className="text-xs text-hud-cream-mute">
                        {KINDS.find((k) => k.value === s.kind)?.label ?? s.kind}{s.department ? ` · ${s.department}` : ''}{s.interviewees ? ` · ${s.interviewees}` : ''}
                        {' '}· {s.char_count.toLocaleString()} characters · added {formatDate(s.created_at)}{s.meeting_transcription_id ? ' · OS meeting' : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">{statusChip(s)}{extractionChip(s)}</div>
                  </div>
                  {s.extraction_error && <p className="text-xs text-hud-plum">{s.extraction_error}</p>}
                  {s.process_status === 'needs_review' && (
                    <div className="space-y-2 rounded-lg border border-hud-rust/40 bg-hud-rust/10 p-3 text-sm text-hud-cream-soft">
                      <p>
                        {s.pii_flags.length > 0
                          ? <>This source may contain sensitive data: {s.pii_flags.map((f) => `${PII_LABEL[f.type] ?? f.type}${f.count ? ` (${f.count})` : ''}`).join(', ')}. </>
                          : <>You have not confirmed permission to process this source. </>}
                        Nothing is extracted until you allow it. Allowing it confirms you have permission to process this material.
                      </p>
                      {canManage && (
                        <div className="flex gap-2">
                          <button type="button" className={btnPrimary} disabled={busy === `allow-${s.id}`} onClick={() => void run(`allow-${s.id}`, () => allowSource(s.id))}>Allow</button>
                          <button type="button" className={btnGhost} disabled={busy === `block-${s.id}`} onClick={() => void run(`block-${s.id}`, () => blockSource(s.id))}>Block</button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
      </Panel>

      {canManage && (
        <Panel title="Link an OS meeting">
          {meetings === null ? <p className="text-sm text-hud-cream-mute" role="status">Loading meetings...</p>
            : meetings.length === 0 ? <p className="text-sm text-hud-cream-mute">No recent meetings are waiting to be linked.</p> : (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (meetingId && meetingConsent) void link(meetingId); }}>
                <div>
                  <label htmlFor="mtg-pick" className={labelCls}>Recent meeting</label>
                  <select id="mtg-pick" className={inputCls} value={meetingId} onChange={(e) => setMeetingId(e.target.value)}>
                    <option value="">Choose a meeting</option>
                    {meetings.map((m) => <option key={m.id} value={m.id}>{m.meeting_title || 'Untitled meeting'} · {formatDate(m.meeting_date)}</option>)}
                  </select>
                </div>
                <label className="flex items-start gap-2 text-sm text-hud-cream-soft">
                  <input type="checkbox" className="mt-1 accent-[#c9a24a]" checked={meetingConsent} onChange={(e) => setMeetingConsent(e.target.checked)} />
                  <span>I have permission to process this material</span>
                </label>
                <button type="submit" className={btnPrimary} disabled={!meetingId || !meetingConsent || busy === `link-${meetingId}`}>Link to this engagement</button>
              </form>
            )}
        </Panel>
      )}

      <Panel title={`Meetings that need a client${needsLink && needsLink.length ? ` (${needsLink.length})` : ''}`}>
        {needsLink === null ? <p className="text-sm text-hud-cream-mute" role="status">Loading meetings...</p>
          : needsLink.length === 0 ? <p className="text-sm text-hud-cream-mute">No meetings are waiting for a client.</p> : (
            <ul className="space-y-2">
              {needsLink.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-hud-bg-card/60 px-3 py-2 text-sm text-hud-cream-soft">
                  <span className="min-w-0 truncate">{n.meeting?.meeting_title || 'Untitled meeting'} <span className="text-hud-cream-mute">· {formatDate(n.meeting?.meeting_date)}</span></span>
                  {canManage && (
                    <span className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1.5 text-xs text-hud-cream-dim">
                        <input type="checkbox" className="accent-[#c9a24a]" checked={meetingConsent} onChange={(e) => setMeetingConsent(e.target.checked)} />
                        I have permission to process this material
                      </label>
                      <button type="button" className={btnPrimary} disabled={!meetingConsent || busy === `link-${n.meeting_transcription_id}`}
                        onClick={() => void link(n.meeting_transcription_id)}>Link to this engagement</button>
                      <button type="button" className={btnGhost} disabled={busy === `ignore-${n.id}`}
                        onClick={() => void run(`ignore-${n.id}`, () => ignoreMeeting(n.meeting_transcription_id))}>Ignore</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </div>
  );
}

export default SourcesPanel;
