/**
 * What Clara knows about herself and her owner before any tool call: which accounts are connected
 * (and to which provider), where she sends mail from, her phone numbers, the org's default
 * workspace provider, connected integrations, and what the owner asked her to remember.
 *
 * Injected into the owner-brain system prompt as a compact block, so "which mailbox is mine?",
 * "what's your number?" or "are we on Google or Microsoft?" need no tool. Token columns are never
 * selected. Every lookup is org-scoped and best-effort: a failed read just leaves a line out.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";
import { normalizeAccountProvider } from "../provider.ts";

export interface SelfCtx { db: SupabaseClient; env: Env; orgId: string; ownerUserId: string | null; claraUserId: string | null; claraNumber: string }

const PROVIDER_LABEL: Record<string, string> = { microsoft: "Microsoft 365", google: "Google Workspace" };
export const MEMORY_LIMIT = 12;

interface Account { user_id: string; provider: string; provider_account_email: string | null; status: string | null }

function accountsLine(who: string, rows: Account[]): string {
  const live = rows.filter((r) => normalizeAccountProvider(r.provider));
  if (!live.length) return `${who}: no Microsoft 365 or Google account connected.`;
  return `${who}: ` + live.map((r) => `${PROVIDER_LABEL[normalizeAccountProvider(r.provider)!]} ${r.provider_account_email ?? "(address unknown)"}${r.status && r.status !== "connected" ? ` (${r.status})` : ""}`).join("; ") + ".";
}

export async function loadMemories(db: SupabaseClient, orgId: string, ownerUserId: string | null, limit = MEMORY_LIMIT): Promise<{ id: string; content: string; memory_type: string; updated_at: string }[]> {
  if (!ownerUserId) return [];
  const { data } = await db.from("clara_memories").select("id, content, memory_type, importance_score, updated_at")
    .eq("organization_id", orgId).eq("user_id", ownerUserId).order("importance_score", { ascending: false }).limit(limit);
  return (data ?? []) as { id: string; content: string; memory_type: string; updated_at: string }[];
}

/** The compact block. Never throws (an unreadable source just leaves its line out; total failure = ""). */
export async function loadSelfContext(c: SelfCtx): Promise<string> {
  try {
    return await buildSelfContext(c);
  } catch (e) {
    console.warn("[owner-self] context unavailable:", (e as Error).message);
    return "";
  }
}

async function buildSelfContext(c: SelfCtx): Promise<string> {
  const lines: string[] = [];
  const safe = async <T>(p: PromiseLike<{ data: T | null }>): Promise<T | null> => { try { return (await p).data; } catch { return null; } };

  const ids = [c.ownerUserId, c.claraUserId].filter((x): x is string => !!x);
  const [accounts, org, numbers, integrations, memories] = await Promise.all([
    ids.length ? safe<Account[]>(c.db.from("user_connected_accounts").select("user_id, provider, provider_account_email, status").in("user_id", ids)) : Promise.resolve([] as Account[]),
    safe<{ name: string | null; display_name: string | null; default_workspace_provider: string | null }>(c.db.from("organizations").select("name, display_name, default_workspace_provider").eq("id", c.orgId).maybeSingle()),
    safe<{ phone_number: string; friendly_name: string | null; agent_label: string | null; sms_route: string | null; status: string | null }[]>(
      c.db.from("twilio_numbers").select("phone_number, friendly_name, agent_label, sms_route, status").eq("org_id", c.orgId)),
    safe<{ status: string; integrations: { name: string } | { name: string }[] | null }[]>(
      c.db.from("integration_connections").select("status, integrations(name)").eq("org_id", c.orgId).is("user_id", null)),
    loadMemories(c.db, c.orgId, c.ownerUserId).catch(() => []),
  ]);

  const acc = (accounts ?? []) as Account[];
  lines.push(accountsLine("The owner's connected accounts", acc.filter((a) => a.user_id === c.ownerUserId)));
  const claraAcc = acc.filter((a) => a.user_id === c.claraUserId);
  lines.push(accountsLine("Your (Clara's) connected accounts", claraAcc));
  const sendFrom = claraAcc.find((a) => normalizeAccountProvider(a.provider) === "microsoft")?.provider_account_email;
  lines.push(sendFrom ? `You send email from ${sendFrom}; the owner is CC'd on everything you send.` : "You have no mailbox connected to send email from.");
  if (org) {
    const p = org.default_workspace_provider;
    lines.push(`Organization: ${org.display_name || org.name || "unnamed"}; default workspace provider: ${p && PROVIDER_LABEL[p] ? PROVIDER_LABEL[p] : "not set"}.`);
  }
  const mine = (numbers ?? []).filter((n) => n.status === "active" && (n.sms_route === "clara" || (n.agent_label ?? "").toLowerCase() === "clara"));
  if (mine.length) lines.push(`Your phone numbers: ${mine.map((n) => `${n.phone_number}${n.friendly_name && !/^\(\d{3}\)/.test(n.friendly_name) ? ` (${n.friendly_name})` : ""}`).join(", ")}. This conversation's number: ${c.claraNumber || "n/a"}.`);
  const integ = (integrations ?? []).filter((i) => i.status === "connected")
    .map((i) => (Array.isArray(i.integrations) ? i.integrations[0]?.name : i.integrations?.name)).filter(Boolean);
  if (integ.length) lines.push(`Org integrations connected: ${integ.join(", ")}.`);

  let block = `Accounts and identity (from the OS, current):\n- ${lines.join("\n- ")}`;
  if (memories.length) {
    block += `\n\nThings the owner asked you to remember (in the owner's words; may be out of date):\n` +
      memories.map((m) => `- ${m.content.replace(/\s+/g, " ").slice(0, 240)}`).join("\n");
  }
  return block;
}
