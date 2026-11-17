/** What a phone notification says, built from a `notifications` row (pure; the send-push function does the I/O). */
export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Same tag = the new notification replaces the old one instead of stacking. */
  tag: string;
  urgent: boolean;
}

const trim = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Only same-origin app paths are allowed as a click target. */
export function safeUrl(link: string | null | undefined): string {
  if (!link || !link.startsWith("/") || link.startsWith("//")) return "/";
  return link.slice(0, 300);
}

export function buildPushPayload(n: NotificationRow, pendingApprovals = 0): PushPayload {
  const meta = n.metadata ?? {};
  switch (n.type) {
    case "agent_approval":
      // Harvey drafts arrive in bulk: one rolling "N waiting" notification, not thirty.
      return {
        title: "Approval needed",
        body: pendingApprovals > 1 ? `${pendingApprovals} agent actions are waiting for you` : trim(n.body || n.title, 140),
        url: "/automation/approvals", tag: "approvals", urgent: true,
      };
    case "message":
    case "email": {
      const conv = typeof meta.conversation_id === "string" ? meta.conversation_id : n.id;
      return { title: trim(n.title, 80), body: trim(n.body, 160), url: safeUrl(n.link), tag: `conv-${conv}`, urgent: false };
    }
    case "agent_request":
    case "clara":
      return { title: trim(n.title, 80), body: trim(n.body, 160), url: safeUrl(n.link), tag: `${n.type}-${n.id}`, urgent: true };
    default:
      return { title: trim(n.title, 80), body: trim(n.body, 160), url: safeUrl(n.link), tag: `${n.type}-${n.id}`, urgent: false };
  }
}
