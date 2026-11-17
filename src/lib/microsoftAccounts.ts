/**
 * Pure helpers for a user's Microsoft 365 accounts (one `microsoft_oauth_master` row each).
 * A user has 1..N accounts and exactly one primary; every existing behaviour defaults to the
 * primary, and the account pickers only appear once there are two or more.
 */

export interface MsAccount {
  /** microsoft_oauth_master.id (the connection_id sent to the edge functions). */
  id: string;
  email: string;
  label: string | null;
  isPrimary: boolean;
  /** 'active' | 'needs_reauth' | other values from microsoft_oauth_master.connection_status. */
  status: string;
  /** 'work' = home organization (the default for every older row). */
  accountType?: MsAccountType;
  tenantId?: string | null;
}

export type MsAccountType = 'work' | 'external' | 'personal';

export interface MsCapabilities {
  external: boolean;
  personal: boolean;
}

export const NO_MS_CAPABILITIES: MsCapabilities = { external: false, personal: false };

export interface MsAccountDetail extends MsAccount {
  syncStatus: string | null;
  lastSyncAt: string | null;
  error: string | null;
  needsReauth: boolean;
  accountType: MsAccountType;
  tenantId: string | null;
}

/** One row of the `microsoft_connection_status` view. */
export interface MsConnectionRow {
  email?: string | null;
  connection_status?: string | null;
  last_refresh_error?: string | null;
  sync_status?: string | null;
  last_sync_at?: string | null;
  sync_error?: string | null;
  connection_id?: string | null;
  is_primary?: boolean | null;
  label?: string | null;
  account_type?: string | null;
  tenant_id?: string | null;
}

export function normalizeAccountType(v: unknown): MsAccountType {
  return v === 'external' || v === 'personal' ? v : 'work';
}

/** Reads the `capabilities` of a microsoft-accounts list response; anything unexpected means disabled. */
export function parseCapabilities(raw: unknown): MsCapabilities {
  const c = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).capabilities : null) as Record<string, unknown> | null;
  return { external: c?.external === true, personal: c?.personal === true };
}

export const ACCOUNT_TYPE_BADGE: Record<MsAccountType, string> = {
  work: 'Home organization',
  external: 'Other organization',
  personal: 'Personal',
};

export const LIMITED_ACCOUNT_NOTE = 'Teams transcripts and SharePoint sites are not available for this account.';
export const OTHER_ACCOUNTS_DISABLED_NOTE = 'Other organizations and personal accounts are not enabled yet';
export const EXTERNAL_ADMIN_NOTE =
  "Your organization's admin may need to approve this app. If you administer that tenant, use the admin approval link.";

/** The inline note for an account row: only non-home accounts have one. */
export function accountNote(type: MsAccountType | undefined): string | null {
  return type && type !== 'work' ? LIMITED_ACCOUNT_NOTE : null;
}

export interface AddAccountOption {
  type: MsAccountType;
  label: string;
}

/** The "Add account" menu: the home option always; the other two only when the server enables them. */
export function addAccountOptions(caps: MsCapabilities | null | undefined): AddAccountOption[] {
  const out: AddAccountOption[] = [{ type: 'work', label: 'Another account in my organization' }];
  if (caps?.external) out.push({ type: 'external', label: 'Work or school account from another organization' });
  if (caps?.personal) out.push({ type: 'personal', label: 'Personal Microsoft account (outlook.com, hotmail, live)' });
  return out;
}

const TENANT_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/i;

/**
 * The tenant admin-approval URL, only for a typed tenant domain or GUID and a known client id
 * (never guessed); null otherwise.
 */
export function adminConsentUrl(tenant: string | null | undefined, clientId: string | null | undefined): string | null {
  const t = (tenant ?? '').trim();
  const c = (clientId ?? '').trim();
  if (!t || !c || !TENANT_RE.test(t)) return null;
  return `https://login.microsoftonline.com/${encodeURIComponent(t)}/adminconsent?client_id=${encodeURIComponent(c)}`;
}

/**
 * Turns view rows into accounts: primary first, then by email. Tolerates the pre-migration view
 * (no connection_id / is_primary): the single row is then the primary and its email stands in as id.
 */
export function shapeAccounts(rows: MsConnectionRow[] | null | undefined): MsAccountDetail[] {
  const list = (rows ?? []).filter((r) => !!r && !!r.email);
  const anyPrimary = list.some((r) => r.is_primary === true);
  const shaped = list.map((r, i) => {
    const status = r.connection_status ?? 'active';
    return {
      id: r.connection_id ?? String(r.email),
      email: String(r.email),
      label: r.label?.trim() ? r.label.trim() : null,
      isPrimary: r.is_primary === true || (!anyPrimary && i === 0),
      status,
      syncStatus: r.sync_status ?? null,
      lastSyncAt: r.last_sync_at ?? null,
      error: r.sync_error ?? r.last_refresh_error ?? null,
      needsReauth: status === 'needs_reauth',
      accountType: normalizeAccountType(r.account_type),
      tenantId: r.tenant_id ?? null,
    };
  });
  return shaped.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.email.localeCompare(b.email);
  });
}

export function primaryAccount<T extends MsAccount>(accounts: T[]): T | null {
  return accounts.find((a) => a.isPrimary) ?? accounts[0] ?? null;
}

/** Pickers (From, calendar, files) only exist for users with two or more accounts. */
export function showAccountPicker(accounts: MsAccount[] | null | undefined): boolean {
  return (accounts?.length ?? 0) >= 2;
}

/** "Label (email)" or just the email. */
export function accountDisplayName(a: Pick<MsAccount, 'email' | 'label'>): string {
  return a.label ? `${a.label} (${a.email})` : a.email;
}

export interface ThreadMailbox {
  mailboxConnectionId?: string | null;
  mailboxEmail?: string | null;
}

/**
 * The account a message should go out from by default. A reply uses the mailbox the thread arrived
 * on (connection id first, then email); a new message, or a mailbox that is no longer connected,
 * uses the primary. Null when the user has no accounts.
 */
export function defaultFromConnectionId(accounts: MsAccount[], thread?: ThreadMailbox | null): string | null {
  if (accounts.length === 0) return null;
  if (thread?.mailboxConnectionId) {
    const byId = accounts.find((a) => a.id === thread.mailboxConnectionId);
    if (byId) return byId.id;
  }
  if (thread?.mailboxEmail) {
    const want = thread.mailboxEmail.trim().toLowerCase();
    const byEmail = accounts.find((a) => a.email.toLowerCase() === want);
    if (byEmail) return byEmail.id;
  }
  return primaryAccount(accounts)?.id ?? null;
}

/**
 * The `from_connection_id` to send: undefined for single-account users (the server defaults, and
 * nothing changes for them) or when the selection is not one of the user's accounts.
 */
export function fromConnectionIdForSend(accounts: MsAccount[], selectedId: string | null | undefined): string | undefined {
  if (!showAccountPicker(accounts) || !selectedId) return undefined;
  return accounts.some((a) => a.id === selectedId) ? selectedId : undefined;
}

const OUTLOOK_PREFIX = 'outlook:';

/** Sender select values: 'resend' | 'gmail' | 'outlook' | 'outlook:<connection_id>'. */
export function encodeOutlookOption(connectionId: string): string {
  return `${OUTLOOK_PREFIX}${connectionId}`;
}

export function decodeOutlookOption(value: string): string | null {
  return value.startsWith(OUTLOOK_PREFIX) ? value.slice(OUTLOOK_PREFIX.length) : null;
}

/** The mailbox of the last Outlook message in a thread (the one a reply will be threaded on). */
export function threadMailboxFromMessages(
  messages: { external_id?: string | null; mailbox_connection_id?: string | null; mailbox_email?: string | null }[],
): ThreadMailbox | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m.external_id === 'string' && m.external_id.startsWith('ms:')) {
      return { mailboxConnectionId: m.mailbox_connection_id ?? null, mailboxEmail: m.mailbox_email ?? null };
    }
  }
  return null;
}
