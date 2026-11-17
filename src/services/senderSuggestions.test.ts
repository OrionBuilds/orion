import { describe, expect, it } from 'vitest';
import { suggestionText } from './senderSuggestions';

const base = { contact_name: 'Casey Sample', display_name: 'casey n', email: 'caseysample@gmail.com', company: 'Initech Box', last_subject: 'circling back', message_count: 2 };

describe('suggestionText', () => {
  it('names the contact, the address, and what they wrote', () => {
    expect(suggestionText(base)).toEqual({ title: 'Casey Sample wrote from caseysample@gmail.com', detail: 'Initech Box · 2 emails · "circling back"' });
  });
  it('falls back to the sender name, shortens long subjects, and never shows an empty line', () => {
    expect(suggestionText({ ...base, contact_name: '', company: null, message_count: 1, last_subject: 'x'.repeat(80) }))
      .toEqual({ title: 'casey n wrote from caseysample@gmail.com', detail: `"${'x'.repeat(59)}…"` });
    expect(suggestionText({ ...base, contact_name: '', display_name: null, company: null, message_count: 1, last_subject: ' ' }))
      .toEqual({ title: 'Someone wrote from caseysample@gmail.com', detail: 'Not on their contact yet' });
  });
});
