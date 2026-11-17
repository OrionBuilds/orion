import { supabase } from '../lib/supabase';
import { processMeetingTranscript } from './assistantMeetings';
import type { MeetingTranscription } from '../types';
import type { AssistantMeetingSummary } from '../types/assistant';

/**
 * A5: thin hub over the meeting_transcriptions transcript surface -- full-text
 * search + the "send to memory" bridge into the existing
 * assistant-meeting-processor edge function. Everything else (listing, action
 * items, follow-ups, recordings) is served by the pre-existing
 * meetingTranscriptions.ts / assistantMeetings.ts services and the
 * components/meetings/* cards. Search powers the meeting picker in the proposal and contract builders.
 */

export type TranscriptSource = 'meeting';

export interface TranscriptSearchResult {
  id: string;
  source: TranscriptSource;
  title: string;
  /** ISO timestamp used for sorting; null falls to the bottom. */
  date: string | null;
  snippet: string;
  meeting?: MeetingTranscription;
}

function buildSnippet(text: string | null | undefined, max = 220): string {
  if (!text) return '';
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Full-text search over meeting_transcriptions' generated `search_vector`
 * tsvector column (A5 migration), newest first.
 */
export async function searchAllTranscripts(
  orgId: string,
  query: string,
  limit = 25
): Promise<TranscriptSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed || !orgId) return [];

  const { data, error } = await supabase
    .from('meeting_transcriptions')
    .select('*, contact:contacts(*)')
    .eq('org_id', orgId)
    .textSearch('search_vector', trimmed, { type: 'websearch', config: 'english' })
    .order('meeting_date', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return ((data || []) as MeetingTranscription[]).map((m) => ({
    id: m.id,
    source: 'meeting' as const,
    title: m.meeting_title,
    date: m.meeting_date,
    snippet: buildSnippet(m.summary || m.transcript_text),
    meeting: m,
  }));
}

/**
 * Send a meeting transcript to the org's assistant memory -- invokes the
 * EXISTING assistant-meeting-processor edge function (input contract verified
 * live: `{ transcription_id }`, Bearer-authed, org-scoped). Only meeting_transcriptions
 * rows are supported.
 */
export async function sendTranscriptToMemory(transcriptionId: string): Promise<AssistantMeetingSummary> {
  return processMeetingTranscript(transcriptionId);
}

/** Most recent assistant memory summary already generated for a meeting, if any. */
export async function getMemorySummaryForMeeting(
  transcriptionId: string
): Promise<AssistantMeetingSummary | null> {
  const { data, error } = await supabase
    .from('assistant_meeting_summaries')
    .select('*')
    .eq('meeting_transcription_id', transcriptionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as AssistantMeetingSummary | null;
}
