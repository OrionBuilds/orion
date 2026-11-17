/**
 * Resolving "Jackson" (or "Jackson Lee", or "acme") to people in the CRM. Org-scoped, active
 * contacts only. Shared by the owner tools (owner-tools.ts) and the read tools (owner-read-tools.ts).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface Person { id: string; name: string; email: string | null; phone: string | null; company: string | null }

const clean = (s: string) => s.replace(/[%_]/g, "");

export async function searchContacts(db: SupabaseClient, orgId: string, q: string, limit = 5): Promise<Person[]> {
  const needle = q.trim();
  if (!needle) return [];
  const parts = needle.split(/\s+/).map(clean).filter(Boolean);
  if (!parts.length) return [];
  const seen = new Map<string, Person>();
  const cols = "id, first_name, last_name, email, phone, company";
  const add = (rows: unknown) => {
    for (const r of (rows ?? []) as { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; company: string | null }[]) {
      seen.set(r.id, { id: r.id, name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || r.company || r.email || "Unknown", email: r.email, phone: r.phone, company: r.company });
    }
  };
  // Every word (up to three) against names and company; the whole string against email and company.
  const probes: [string, string][] = [["email", `%${clean(needle)}%`], ["company", `%${clean(needle)}%`]];
  for (const w of parts.slice(0, 3)) for (const col of ["first_name", "last_name", "company"]) probes.push([col, `%${w}%`]);
  for (const [col, pat] of probes) {
    const { data } = await db.from("contacts").select(cols).eq("organization_id", orgId).eq("status", "active").ilike(col, pat).limit(10);
    add(data);
  }
  let all = [...seen.values()];
  // "Jackson Lee": prefer people whose name/company contains every word.
  if (parts.length > 1) {
    const strict = all.filter((p) => parts.every((w) => `${p.name} ${p.company ?? ""}`.toLowerCase().includes(w.toLowerCase())));
    if (strict.length) all = strict;
  }
  // An exact (case-insensitive) full-name or first-name match beats partial ones.
  const exact = all.filter((p) => p.name.toLowerCase() === needle.toLowerCase() || p.name.toLowerCase().split(" ")[0] === needle.toLowerCase());
  return (exact.length ? exact : all).slice(0, limit);
}
