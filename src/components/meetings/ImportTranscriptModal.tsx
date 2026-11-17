import { useState } from 'react';
import { X, Loader2, Upload, CheckCircle2, AlertCircle } from 'lucide-react';
import { importMeetingTranscript, parseAttendeeLines, type ImportTranscriptResult } from '../../services/meetingImport';
import { Portal } from '../shared/Portal';
import { ConsentFields } from './ConsentFields';
import { EMPTY_CONSENT, type ConsentValue } from './consentState';

interface Props {
  onClose: () => void;
  /** Called with the new meeting's id (null if the import returned none). */
  onImported: (meetingTranscriptionId: string | null) => void;
}

/**
 * Paste or upload a meeting transcript the OS can't fetch itself (a meeting the owner didn't organise,
 * a Zoom/phone export). Clara digests it the same way as a Teams meeting: tasks, Friday handoffs,
 * follow-up drafts and an SMS digest.
 */
export function ImportTranscriptModal({ onClose, onImported }: Props) {
  const [title, setTitle] = useState('');
  const [attendees, setAttendees] = useState('');
  const [meetingDate, setMeetingDate] = useState('');
  const [transcript, setTranscript] = useState('');
  const [consent, setConsent] = useState<ConsentValue>(EMPTY_CONSENT);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportTranscriptResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) { setError('File is larger than 2 MB — paste the text instead.'); return; }
    setError(null);
    setTranscript(await file.text());
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
  }

  async function submit() {
    if (transcript.trim().length < 20) { setError('Transcript is too short.'); return; }
    if (!consent.basis) { setError('Say how participants were told about the recording.'); return; }
    setBusy(true);
    setError(null);
    const res = await importMeetingTranscript({
      title: title.trim() || 'Imported meeting',
      transcript,
      attendees: parseAttendeeLines(attendees),
      meetingDate: meetingDate ? new Date(meetingDate).toISOString() : undefined,
      consentBasis: consent.basis,
      consentNote: consent.note || undefined,
    });
    setBusy(false);
    if (res.success) { setResult(res); onImported(res.meetingTranscriptionId ?? null); }
    else setError(res.error || 'Import failed.');
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-full w-full max-w-2xl overflow-y-auto rounded-xl border border-hud-bg-elev bg-hud-bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-hud-bg-elev px-5 py-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-hud-text">
            <Upload className="h-5 w-5 text-hud-gold" /> Import transcript
          </h2>
          <button onClick={onClose} className="text-hud-text-dim hover:text-hud-text"><X className="h-5 w-5" /></button>
        </div>

        {result ? (
          <div className="space-y-3 p-6">
            <div className="flex items-center gap-2 text-green-400"><CheckCircle2 className="h-5 w-5" /> Imported and digested.</div>
            <ul className="text-sm text-hud-text-dim">
              <li>{result.items} action item(s) extracted</li>
              <li>{result.tasksCreated} task(s) created · {result.fridayHandoffs} sent to Friday{result.motionTasks ? ` · ${result.motionTasks} added to Motion` : ''}</li>
              <li>{result.contactsLinked} contact(s) linked · {result.followUpDrafts} follow-up draft(s) sent to Approvals for your review</li>
            </ul>
            <button onClick={onClose} className="rounded-lg bg-hud-gold px-4 py-2 text-sm font-medium text-black">Done</button>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm text-hud-text-dim">Title
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Acme kickoff"
                  className="mt-1 w-full rounded-lg border border-hud-bg-elev bg-hud-bg px-3 py-2 text-sm text-hud-text" />
              </label>
              <label className="text-sm text-hud-text-dim">Meeting date
                <input type="datetime-local" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-hud-bg-elev bg-hud-bg px-3 py-2 text-sm text-hud-text" />
              </label>
            </div>
            <label className="block text-sm text-hud-text-dim">Attendees <span className="opacity-60">(one per line: "Jane Doe &lt;jane@acme.com&gt;")</span>
              <textarea value={attendees} onChange={(e) => setAttendees(e.target.value)} rows={2}
                className="mt-1 w-full rounded-lg border border-hud-bg-elev bg-hud-bg px-3 py-2 text-sm text-hud-text" />
            </label>
            <label className="block text-sm text-hud-text-dim">Transcript
              <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={10} placeholder="Paste the transcript or notes here (Motion, Zoom, a phone recording…)"
                className="mt-1 w-full rounded-lg border border-hud-bg-elev bg-hud-bg px-3 py-2 font-mono text-xs text-hud-text" />
            </label>
            <ConsentFields value={consent} onChange={setConsent} />
            <div className="flex items-center justify-between">
              <label className="cursor-pointer text-sm text-hud-gold hover:underline">
                Upload a .txt/.vtt file
                <input type="file" accept=".txt,.vtt,.md,text/plain" className="hidden" onChange={onFile} />
              </label>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="rounded-lg border border-hud-bg-elev px-4 py-2 text-sm text-hud-text-dim">Cancel</button>
                <button onClick={submit} disabled={busy} className="flex items-center gap-2 rounded-lg bg-hud-gold px-4 py-2 text-sm font-medium text-black disabled:opacity-50">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />} Import & digest
                </button>
              </div>
            </div>
            {error && <div className="flex items-center gap-2 text-sm text-red-400"><AlertCircle className="h-4 w-4" /> {error}</div>}
          </div>
        )}
      </div>
    </div></Portal>
  );
}
