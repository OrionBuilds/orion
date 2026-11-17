/**
 * Pure helpers for a user's Google accounts (one `google_oauth_master` row each). The Google twin
 * of `microsoftAccounts.ts`: a user has 1..N accounts and exactly one primary; every existing
 * behaviour defaults to the primary, and the account pickers only appear once there are two or more.
 * The account-agnostic helpers (picker visibility, default From, display name) are shared with the
 * Microsoft side so both providers behave identically.
 */
import {
  accountDisplayName,
  defaultFromConnectionId,
  fromConnectionIdForSend,
  primaryAccount,
  showAccountPicker,
  type ThreadMailbox,
} from './microsoftAccounts';

export { accountDisplayName, defaultFromConnectionId, fromConnectionIdForSend, primaryAccount, showAccountPicker };
export type { ThreadMailbox };

export interface GoogleAccount {
  /** google_oauth_master.id (the connection_id sent to the edge functions). */
  id: string;
  email: string;
  label: string | null;
  isPrimary: boolean;
  /** 'active' | 'needs_reauth' | other values from google_oauth_master.connection_status. */
  status: string;
}

export interface GoogleAccountDetail extends GoogleAccount {
  /** Gmail sync state of this mailbox (null when it has none yet). */
  syncStatus: string | null;
  lastSyncAt: string | null;
  error: string | null;
  needsReauth: boolean;
  grantedScopes: string[];
}

/** One row of the `google_connection_status` view (or a mapped `google-accounts` list entry). */
export interface GoogleConnectionRow {
  connection_id?: string | null;
  email?: string | null;
  label?: string | null;
  is_primary?: boolean | null;
  connection_status?: string | null;
  last_refresh_error?: string | null;
  granted_scopes?: string[] | string | null;
  sync_status?: string | null;
  last_incremental_sync_at?: string | null;
  sync_error?: string | null;
}

function scopesOf(raw: GoogleConnectionRow['granted_scopes']): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  return [];
}

/**
 * Turns view rows into accounts: primary first, then by email. Tolerates a view without
 * connection_id / is_primary: the single row is then the primary and its email stands in as id.
 */
export function shapeGoogleAccounts(rows: GoogleConnectionRow[] | null | undefined): GoogleAccountDetail[] {
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
      lastSyncAt: r.last_incremental_sync_at ?? null,
      error: r.sync_error ?? r.last_refresh_error ?? null,
      needsReauth: status === 'needs_reauth',
      grantedScopes: scopesOf(r.granted_scopes),
    };
  });
  return shaped.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.email.localeCompare(b.email);
  });
}

/** The slim account list stored on the provider state (`accounts.google`). */
export function toGoogleAccounts(details: GoogleAccountDetail[]): GoogleAccount[] {
  return details.map(({ id, email, label, isPrimary, status }) => ({ id, email, label, isPrimary, status }));
}

/** An id equal to the email means the list came from a legacy status with no connection ids. */
export function isLegacyAccountId(a: Pick<GoogleAccount, 'id' | 'email'>): boolean {
  return a.id === a.email;
}

/** The `connection_id` to send for an account: undefined for a legacy (id-less) account. */
export function connectionIdParam(a: Pick<GoogleAccount, 'id' | 'email'>): string | undefined {
  return isLegacyAccountId(a) ? undefined : a.id;
}

const GMAIL_PREFIX = 'gmail:';

/** Sender select values: 'resend' | 'gmail' | 'gmail:<connection_id>' | 'outlook' | 'outlook:<connection_id>'. */
export function encodeGmailOption(connectionId: string): string {
  return `${GMAIL_PREFIX}${connectionId}`;
}

export function decodeGmailOption(value: string): string | null {
  return value.startsWith(GMAIL_PREFIX) ? value.slice(GMAIL_PREFIX.length) : null;
}

export interface ThreadMessageMailbox {
  external_id?: string | null;
  channel?: string | null;
  mailbox_google_connection_id?: string | null;
  mailbox_email?: string | null;
}

/**
 * The Gmail mailbox of the last Google message in a thread (the one a reply will be threaded on).
 * Outlook messages (external_id "ms:...") are skipped; a Google message with no mailbox stamp
 * (legacy) counts as no information, so the default falls back to the primary.
 */
export function threadGoogleMailboxFromMessages(messages: ThreadMessageMailbox[]): ThreadMailbox | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m.external_id === 'string' && m.external_id.startsWith('ms:')) continue;
    if (m.mailbox_google_connection_id || m.mailbox_email) {
      return { mailboxConnectionId: m.mailbox_google_connection_id ?? null, mailboxEmail: m.mailbox_email ?? null };
    }
  }
  return null;
}

/**
 * The `connection_id` to send with Drive/Calendar calls: only for users with 2+ Google accounts and
 * only when the saved choice is still one of them; otherwise undefined (the server uses the primary).
 */
export function resolveGoogleConnectionId(accounts: GoogleAccount[], preference: string | null | undefined): string | undefined {
  if (!showAccountPicker(accounts) || !preference) return undefined;
  return accounts.some((a) => a.id === preference) ? preference : undefined;
}

/** The Google account a new calendar event goes to unless the user picks another: the primary. */
export function defaultGoogleCalendarConnectionId(accounts: GoogleAccount[]): string | null {
  return primaryAccount(accounts)?.id ?? null;
}

/**
 * The `connection_id` to send when creating a Google calendar event: undefined for single-account
 * users (nothing changes for them) or when the selection is not one of the user's accounts.
 */
export function googleCalendarConnectionIdForCreate(accounts: GoogleAccount[], selectedId: string | null | undefined): string | undefined {
  return resolveGoogleConnectionId(accounts, selectedId);
}

/**
 * Picks the row of a per-connection table (e.g. drive_connections) for the chosen account: the
 * wanted connection, else the primary's, else a legacy row with no connection, else the first.
 */
export function pickByConnection<T extends { connection_id?: string | null }>(
  rows: T[] | null | undefined,
  wantedId?: string | null,
  primaryId?: string | null,
): T | null {
  const list = rows ?? [];
  if (list.length === 0) return null;
  return (
    (wantedId ? list.find((r) => r.connection_id === wantedId) : undefined)
    ?? (primaryId ? list.find((r) => r.connection_id === primaryId) : undefined)
    ?? list.find((r) => !r.connection_id)
    ?? list[0]
  );
}

export const GOOGLE_CONSENT_NOTE =
  'Each Google account you add is asked for Gmail, Calendar, Meet and Drive access. Accounts on another domain may need their Workspace admin to allow this app.';
