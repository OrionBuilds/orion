import { describe, expect, it } from 'vitest';
import {
  connectionIdParam,
  decodeGmailOption,
  defaultFromConnectionId,
  defaultGoogleCalendarConnectionId,
  encodeGmailOption,
  fromConnectionIdForSend,
  googleCalendarConnectionIdForCreate,
  isLegacyAccountId,
  pickByConnection,
  resolveGoogleConnectionId,
  shapeGoogleAccounts,
  showAccountPicker,
  threadGoogleMailboxFromMessages,
  toGoogleAccounts,
  type GoogleAccount,
} from './googleAccounts';

const acct = (id: string, email: string, isPrimary = false): GoogleAccount => ({ id, email, label: null, isPrimary, status: 'active' });
const two = [acct('g1', 'jordan@gmail.com', true), acct('g2', 'sales@corp.com')];

describe('shapeGoogleAccounts', () => {
  it('puts the primary first and maps status, sync, scopes and label', () => {
    const out = shapeGoogleAccounts([
      { connection_id: 'g2', email: 'z@corp.com', is_primary: false, label: ' Sales ', connection_status: 'needs_reauth', last_refresh_error: 'invalid_grant', granted_scopes: ['gmail', 'drive'] },
      { connection_id: 'g1', email: 'm@gmail.com', is_primary: true, connection_status: 'active', sync_status: 'idle', last_incremental_sync_at: '2026-11-05T10:00:00Z', sync_error: null, granted_scopes: 'a b' },
    ]);
    expect(out.map((a) => a.id)).toEqual(['g1', 'g2']);
    expect(out[0]).toMatchObject({ isPrimary: true, needsReauth: false, syncStatus: 'idle', lastSyncAt: '2026-11-05T10:00:00Z', grantedScopes: ['a', 'b'] });
    expect(out[1]).toMatchObject({ label: 'Sales', needsReauth: true, error: 'invalid_grant', isPrimary: false, grantedScopes: ['gmail', 'drive'] });
  });

  it('prefers the sync error over the refresh error', () => {
    const [a] = shapeGoogleAccounts([{ connection_id: 'g1', email: 'a@x.com', sync_error: 'quota', last_refresh_error: 'old' }]);
    expect(a.error).toBe('quota');
  });

  it('treats a lone row without connection_id / is_primary as the primary, with the email as id', () => {
    const out = shapeGoogleAccounts([{ email: 'only@x.com' }]);
    expect(out[0]).toMatchObject({ id: 'only@x.com', isPrimary: true, status: 'active', grantedScopes: [] });
    expect(isLegacyAccountId(out[0])).toBe(true);
    expect(connectionIdParam(out[0])).toBeUndefined();
  });

  it('is empty for no rows and drops rows without an email', () => {
    expect(shapeGoogleAccounts(null)).toEqual([]);
    expect(shapeGoogleAccounts([{ connection_id: 'x', email: null }])).toEqual([]);
  });

  it('sends the real connection id and slims accounts for the provider state', () => {
    const detail = shapeGoogleAccounts([{ connection_id: 'g1', email: 'a@x.com', is_primary: true }]);
    expect(connectionIdParam(detail[0])).toBe('g1');
    expect(toGoogleAccounts(detail)).toEqual([{ id: 'g1', email: 'a@x.com', label: null, isPrimary: true, status: 'active' }]);
  });
});

describe('pickers and From selection (same rules as Microsoft)', () => {
  it('only exist for 2+ accounts', () => {
    expect(showAccountPicker([])).toBe(false);
    expect(showAccountPicker([two[0]])).toBe(false);
    expect(showAccountPicker(two)).toBe(true);
  });

  it('never sends from_connection_id for a single-account user', () => {
    expect(fromConnectionIdForSend([two[0]], 'g1')).toBeUndefined();
    expect(fromConnectionIdForSend(two, 'g2')).toBe('g2');
    expect(fromConnectionIdForSend(two, 'someone-elses')).toBeUndefined();
  });

  it('a new message defaults to the primary, a reply to the mailbox it arrived on', () => {
    expect(defaultFromConnectionId(two)).toBe('g1');
    expect(defaultFromConnectionId(two, { mailboxConnectionId: 'g2' })).toBe('g2');
    expect(defaultFromConnectionId(two, { mailboxEmail: 'SALES@corp.com' })).toBe('g2');
    expect(defaultFromConnectionId(two, { mailboxConnectionId: 'gone', mailboxEmail: 'gone@x.com' })).toBe('g1');
  });
});

describe('sender option encoding', () => {
  it('round-trips gmail options and ignores other values', () => {
    expect(decodeGmailOption(encodeGmailOption('g2'))).toBe('g2');
    expect(decodeGmailOption('gmail')).toBeNull();
    expect(decodeGmailOption('outlook:c1')).toBeNull();
    expect(decodeGmailOption('resend')).toBeNull();
  });
});

describe('threadGoogleMailboxFromMessages', () => {
  it('takes the mailbox of the last Google message, skipping Outlook ones', () => {
    expect(threadGoogleMailboxFromMessages([
      { external_id: 'gm-1', mailbox_google_connection_id: 'g1', mailbox_email: 'jordan@gmail.com' },
      { external_id: 'gm-2', mailbox_google_connection_id: 'g2', mailbox_email: 'sales@corp.com' },
      { external_id: 'ms:3', mailbox_email: 'jordan@outlook.com' },
    ])).toEqual({ mailboxConnectionId: 'g2', mailboxEmail: 'sales@corp.com' });
  });

  it('is null for legacy (unstamped), Outlook-only or empty threads, so the default is the primary', () => {
    expect(threadGoogleMailboxFromMessages([{ external_id: 'gm-1' }])).toBeNull();
    expect(threadGoogleMailboxFromMessages([{ external_id: 'ms:1', mailbox_email: 'a@b.com' }])).toBeNull();
    expect(threadGoogleMailboxFromMessages([])).toBeNull();
  });

  it('falls back to the mailbox email when the connection is not stamped', () => {
    expect(threadGoogleMailboxFromMessages([{ external_id: 'gm-1', mailbox_email: 'a@b.com' }]))
      .toEqual({ mailboxConnectionId: null, mailboxEmail: 'a@b.com' });
  });
});

describe('calendar and files account choice', () => {
  it('resolves a saved choice only for 2+ accounts and only when still connected', () => {
    expect(resolveGoogleConnectionId([two[0]], 'g1')).toBeUndefined();
    expect(resolveGoogleConnectionId(two, 'zzz')).toBeUndefined();
    expect(resolveGoogleConnectionId(two, null)).toBeUndefined();
    expect(resolveGoogleConnectionId(two, 'g2')).toBe('g2');
  });

  it('a new event defaults to the primary and sends an id only with 2+ accounts', () => {
    expect(defaultGoogleCalendarConnectionId(two)).toBe('g1');
    expect(defaultGoogleCalendarConnectionId([])).toBeNull();
    expect(googleCalendarConnectionIdForCreate([two[0]], 'g1')).toBeUndefined();
    expect(googleCalendarConnectionIdForCreate(two, 'g1')).toBe('g1');
    expect(googleCalendarConnectionIdForCreate(two, 'g2')).toBe('g2');
    expect(googleCalendarConnectionIdForCreate(two, 'x')).toBeUndefined();
  });

  it('picks a per-connection row: wanted, then primary, then legacy, then first', () => {
    const rows = [{ connection_id: 'g2', n: 2 }, { connection_id: null, n: 0 }, { connection_id: 'g1', n: 1 }];
    expect(pickByConnection(rows, 'g2', 'g1')?.n).toBe(2);
    expect(pickByConnection(rows, 'gone', 'g1')?.n).toBe(1);
    expect(pickByConnection(rows, undefined, undefined)?.n).toBe(0);
    expect(pickByConnection([{ connection_id: 'g9', n: 9 }], 'x', 'y')?.n).toBe(9);
    expect(pickByConnection([], 'g1', 'g1')).toBeNull();
    expect(pickByConnection(null)).toBeNull();
  });
});
