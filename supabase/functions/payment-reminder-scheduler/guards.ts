/** Pure guards run before every reminder is sent. A reminder that fails a guard is cancelled, never sent. */
export interface GuardInvoice {
  status: string;
  disputed_at?: string | null;
}

export type ReminderSkip = "missing" | "paid_or_void" | "disputed";

/** Why this reminder must not go out, or null when it may. Disputed invoices are held: chasing a customer who is contesting the bill is the failure this build must never produce. */
export function reminderSkipReason(invoice: GuardInvoice | null | undefined): ReminderSkip | null {
  if (!invoice) return "missing";
  if (invoice.status === "paid" || invoice.status === "void") return "paid_or_void";
  if (invoice.disputed_at) return "disputed";
  return null;
}

export const SKIP_MESSAGE: Record<ReminderSkip, string> = {
  missing: "Invoice not found",
  paid_or_void: "Invoice is paid or voided",
  disputed: "Invoice is on dispute hold",
};
