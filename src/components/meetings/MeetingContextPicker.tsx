import { useEffect, useRef, useState } from 'react';
import { Calendar, Clock, Users, Video, CheckCircle, FileText, StickyNote, Search, Upload, Loader2, Globe } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getMeetingTranscriptions, getMeetingTranscriptionsByContact } from '../../services/meetingTranscriptions';
import { searchAllTranscripts } from '../../services/meetingsHub';
import { MeetAccessBanner } from './MeetAccessBanner';
import { TranscribeRecordingButton } from './TranscribeRecordingButton';
import { ImportTranscriptModal } from './ImportTranscriptModal';
import type { MeetingTranscription } from '../../types';
import { formatDateShort } from '../../utils/formatters';

type PickerView = 'mine' | 'team' | 'all';

interface MeetingContextPickerProps {
  /** The client the document is for. Without one the picker opens on All meetings. */
  contactId?: string | null;
  selectedIds: string[];
  onToggle: (meetingId: string) => void;
  /** Optional heading override. */
  title?: string;
}

const VIEW_HINT: Record<PickerView, string> = {
  mine: 'Your meetings with this client',
  team: "Anyone's meetings with this client",
  all: 'Every Google Meet and Teams meeting, including ones not linked to this client. Search transcripts and notes.',
};

/**
 * Picks meetings to ground an AI generation (proposal, contract, estimate) in. Shared by the
 * proposal builder and the contract flows so the "what did we actually agree" source list behaves
 * identically everywhere. This is also where meetings are browsed, searched and imported now that
 * the standalone Meetings module is gone.
 *
 * Client views (Mine / All team) list meetings linked to the contact; All meetings lists the whole
 * org's meetings, because many calls never get a contact link (internal calls, attendees who
 * aren't contacts).
 */
export function MeetingContextPicker({
  contactId,
  selectedIds,
  onToggle,
  title = 'Meetings',
}: MeetingContextPickerProps) {
  const { user, hasPermission } = useAuth();
  const orgId = user?.organization_id;
  const canImport = hasPermission('meetings.manage');
  const [view, setView] = useState<PickerView>(contactId ? 'mine' : 'all');
  const [meetings, setMeetings] = useState<MeetingTranscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A contact chosen later (or cleared) moves the default view with it.
  useEffect(() => {
    if (!contactId && view !== 'all') setView('all');
  }, [contactId, view]);

  // Transcript search, debounced 300ms (All meetings only).
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setDebouncedTerm(searchTerm.trim()), 300);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [searchTerm]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const load = async (): Promise<MeetingTranscription[]> => {
      if (view !== 'all') {
        if (!contactId) return [];
        return getMeetingTranscriptionsByContact(contactId, { scope: view === 'mine' ? 'mine' : 'org', userId: user?.id });
      }
      if (debouncedTerm && orgId) {
        const results = await searchAllTranscripts(orgId, debouncedTerm);
        return results.flatMap((r) => (r.meeting ? [r.meeting] : []));
      }
      return (await getMeetingTranscriptions({}, 1, 50)).data;
    };
    load()
      .then((data) => { if (active) setMeetings(data); })
      .catch(() => { if (active) setMeetings([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [contactId, view, debouncedTerm, orgId, user?.id, reloadKey]);

  const handleImported = (meetingId: string | null) => {
    // An imported transcript may not be linked to this client: show it under All meetings, picked.
    setSearchTerm('');
    setView('all');
    setReloadKey((k) => k + 1);
    if (meetingId && !selectedIds.includes(meetingId)) onToggle(meetingId);
  };

  const hiddenSelected = selectedIds.filter((id) => !meetings.some((m) => m.id === id)).length;

  const viewButton = (v: PickerView, label: string, icon?: React.ReactNode) => (
    <button
      type="button"
      onClick={() => setView(v)}
      className={`px-2.5 py-1 text-xs rounded-md transition-colors inline-flex items-center gap-1 ${
        view === v ? 'bg-hud-bg-elev text-white' : 'text-hud-cream-dim hover:text-hud-cream-soft'
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="space-y-3">
      <MeetAccessBanner />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="block text-sm font-medium text-hud-cream-soft flex items-center gap-2">
          <Video className="w-4 h-4" />
          {title}
          {selectedIds.length > 0 && (
            <span className="text-xs font-normal text-hud-gold-soft">{selectedIds.length} selected</span>
          )}
        </label>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-hud-bg-card border border-hud-bg-elev rounded-lg p-0.5">
            {contactId && viewButton('mine', 'Mine')}
            {contactId && viewButton('team', 'All team', <Users className="w-3 h-3" />)}
            {viewButton('all', 'All meetings', <Globe className="w-3 h-3" />)}
          </div>
          {canImport && (
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-hud-bg-card border border-hud-bg-elev text-hud-cream-soft hover:text-white hover:border-hud-cream-mute transition-colors"
            >
              <Upload className="w-3 h-3" />
              Import transcript
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-hud-cream-mute -mt-1">{VIEW_HINT[view]}</p>

      {view === 'all' && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search meeting transcripts, notes, titles…"
            className="w-full pl-9 pr-9 py-2 text-sm bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:border-hud-gold/60"
          />
          {loading && debouncedTerm && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute animate-spin" />
          )}
        </div>
      )}

      {hiddenSelected > 0 && !loading && (
        <p className="text-xs text-hud-cream-dim">
          {hiddenSelected} selected meeting{hiddenSelected !== 1 ? 's are' : ' is'} not in this view.
        </p>
      )}

      {loading && !debouncedTerm ? (
        <p className="text-xs text-hud-cream-mute">Loading meetings…</p>
      ) : meetings.length === 0 ? (
        <div className="text-center py-4 bg-hud-bg-card/40 rounded-lg border border-hud-bg-elev/50">
          <p className="text-sm text-hud-cream-dim">
            {view === 'all'
              ? debouncedTerm ? `No meetings match "${debouncedTerm}".` : 'No meetings yet.'
              : `No ${view === 'mine' ? 'meetings of yours' : 'team meetings'} with this client.`}
          </p>
          <p className="text-xs text-hud-cream-mute mt-0.5">
            {view === 'mine'
              ? 'Try "All team" or "All meetings": the call may not be linked to this client.'
              : view === 'team'
                ? 'Try "All meetings": the call may not be linked to this client.'
                : 'Transcripts appear once a Google Meet or Teams meeting has been processed, or after you import one.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {meetings.map((m) => {
            const selected = selectedIds.includes(m.id);
            const hasTranscript = !!m.transcript_text;
            const hasSummary = !!m.summary;
            return (
              <div key={m.id} className="space-y-1">
              <button
                type="button"
                onClick={() => onToggle(m.id)}
                className={`w-full text-left p-3 rounded-lg border transition-colors ${
                  selected
                    ? 'border-hud-gold bg-hud-gold/10'
                    : 'border-hud-bg-elev bg-hud-bg-card/50 hover:border-hud-cream-mute'
                }`}
              >
                <div className="flex items-start gap-2">
                  <div
                    className={`w-4 h-4 rounded border flex-shrink-0 mt-0.5 flex items-center justify-center ${
                      selected ? 'bg-hud-gold border-hud-gold' : 'border-hud-cream-mute'
                    }`}
                  >
                    {selected && <CheckCircle className="w-3 h-3 text-white" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate">{m.meeting_title}</p>
                    <div className="flex items-center flex-wrap gap-3 text-xs text-hud-cream-dim mt-1">
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {formatDateShort(m.meeting_date)}
                      </span>
                      {m.duration_minutes ? (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {m.duration_minutes}m
                        </span>
                      ) : null}
                      {hasTranscript && (
                        <span className="flex items-center gap-1 text-hud-emerald/80">
                          <FileText className="w-3 h-3" />
                          Transcript
                        </span>
                      )}
                      {hasSummary && (
                        <span className="flex items-center gap-1 text-hud-gold-soft/80">
                          <StickyNote className="w-3 h-3" />
                          Notes
                        </span>
                      )}
                      {!hasTranscript && !hasSummary && (
                        <span className="text-hud-rust/80">No transcript yet</span>
                      )}
                    </div>
                    {view === 'all' && m.summary && (
                      <p className="text-xs text-hud-cream-mute mt-1 line-clamp-2">{m.summary}</p>
                    )}
                  </div>
                </div>
              </button>
              <div className="pl-6">
                <TranscribeRecordingButton
                  meeting={m}
                  onTranscribed={(id, transcript) => setMeetings((prev) => prev.map((x) => (x.id === id
                    ? { ...x, transcript_text: transcript, transcription_status: 'completed', transcript_source: 'stt' }
                    : x)))}
                />
              </div>
              </div>
            );
          })}
        </div>
      )}

      {showImport && (
        <ImportTranscriptModal onClose={() => setShowImport(false)} onImported={handleImported} />
      )}
    </div>
  );
}
