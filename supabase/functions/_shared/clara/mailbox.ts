/**
 * "How many emails are in my inbox / what's unread?" — a live, read-only look at a connected
 * mailbox, provider-aware (Microsoft 365 via Graph, Google via the Gmail API).
 *
 * The OS mirror can't answer this (it keeps only mail from known contacts), so this asks the
 * provider directly with the user's own token. Only metadata and a short preview come back:
 * mail content is third-party data, and the caller treats it as such.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { resolveMsConnection } from "../ms-graph.ts";
import { resolveGoogleConnection } from "../google-connections.ts";
import { getProviderAccountEmail, resolveUserProvider, type WorkspaceProvider } from "../provider.ts";

export interface MailItem { from: string | null; subject: string | null; received: string | null; preview: string | null; unread: boolean; link: string | null }
export interface MailboxSnapshot {
  provider: WorkspaceProvider;
  address: string | null;
  total: number | null;
  unread: number | null;
  messages: MailItem[];
  /** What `messages` holds: unread inbox mail, or the results of a search. */
  listing: "unread" | "search";
}

export interface MailboxDeps {
  fetch: typeof fetch;
  /** A valid Graph access token for the user (refreshing as needed); `connectionId` picks one of the user's several accounts (default: the primary). */
  msToken: (userId: string, connectionId?: string) => Promise<string>;
  /** A valid Gmail access token for the user (refreshing as needed); `connectionId` picks one of the user's several Google accounts (default: the primary). */
  googleToken: (userId: string, connectionId?: string) => Promise<string>;
}

export class MailboxError extends Error {}

/**
 * Clara may send through a Microsoft connection only when it belongs to the owner or to Clara herself: never
 * another user's mailbox. Returns the connection's owner (the user whose mailbox sends) and its address; throws
 * a MailboxError (message safe to show) for an unknown connection or anyone else's.
 */
export async function resolveClaraConnection(
  db: SupabaseClient, allowedUserIds: Array<string | null | undefined>, connectionId: string,
): Promise<{ userId: string; connectionId: string; email: string }> {
  const { data } = await db.from("microsoft_oauth_master").select("id, user_id, email").eq("id", connectionId).limit(1).maybeSingle();
  const c = data as { id: string; user_id: string; email: string } | null;
  if (!c) throw new MailboxError("That mailbox isn't connected.");
  if (!allowedUserIds.filter(Boolean).includes(c.user_id)) {
    throw new MailboxError("Clara can only send from the owner's mailboxes or her own, not that one.");
  }
  return { userId: c.user_id, connectionId: c.id, email: c.email };
}

const PREVIEW = 140;
const prev = (s: string | null | undefined) => (s ? s.replace(/\s+/g, " ").trim().slice(0, PREVIEW) : null);
const clampTop = (n: number) => Math.min(10, Math.max(1, Math.floor(n) || 5));

// ── Microsoft 365 ──────────────────────────────────────────────────────────────────────────

const GRAPH = "https://graph.microsoft.com/v1.0";
const MS_SELECT = "subject,from,receivedDateTime,bodyPreview,isRead,webLink";

interface GraphMsg { subject?: string; from?: { emailAddress?: { name?: string; address?: string } }; receivedDateTime?: string; bodyPreview?: string; isRead?: boolean; webLink?: string }

const fromGraph = (m: GraphMsg): MailItem => ({
  from: m.from?.emailAddress ? [m.from.emailAddress.name, m.from.emailAddress.address && `<${m.from.emailAddress.address}>`].filter(Boolean).join(" ") : null,
  subject: m.subject?.slice(0, 160) ?? null, received: m.receivedDateTime ?? null, preview: prev(m.bodyPreview), unread: m.isRead === false, link: m.webLink ?? null,
});

export function graphMailUrls(top: number, query?: string): { folder: string; list: string } {
  const folder = `${GRAPH}/me/mailFolders/inbox?$select=totalItemCount,unreadItemCount`;
  const q = query?.trim().replace(/"/g, "");
  const list = q
    // $search can't be combined with $orderby; results come back by relevance/date.
    ? `${GRAPH}/me/messages?$search=${encodeURIComponent(`"${q}"`)}&$top=${top}&$select=${MS_SELECT}`
    : `${GRAPH}/me/mailFolders/inbox/messages?$filter=${encodeURIComponent("isRead eq false")}&$orderby=${encodeURIComponent("receivedDateTime desc")}&$top=${top}&$select=${MS_SELECT}`;
  return { folder, list };
}

async function microsoft(token: string, top: number, query: string | undefined, f: typeof fetch): Promise<Omit<MailboxSnapshot, "provider" | "address">> {
  const { folder, list } = graphMailUrls(top, query);
  const h = { Authorization: `Bearer ${token}` };
  const [fr, lr] = await Promise.all([f(folder, { headers: h }), f(list, { headers: h })]);
  if (!fr.ok) throw new MailboxError(`Outlook inbox read failed (${fr.status})`);
  if (!lr.ok) throw new MailboxError(`Outlook message list failed (${lr.status})`);
  const fj = await fr.json() as { totalItemCount?: number; unreadItemCount?: number };
  const lj = await lr.json() as { value?: GraphMsg[] };
  return { total: fj.totalItemCount ?? null, unread: fj.unreadItemCount ?? null, messages: (lj.value ?? []).slice(0, top).map(fromGraph), listing: query?.trim() ? "search" : "unread" };
}

// ── Gmail ──────────────────────────────────────────────────────────────────────────────────

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export function gmailListUrl(top: number, query?: string): string {
  const q = query?.trim() ? query.trim() : "in:inbox is:unread";
  return `${GMAIL}/messages?maxResults=${top}&q=${encodeURIComponent(q)}`;
}

interface GmailMeta { id: string; snippet?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }

const fromGmail = (m: GmailMeta): MailItem => {
  const hdr = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? null;
  return {
    from: hdr("from"), subject: hdr("subject")?.slice(0, 160) ?? null,
    received: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : hdr("date"),
    preview: prev(m.snippet), unread: (m.labelIds ?? []).includes("UNREAD"), link: `https://mail.google.com/mail/#all/${m.id}`,
  };
};

async function google(token: string, top: number, query: string | undefined, f: typeof fetch): Promise<Omit<MailboxSnapshot, "provider" | "address">> {
  const h = { Authorization: `Bearer ${token}` };
  const [lab, list] = await Promise.all([f(`${GMAIL}/labels/INBOX`, { headers: h }), f(gmailListUrl(top, query), { headers: h })]);
  if (!lab.ok) throw new MailboxError(`Gmail inbox read failed (${lab.status})`);
  if (!list.ok) throw new MailboxError(`Gmail message list failed (${list.status})`);
  const lj = await lab.json() as { messagesTotal?: number; messagesUnread?: number };
  const ids = ((await list.json() as { messages?: { id: string }[] }).messages ?? []).slice(0, top);
  const metas = await Promise.all(ids.map(async ({ id }) => {
    const r = await f(`${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: h });
    return r.ok ? await r.json() as GmailMeta : null;
  }));
  return { total: lj.messagesTotal ?? null, unread: lj.messagesUnread ?? null, messages: metas.filter((m): m is GmailMeta => !!m).map(fromGmail), listing: query?.trim() ? "search" : "unread" };
}

// ── entry point ────────────────────────────────────────────────────────────────────────────

/**
 * Read the user's connected mailbox. Null when the user has no mailbox connected; throws a
 * MailboxError (message safe to show) when the provider call fails.
 */
export async function readMailbox(
  db: SupabaseClient, d: MailboxDeps, userId: string, o: { orgId: string; top?: number; query?: string; prefer?: WorkspaceProvider | null; connectionId?: string | null },
): Promise<MailboxSnapshot | null> {
  const provider = await resolveUserProvider(db, userId, { orgId: o.orgId, prefer: o.prefer ?? null });
  if (!provider) return null;
  let address = await getProviderAccountEmail(db, userId, provider);
  // One of several Microsoft accounts: it must be the user's own (never another user's connection).
  let connectionId: string | undefined;
  if (provider === "microsoft" && o.connectionId) {
    const c = await resolveMsConnection(db, userId, { connectionId: o.connectionId });
    if (!c) throw new MailboxError("That Microsoft account isn't connected for this user.");
    connectionId = c.id;
    address = c.email;
  }
  // One of several Google accounts: it must be the user's own. Reading only; Clara never sends through Google.
  let googleConnectionId: string | undefined;
  if (provider === "google" && o.connectionId) {
    const c = await resolveGoogleConnection(db, userId, { connectionId: o.connectionId });
    if (!c) throw new MailboxError("That Google account isn't connected for this user.");
    googleConnectionId = c.id;
    address = c.email;
  }
  const top = clampTop(o.top ?? 5);
  let token: string;
  try {
    token = provider === "microsoft" ? (connectionId ? await d.msToken(userId, connectionId) : await d.msToken(userId)) : (googleConnectionId ? await d.googleToken(userId, googleConnectionId) : await d.googleToken(userId));
  } catch (e) {
    throw new MailboxError(`the ${provider === "microsoft" ? "Microsoft 365" : "Google"} connection for ${address ?? "that mailbox"} isn't usable (${String((e as Error).message).slice(0, 100)})`);
  }
  const body = provider === "microsoft" ? await microsoft(token, top, o.query, d.fetch) : await google(token, top, o.query, d.fetch);
  return { provider, address, ...body };
}
