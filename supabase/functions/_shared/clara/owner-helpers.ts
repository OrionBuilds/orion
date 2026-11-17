/**
 * Small lookups shared by the owner tools (owner-tools.ts, owner-manage-tools.ts). Kept apart so
 * the tool modules never import each other's values.
 */
import type { OwnerCtx } from "./owner-tools.ts";

/**
 * The owner's personal task list is calendar_tasks on his type='user' calendar (what the Tasks
 * page's "Personal" option and "My tasks" read). Orgs created before that convention may have no
 * such calendar; the first task creates it, exactly as the calendar module would.
 */
export async function personalCalendarId(c: OwnerCtx, userId: string): Promise<string | null> {
  const find = async (activeOnly: boolean) => {
    let q = c.db.from("calendars").select("id").eq("org_id", c.orgId).eq("type", "user").eq("owner_user_id", userId);
    if (activeOnly) q = q.eq("active", true);
    const { data } = await q.limit(1).maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };
  const existing = (await find(true)) ?? (await find(false));
  if (existing) return existing;
  const { data, error } = await c.db.from("calendars").insert({
    org_id: c.orgId, type: "user", owner_user_id: userId, name: "Personal tasks", slug: `personal-${userId.slice(0, 8)}`, active: true,
  }).select("id").maybeSingle();
  if (error) return error.code === "23505" ? await find(false) : null;
  return (data as { id: string } | null)?.id ?? null;
}

export interface TeamUser { id: string; name: string; email: string | null }

/**
 * Who on the team does "who" mean? "me" is the owner; otherwise an active OS user (people and the
 * agents: Clara, FRIDAY, Harvey, Jason) whose name or email contains every word. One match or a question.
 */
export async function resolveUser(c: OwnerCtx, who: string): Promise<{ user: TeamUser } | { clarify: string }> {
  const w = who.trim().toLowerCase();
  const { data } = await c.db.from("users").select("id, name, email, status").eq("organization_id", c.orgId).limit(200);
  const team = ((data ?? []) as { id: string; name: string | null; email: string | null; status?: string | null }[])
    .filter((u) => !u.status || u.status === "active")
    .map((u) => ({ id: u.id, name: u.name || u.email || "Unnamed", email: u.email }));
  if (/^(me|myself|mine|i|the owner)$/.test(w)) {
    const me = team.find((u) => u.id === c.ownerUserId);
    return me ? { user: me } : c.ownerUserId ? { user: { id: c.ownerUserId, name: "you", email: null } } : { clarify: "I don't know which OS user is you (OWNER_USER_ID isn't configured)." };
  }
  const words = w.split(/\s+/).filter(Boolean);
  let hits = words.length ? team.filter((u) => words.every((x) => `${u.name} ${u.email ?? ""}`.toLowerCase().includes(x))) : [];
  const exact = hits.filter((u) => u.name.toLowerCase() === w || u.name.toLowerCase().split(/\s+/)[0] === w);
  if (exact.length === 1) hits = exact;
  if (hits.length === 1) return { user: hits[0] };
  const list = (hits.length ? hits : team).slice(0, 8).map((u) => u.name).join(", ");
  return { clarify: hits.length ? `Which one: ${list}?` : `Nobody on the team matches "${who.trim()}". The team is: ${list}.` };
}
