import { describe, it, expect } from 'vitest';
import { draftPreview } from './approvalPreview';

describe('draftPreview', () => {
  it('reads a Harvey email draft: recipients, subject and a one-line body', () => {
    const p = draftPreview({ risk: 'low', draft: { kind: 'email', to: ['a@x.com', 'b@y.com'], subject: ' closing  the loop ', body: 'Hey Warren,\n\nTiming isn\'t right.\n\nHarvey' } });
    expect(p).toEqual({ to: 'a@x.com, b@y.com', subject: 'closing the loop', snippet: "Hey Warren, Timing isn't right. Harvey" });
  });

  it('caps the snippet and accepts a bare draft, a string, or nothing', () => {
    expect(draftPreview({ to: 'a@x.com', body: 'x'.repeat(500) })!.snippet).toHaveLength(240);
    expect(draftPreview('Please confirm the booking')).toEqual({ to: '', subject: '', snippet: 'Please confirm the booking' });
    expect(draftPreview(null)).toBeNull();
    expect(draftPreview({ risk: 'low' })).toBeNull();
    expect(draftPreview(42)).toBeNull();
  });
});
