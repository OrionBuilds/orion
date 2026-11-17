/** What an agent wants to send, in a few lines, so a phone can approve without opening Details. */
export interface DraftPreview {
  to: string;
  subject: string;
  snippet: string;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** draft_content is {risk, draft:{to, subject, body, kind}, facts} for Harvey/Clara drafts, or a bare string/object for others. */
export function draftPreview(content: unknown, maxChars = 240): DraftPreview | null {
  if (!content) return null;
  if (typeof content === 'string') {
    const snippet = clean(content).slice(0, maxChars);
    return snippet ? { to: '', subject: '', snippet } : null;
  }
  if (typeof content !== 'object') return null;
  const root = content as Record<string, unknown>;
  const d = (typeof root.draft === 'object' && root.draft ? root.draft : root) as Record<string, unknown>;
  const toRaw = d.to ?? d.recipient ?? d.to_email;
  const to = Array.isArray(toRaw) ? toRaw.filter((x) => typeof x === 'string').join(', ') : typeof toRaw === 'string' ? toRaw : '';
  const subject = typeof d.subject === 'string' ? clean(d.subject) : '';
  const bodyRaw = d.body ?? d.text ?? d.message ?? d.content;
  const snippet = typeof bodyRaw === 'string' ? clean(bodyRaw).slice(0, maxChars) : '';
  return to || subject || snippet ? { to, subject, snippet } : null;
}
