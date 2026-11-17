import { useEffect, useRef, useState } from 'react';
import { AlertCircle, AudioLines, CheckCircle, Loader2 } from 'lucide-react';
import type { MeetingTranscription } from '../../types';
import {
  canTranscribe,
  getMeetingTranscriptionState,
  startRecordingTranscription,
} from '../../services/proposalSources';
import { ConsentFields } from './ConsentFields';
import { EMPTY_CONSENT, type ConsentValue } from './consentState';

interface Props {
  meeting: MeetingTranscription;
  /** Called with the new transcript once speech-to-text finishes. */
  onTranscribed?: (meetingId: string, transcript: string) => void;
}

const POLL_MS = 8000;

/**
 * "Transcribe recording" for a meeting that has a recording but no transcript. Starts the
 * background speech-to-text job and polls meeting_transcriptions until it completes or fails.
 */
export function TranscribeRecordingButton({ meeting, onTranscribed }: Props) {
  const [status, setStatus] = useState(meeting.transcription_status ?? null);
  const [error, setError] = useState<string | null>(meeting.transcription_error ?? null);
  const [consent, setConsent] = useState<ConsentValue>(EMPTY_CONSENT);
  const [asking, setAsking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Held in a ref so an inline callback from the parent doesn't restart the polling loop.
  const onDone = useRef(onTranscribed);
  onDone.current = onTranscribed;

  const running = status === 'queued' || status === 'processing';

  useEffect(() => {
    if (!running) return;
    let active = true;
    const poll = async () => {
      const row = await getMeetingTranscriptionState(meeting.id).catch(() => null);
      if (!active || !row) return;
      setStatus(row.transcription_status ?? null);
      setError(row.transcription_error ?? null);
      if (row.transcription_status === 'completed' && row.transcript_text) {
        onDone.current?.(meeting.id, row.transcript_text);
      } else if (row.transcription_status === 'queued' || row.transcription_status === 'processing') {
        timer.current = setTimeout(poll, POLL_MS);
      }
    };
    timer.current = setTimeout(poll, POLL_MS);
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [running, meeting.id]);

  if (!canTranscribe(meeting) && status !== 'completed') return null;

  const start = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setError(null);
    // A meeting with no recorded consent basis asks first; the answer is stored as the audit trail.
    if (!meeting.consent_basis && !consent.basis) { setAsking(true); return; }
    try {
      const r = await startRecordingTranscription(meeting.id, consent.basis ? { basis: consent.basis, note: consent.note || undefined } : undefined);
      setAsking(false);
      setStatus(r.status as typeof status);
      if (r.error) setError(r.error);
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : 'Could not start transcription');
    }
  };

  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-hud-emerald">
        <CheckCircle className="w-3 h-3" /> Transcribed from recording
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={start}
        disabled={running}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md bg-hud-bg-elev/70 border border-hud-bg-elev text-hud-cream-soft hover:text-white disabled:opacity-60"
        title="Run speech-to-text on the meeting recording"
      >
        {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <AudioLines className="w-3 h-3" />}
        {running ? 'Transcribing recording… (runs in the background)' : status === 'failed' ? 'Retry transcription' : 'Transcribe recording'}
      </button>
      {asking && (
        <div className="basis-full">
          <ConsentFields value={consent} onChange={setConsent} />
          <p className="mt-1 text-[11px] text-hud-cream-mute">Pick a basis, then press the button again.</p>
        </div>
      )}
      {error && (status === 'failed' || status === 'not_configured') && (
        <span className="inline-flex items-center gap-1 text-[11px] text-hud-rust" title={error}>
          <AlertCircle className="w-3 h-3" />
          {status === 'not_configured' ? 'Speech-to-text not configured' : error.slice(0, 90)}
        </span>
      )}
    </div>
  );
}
