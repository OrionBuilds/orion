/** Pure helpers for the resend-webhook: what a bounce/complaint means and who to tell. */

export interface ResendEventData {
  email_id?: string;
  to?: string | string[];
  subject?: string;
  tags?: Record<string, string> | Array<{ name: string; value: string }>;
  bounce?: { type?: string; subType?: string; message?: string };
}

export const tagValue = (data: ResendEventData, name: string): string | null => {
  const t = data.tags;
  if (!t) return null;
  if (Array.isArray(t)) return t.find((x) => x.name === name)?.value ?? null;
  return t[name] ?? null;
};

/**
 * Does this event mean the ADDRESS is bad? A complaint always does. A bounce only when it is a permanent
 * one: a transient or reputation/policy bounce (5.7.x, "blocked") says nothing about the recipient and must
 * not blacklist a real contact. A bounce with no detail keeps the old behaviour (suppress).
 */
export function shouldSuppress(eventType: string, data: ResendEventData): boolean {
  if (eventType === "email.complained") return true;
  if (eventType !== "email.bounced") return false;
  const b = data.bounce;
  if (!b?.type) return true;
  if (/5\.7\.\d+/.test(b.message ?? "")) return false;
  return b.type.toLowerCase() === "permanent";
}

/** The bell notification for the sender: bounce or spam complaint. Null for any other event. */
export function failureNotification(eventType: string, data: ResendEventData, userId: string) {
  if (eventType !== "email.bounced" && eventType !== "email.complained") return null;
  const to = (Array.isArray(data.to) ? data.to.join(", ") : data.to) || "a recipient";
  const complaint = eventType === "email.complained";
  const reason = (data.bounce?.message ?? "").slice(0, 300);
  return {
    user_id: userId,
    type: "email_delivery_failed",
    title: complaint ? "A recipient marked your email as spam" : "An email you sent was not delivered",
    body: complaint
      ? `${to} reported "${data.subject ?? "your email"}" as spam. They won't be emailed again.`
      : `Delivery to ${to} failed${data.bounce?.type ? ` (${data.bounce.type}${data.bounce.subType ? `, ${data.bounce.subType}` : ""})` : ""}${reason ? `: ${reason}` : ""}`,
    link: "/conversations",
    metadata: { external_id: data.email_id ?? null, provider: "resend", event: eventType, recipients: Array.isArray(data.to) ? data.to : data.to ? [data.to] : [] },
  };
}
