import { describe, expect, it } from 'vitest';
import { canTranscribe, describeDocumentText, selectionToPayload } from './proposalSources';

describe('selectionToPayload', () => {
  it('sends nothing until the picker has loaded, so server defaults apply', () => {
    expect(selectionToPayload({ loaded: false, fileIds: ['a'], projectIds: ['p'] })).toEqual({});
  });

  it('sends the exact ticked documents and projects once loaded', () => {
    expect(selectionToPayload({ loaded: true, fileIds: ['a', 'b'], projectIds: [] })).toEqual({
      include_attached_documents: false,
      file_ids: ['a', 'b'],
      include_project: false,
      project_ids: [],
    });
  });
});

describe('describeDocumentText', () => {
  it('labels each extraction state', () => {
    expect(describeDocumentText(null)).toEqual({ label: 'Read at generation', tone: 'muted' });
    expect(describeDocumentText({ status: 'extracted', char_count: 12000, page_count: 4, error: null }))
      .toEqual({ label: '12,000 chars · 4 pp', tone: 'ok' });
    expect(describeDocumentText({ status: 'no_text', char_count: 0, page_count: 3, error: 'scanned' }).label)
      .toBe('Scanned — no text layer');
    expect(describeDocumentText({ status: 'failed', char_count: 0, page_count: null, error: 'x' }).tone).toBe('warn');
  });
});

describe('canTranscribe', () => {
  it('only offers transcription for a recording without a transcript', () => {
    expect(canTranscribe({ recording_url: 'https://drive.google.com/file/d/abc/view', recording_file_id: null, transcript_text: '' })).toBe(true);
    expect(canTranscribe({ recording_url: null, recording_file_id: 'item', transcript_text: '   ' })).toBe(true);
    expect(canTranscribe({ recording_url: 'x', recording_file_id: 'item', transcript_text: 'Speaker 1: hi' })).toBe(false);
    expect(canTranscribe({ recording_url: null, recording_file_id: null, transcript_text: '' })).toBe(false);
  });
});
