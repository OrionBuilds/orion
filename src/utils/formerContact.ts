import type { FormerContact } from '../types';

/** Pure: how to show a record whose contact was deleted ("Acme Co (unlinked)"); null when none. */
export function formerContactLabel(fc: FormerContact | null | undefined): string | null {
  if (!fc) return null;
  const name = `${fc.first_name || ''} ${fc.last_name || ''}`.trim();
  const who = fc.company || name || fc.email;
  return who ? `${who} (unlinked)` : null;
}
