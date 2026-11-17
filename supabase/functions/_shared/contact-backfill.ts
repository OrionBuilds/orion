/**
 * History backfill for ONE contact's email (Gmail and Microsoft), queued by the contacts trigger
 * (migration 20261031300000) when a contact is added, gets an email address or is reactivated.
 *
 * The runners stay thin: everything here takes its I/O as callbacks so it can be tested without a
 * database or network. Storing a message is still done by processGmailMessage / processGraphMessage,
 * so "only conversations with contacts in the OS" and de-duplication keep a single source of truth.
 *
 * Both backfills are resumable and budgeted: the cron call (pg_net) is cut off after 60 s and the
 * platform stops the run with it, so each run stops at its budget (default 40 s), reports where it
 * got to and the next tick carries on from the saved position.
 */

export const BACKFILL_BUDGET_MS = 40_000;
export const BACKFILL_WINDOW_DAYS = 365;

const EMAIL_RE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;

/** True for an address worth searching a mailbox for (blank/garbage/over-long ones are ignored). */
export function isBackfillableEmail(email: string | null | undefined): email is string {
  const e = (email ?? "").trim();
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}

export const normalizeBackfillEmail = (email: string) => email.trim().toLowerCase();

/** Gmail search for everything to or from one address inside the backfill window. */
export function gmailContactQuery(email: string, now = Date.now()): string {
  const after = Math.floor((now - BACKFILL_WINDOW_DAYS * 86_400_000) / 1000);
  const e = normalizeBackfillEmail(email);
  return `after:${after} (from:${e} OR to:${e})`;
}

export interface BackfillStats {
  stage: string;
  pages: number;
  listed: number;
  fetched: number;
  stored: number;
  skipped: number;
  errors: number;
  httpFail: Record<string, number>;
  lastError: string;
  startedAt: string;
}

export const newStats = (): BackfillStats => ({
  stage: "start", pages: 0, listed: 0, fetched: 0, stored: 0, skipped: 0, errors: 0, httpFail: {}, lastError: "",
  startedAt: new Date().toISOString(),
});

export interface BackfillResult {
  complete: boolean;
  /** Gmail page token, or the Graph nextLink, to resume from. */
  pageToken?: string;
  /** Graph only: the folder being walked. */
  folder?: string;
  stats: BackfillStats;
}

// ---------------------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------------------

export interface GmailBackfillDeps {
  gmailApiUrl: string;
  accessToken: string;
  email: string;
  startToken?: string;
  budgetMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Which of these Gmail message ids are already stored (one batched lookup per page). */
  storedIds: (ids: string[]) => Promise<Set<string>>;
  /** Fetches nothing itself: stores one full Gmail message via processGmailMessage; true = stored. */
  processMessage: (msg: Record<string, unknown>) => Promise<boolean>;
  /** Called with the position after each batch so a run that dies silently still shows progress. */
  onProgress?: (state: { pageToken?: string; stats: BackfillStats }) => Promise<void>;
}

export async function runGmailContactBackfill(d: GmailBackfillDeps): Promise<BackfillResult> {
  const now = d.now ?? Date.now;
  const f = d.fetchImpl ?? fetch;
  const deadline = now() + (d.budgetMs ?? BACKFILL_BUDGET_MS);
  const stats = newStats();
  const query = gmailContactQuery(d.email, now());
  const auth = { Authorization: `Bearer ${d.accessToken}` };
  let next: string | undefined = d.startToken;
  const progress = async (pageToken?: string) => {
    try { await d.onProgress?.({ pageToken, stats }); } catch { /* diagnostics only */ }
  };

  do {
    const thisPage = next;
    stats.stage = "listing";
    let url = `${d.gmailApiUrl}/users/me/messages?q=${encodeURIComponent(query)}&maxResults=500`;
    if (next) url += `&pageToken=${encodeURIComponent(next)}`;
    const res = await f(url, { headers: auth, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      stats.lastError = `list ${res.status}`;
      await progress(thisPage);
      throw new Error(`Gmail list failed (${res.status})`);
    }
    const page = await res.json() as { messages?: Array<{ id: string }>; nextPageToken?: string };
    const refs = page.messages ?? [];
    next = page.nextPageToken;
    stats.pages++;
    stats.listed += refs.length;
    stats.stage = "processing";
    await progress(thisPage);

    const have = refs.length ? await d.storedIds(refs.map((r) => r.id)) : new Set<string>();
    const todo = refs.filter((r) => !have.has(r.id));
    for (let i = 0; i < todo.length; i += 10) {
      if (now() > deadline) return { complete: false, pageToken: thisPage, stats };
      await Promise.all(todo.slice(i, i + 10).map(async (ref) => {
        try {
          const m = await f(`${d.gmailApiUrl}/users/me/messages/${ref.id}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
          if (!m.ok) { const k = String(m.status); stats.httpFail[k] = (stats.httpFail[k] ?? 0) + 1; return; }
          stats.fetched++;
          if (await d.processMessage(await m.json())) stats.stored++; else stats.skipped++;
        } catch (e) {
          stats.errors++;
          stats.lastError = (e as Error).message.slice(0, 200);
        }
      }));
      await progress(thisPage);
    }
  } while (next);

  stats.stage = "done";
  return { complete: true, stats };
}

// ---------------------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------------------

/** Folders the backfill walks, in order. Matches the live sync (Inbox + Sent Items; no Junk/Deleted/Drafts). */
export const GRAPH_BACKFILL_FOLDERS = ["inbox", "sentitems"] as const;

const GRAPH_SELECT = [
  "id", "internetMessageId", "conversationId", "subject", "bodyPreview", "body", "from",
  "toRecipients", "ccRecipients", "bccRecipients", "receivedDateTime", "sentDateTime",
  "hasAttachments", "isDraft",
].join(",");

/** First page URL for one folder: KQL participants search finds the address in from/to/cc/bcc. */
export function graphContactSearchUrl(folder: string, email: string): string {
  const e = normalizeBackfillEmail(email).replace(/"/g, "");
  return `/me/mailFolders/${folder}/messages?$search="participants:${e}"&$select=${GRAPH_SELECT}&$top=50`;
}

export interface GraphBackfillDeps {
  email: string;
  startFolder?: string;
  startToken?: string;
  budgetMs?: number;
  now?: () => number;
  /** GET a Graph path or absolute nextLink; the caller adds auth and the Prefer header. */
  graphGet: (pathOrUrl: string) => Promise<Response>;
  /** Stores one Graph message via processGraphMessage; true = stored. */
  processMessage: (msg: Record<string, unknown>) => Promise<boolean>;
  onProgress?: (state: { folder: string; pageToken?: string; stats: BackfillStats }) => Promise<void>;
}

export async function runGraphContactBackfill(d: GraphBackfillDeps): Promise<BackfillResult> {
  const now = d.now ?? Date.now;
  const deadline = now() + (d.budgetMs ?? BACKFILL_BUDGET_MS);
  const cutoff = now() - BACKFILL_WINDOW_DAYS * 86_400_000;
  const stats = newStats();
  let folderIdx = Math.max(0, GRAPH_BACKFILL_FOLDERS.indexOf((d.startFolder ?? "inbox") as typeof GRAPH_BACKFILL_FOLDERS[number]));
  let url: string | undefined = d.startToken;
  const progress = async (folder: string, pageToken?: string) => {
    try { await d.onProgress?.({ folder, pageToken, stats }); } catch { /* diagnostics only */ }
  };

  for (; folderIdx < GRAPH_BACKFILL_FOLDERS.length; folderIdx++) {
    const folder = GRAPH_BACKFILL_FOLDERS[folderIdx];
    let pageUrl: string | undefined = url ?? graphContactSearchUrl(folder, d.email);
    url = undefined;
    while (pageUrl) {
      if (now() > deadline) return { complete: false, folder, pageToken: pageUrl, stats };
      stats.stage = `${folder}`;
      const res = await d.graphGet(pageUrl);
      if (!res.ok) {
        stats.lastError = `graph ${folder} ${res.status}`;
        await progress(folder, pageUrl);
        throw new Error(`Graph ${folder} search failed (${res.status})`);
      }
      const page = await res.json() as { value?: Array<Record<string, unknown>>; "@odata.nextLink"?: string };
      const msgs = page.value ?? [];
      stats.pages++;
      stats.listed += msgs.length;
      for (const m of msgs) {
        const at = Date.parse(String(m.receivedDateTime ?? m.sentDateTime ?? ""));
        if (Number.isFinite(at) && at < cutoff) { stats.skipped++; continue; }
        try {
          stats.fetched++;
          if (await d.processMessage(m)) stats.stored++; else stats.skipped++;
        } catch (e) {
          stats.errors++;
          stats.lastError = (e as Error).message.slice(0, 200);
        }
      }
      pageUrl = page["@odata.nextLink"];
      await progress(folder, pageUrl);
    }
  }
  stats.stage = "done";
  return { complete: true, stats };
}
