import { supabase } from '../lib/supabase';

export interface ImportTranscriptInput {
  title: string;
  transcript: string;
  /** "Name <email>" or bare email, one per line — parsed by the caller into {name,email}. */
  attendees?: { name?: string; email?: string }[];
  meetingDate?: string;
  summary?: string;
  /** Required: how participants were told about the recording. */
  consentBasis: string;
  consentNote?: string;
}

export interface ImportTranscriptResult {
  success: boolean;
  meetingTranscriptionId: string | null;
  contactsLinked: number;
  tasksCreated: number;
  fridayHandoffs: number;
  followUpDrafts: number;
  /** Owner action items created as Motion tasks (0 when Motion isn't connected). */
  motionTasks?: number;
  items: number;
  summary?: string;
  error?: string;
}

/** Parse a textarea of attendee lines ("Jane Doe <jane@acme.com>" or "jane@acme.com"). */
export function parseAttendeeLines(text: string): { name?: string; email?: string }[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)\s*<([^>]+)>$/);
      if (m) return { name: m[1].trim() || undefined, email: m[2].trim() };
      if (line.includes('@')) return { email: line };
      return { name: line };
    });
}

export async function importMeetingTranscript(input: ImportTranscriptInput): Promise<ImportTranscriptResult> {
  const { data, error } = await supabase.functions.invoke('meeting-transcript-import', {
    body: {
      title: input.title,
      transcript: input.transcript,
      attendees: input.attendees ?? [],
      meeting_date: input.meetingDate,
      summary: input.summary,
      consent_basis: input.consentBasis,
      consent_note: input.consentNote,
    },
  });
  if (error) return { success: false, meetingTranscriptionId: null, contactsLinked: 0, tasksCreated: 0, fridayHandoffs: 0, followUpDrafts: 0, items: 0, error: error.message };
  return data as ImportTranscriptResult;
}
