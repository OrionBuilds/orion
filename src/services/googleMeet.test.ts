import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));
const { recordingSource } = await import('./googleMeet');

describe('recordingSource', () => {
  it('classifies Drive, SharePoint/OneDrive and other hosts', () => {
    expect(recordingSource('https://drive.google.com/file/d/abc/view')).toBe('google_drive');
    expect(recordingSource('https://contoso-my.sharepoint.com/personal/x/_layouts/stream.aspx')).toBe('microsoft');
    expect(recordingSource('https://onedrive.live.com/?id=1')).toBe('microsoft');
    expect(recordingSource('https://zoom.us/rec/1')).toBe('other');
    expect(recordingSource('not a url')).toBe('other');
    expect(recordingSource(null)).toBe('other');
  });
});
