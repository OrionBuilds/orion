import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_TYPE_BADGE,
  LIMITED_ACCOUNT_NOTE,
  accountNote,
  addAccountOptions,
  adminConsentUrl,
  parseCapabilities,
  decodeOutlookOption,
  defaultFromConnectionId,
  encodeOutlookOption,
  fromConnectionIdForSend,
  primaryAccount,
  shapeAccounts,
  showAccountPicker,
  threadMailboxFromMessages,
  type MsAccount,
} from './microsoftAccounts';

const acct = (id: string, email: string, isPrimary = false): MsAccount => ({ id, email, label: null, isPrimary, status: 'active' });
const two = [acct('c1', 'jordan@a.com', true), acct('c2', 'sales@a.com')];

describe('shapeAccounts', () => {
  it('puts the primary first and maps status, sync and label fields', () => {
    const out = shapeAccounts([
      { connection_id: 'c2', email: 'z@a.com', is_primary: false, label: ' Sales ', connection_status: 'needs_reauth', last_refresh_error: 'expired' },
      { connection_id: 'c1', email: 'm@a.com', is_primary: true, connection_status: 'active', sync_status: 'idle', last_sync_at: '2026-11-05T10:00:00Z', sync_error: null },
    ]);
    expect(out.map((a) => a.id)).toEqual(['c1', 'c2']);
    expect(out[0]).toMatchObject({ isPrimary: true, needsReauth: false, lastSyncAt: '2026-11-05T10:00:00Z' });
    expect(out[1]).toMatchObject({ label: 'Sales', needsReauth: true, error: 'expired', isPrimary: false });
  });

  it('treats a lone pre-migration row (no connection_id / is_primary) as the primary', () => {
    const out = shapeAccounts([{ email: 'only@a.com', connection_status: 'active' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'only@a.com', isPrimary: true });
  });

  it('is empty for no rows and drops rows without an email', () => {
    expect(shapeAccounts(null)).toEqual([]);
    expect(shapeAccounts([{ connection_id: 'x', email: null }])).toEqual([]);
  });
});

describe('pickers only exist for 2+ accounts', () => {
  it('hides for none and one account', () => {
    expect(showAccountPicker([])).toBe(false);
    expect(showAccountPicker([acct('c1', 'a@a.com', true)])).toBe(false);
    expect(showAccountPicker(two)).toBe(true);
  });

  it('never sends from_connection_id for a single-account user, even with a selection', () => {
    expect(fromConnectionIdForSend([acct('c1', 'a@a.com', true)], 'c1')).toBeUndefined();
  });

  it('sends the selection for 2+ accounts, and drops one that is not the user\'s', () => {
    expect(fromConnectionIdForSend(two, 'c2')).toBe('c2');
    expect(fromConnectionIdForSend(two, 'someone-elses')).toBeUndefined();
    expect(fromConnectionIdForSend(two, null)).toBeUndefined();
  });
});

describe('defaultFromConnectionId', () => {
  it('a new message defaults to the primary', () => {
    expect(defaultFromConnectionId(two)).toBe('c1');
    expect(defaultFromConnectionId([acct('c2', 'x@a.com'), acct('c1', 'y@a.com', true)])).toBe('c1');
  });

  it('a reply defaults to the mailbox the thread arrived on (by id)', () => {
    expect(defaultFromConnectionId(two, { mailboxConnectionId: 'c2' })).toBe('c2');
  });

  it('falls back to the mailbox email, case-insensitively', () => {
    expect(defaultFromConnectionId(two, { mailboxConnectionId: null, mailboxEmail: 'SALES@a.com' })).toBe('c2');
  });

  it('uses the primary when the thread mailbox is unknown, legacy or no longer connected', () => {
    expect(defaultFromConnectionId(two, { mailboxConnectionId: null, mailboxEmail: null })).toBe('c1');
    expect(defaultFromConnectionId(two, { mailboxConnectionId: 'gone', mailboxEmail: 'gone@a.com' })).toBe('c1');
  });

  it('is null with no accounts', () => {
    expect(defaultFromConnectionId([], { mailboxConnectionId: 'c1' })).toBeNull();
  });

  it('primaryAccount falls back to the first when none is flagged', () => {
    expect(primaryAccount([acct('c2', 'x@a.com')])?.id).toBe('c2');
    expect(primaryAccount([])).toBeNull();
  });
});

describe('sender option encoding and thread mailbox', () => {
  it('round-trips outlook options and ignores other values', () => {
    expect(decodeOutlookOption(encodeOutlookOption('c2'))).toBe('c2');
    expect(decodeOutlookOption('gmail')).toBeNull();
    expect(decodeOutlookOption('outlook')).toBeNull();
  });

  it('takes the mailbox from the last Outlook message, ignoring other channels\' ids', () => {
    expect(threadMailboxFromMessages([
      { external_id: 'ms:1', mailbox_connection_id: 'c1', mailbox_email: 'jordan@a.com' },
      { external_id: 'gmail-9' },
      { external_id: 'ms:2', mailbox_connection_id: 'c2', mailbox_email: 'sales@a.com' },
    ])).toEqual({ mailboxConnectionId: 'c2', mailboxEmail: 'sales@a.com' });
    expect(threadMailboxFromMessages([{ external_id: 'gmail-9' }])).toBeNull();
  });
});

describe('account types', () => {
  it('shapes account_type and tenant_id, defaulting to work', () => {
    const out = shapeAccounts([
      { connection_id: 'a', email: 'a@x.com', is_primary: true },
      { connection_id: 'b', email: 'b@y.com', account_type: 'external', tenant_id: 't-1' },
      { connection_id: 'c', email: 'c@live.com', account_type: 'personal' },
      { connection_id: 'd', email: 'd@z.com', account_type: 'bogus' },
    ]);
    const by = Object.fromEntries(out.map((x) => [x.id, x]));
    expect(by.a).toMatchObject({ accountType: 'work', tenantId: null });
    expect(by.b).toMatchObject({ accountType: 'external', tenantId: 't-1' });
    expect(by.c.accountType).toBe('personal');
    expect(by.d.accountType).toBe('work');
  });

  it('menu options follow capabilities', () => {
    expect(addAccountOptions(null).map((o) => o.type)).toEqual(['work']);
    expect(addAccountOptions({ external: true, personal: false }).map((o) => o.type)).toEqual(['work', 'external']);
    expect(addAccountOptions({ external: true, personal: true }).map((o) => o.type)).toEqual(['work', 'external', 'personal']);
    expect(addAccountOptions({ external: false, personal: true }).map((o) => o.type)).toEqual(['work', 'personal']);
  });

  it('parses capabilities strictly', () => {
    expect(parseCapabilities({ capabilities: { external: true, personal: 'yes' } })).toEqual({ external: true, personal: false });
    expect(parseCapabilities(null)).toEqual({ external: false, personal: false });
    expect(parseCapabilities({})).toEqual({ external: false, personal: false });
  });

  it('notes and badges by type', () => {
    expect(accountNote('work')).toBeNull();
    expect(accountNote(undefined)).toBeNull();
    expect(accountNote('external')).toBe(LIMITED_ACCOUNT_NOTE);
    expect(accountNote('personal')).toBe(LIMITED_ACCOUNT_NOTE);
    expect(ACCOUNT_TYPE_BADGE).toEqual({ work: 'Home organization', external: 'Other organization', personal: 'Personal' });
  });

  it('builds the admin consent URL only for a typed tenant and a known client id', () => {
    expect(adminConsentUrl('contoso.com', 'cid')).toBe('https://login.microsoftonline.com/contoso.com/adminconsent?client_id=cid');
    expect(adminConsentUrl('0f0f0f0f-1111-2222-3333-444444444444', 'cid')).toContain('/0f0f0f0f-1111-2222-3333-444444444444/');
    expect(adminConsentUrl('', 'cid')).toBeNull();
    expect(adminConsentUrl('contoso.com', null)).toBeNull();
    expect(adminConsentUrl('bad/../path', 'cid')).toBeNull();
  });
});
