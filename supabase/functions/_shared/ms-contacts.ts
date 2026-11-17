/**
 * Outlook contacts -> OS CRM enrichment (read-only input).
 *
 * Decision (owner, 2026-10-15): Outlook is input only. An Outlook contact is linked to an
 * EXISTING active CRM contact by email and may fill that contact's EMPTY phone / company /
 * job_title. It never creates CRM contacts, never overwrites a non-empty field, and nothing
 * is ever written back to Outlook.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { graphFetch } from "./ms-graph.ts";

export interface GraphContact {
  emailAddresses?: { address?: string }[];
  mobilePhone?: string | null;
  businessPhones?: string[];
  homePhones?: string[];
  companyName?: string | null;
  jobTitle?: string | null;
}

export interface Enrichment {
  emails: string[];
  phone: string | null;
  company: string | null;
  jobTitle: string | null;
}

const clean = (s?: string | null) => (s ?? "").trim() || null;

export function parseGraphContact(c: GraphContact): Enrichment {
  const emails = [...new Set((c.emailAddresses ?? []).map((e) => (e.address ?? "").trim().toLowerCase()).filter(Boolean))];
  return {
    emails,
    phone: clean(c.mobilePhone) ?? clean(c.businessPhones?.[0]) ?? clean(c.homePhones?.[0]),
    company: clean(c.companyName),
    jobTitle: clean(c.jobTitle),
  };
}

export interface CrmRow { id: string; email: string | null; phone: string | null; company: string | null; job_title: string | null }

/** Only the fields that are empty in the CRM and present in Outlook. Empty object = no-op. */
export function fillBlanks(crm: CrmRow, e: Enrichment): Record<string, string> {
  const patch: Record<string, string> = {};
  if (!clean(crm.phone) && e.phone) patch.phone = e.phone;
  if (!clean(crm.company) && e.company) patch.company = e.company;
  if (!clean(crm.job_title) && e.jobTitle) patch.job_title = e.jobTitle;
  return patch;
}

export async function enrichCrmFromOutlook(
  supabase: SupabaseClient,
  accessToken: string,
  ctx: { orgId: string },
  opts: { maxPages?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ scanned: number; matched: number; updated: number }> {
  // Outlook side: fully fetched before any write.
  const byEmail = new Map<string, Enrichment>();
  let url: string | undefined =
    "/me/contacts?$top=100&$select=emailAddresses,mobilePhone,businessPhones,homePhones,companyName,jobTitle";
  let scanned = 0, pages = 0;
  while (url) {
    if (++pages > (opts.maxPages ?? 30)) throw new Error("Outlook contact list exceeds page budget");
    const r = await graphFetch(accessToken, url, {}, opts.fetchImpl);
    if (!r.ok) throw new Error(`Graph contacts failed: ${r.status}`);
    const page = await r.json() as { value: GraphContact[]; "@odata.nextLink"?: string };
    for (const c of page.value) {
      scanned++;
      const e = parseGraphContact(c);
      for (const em of e.emails) if (!byEmail.has(em)) byEmail.set(em, e);
    }
    url = page["@odata.nextLink"];
  }

  // CRM side: active contacts with an email, paged.
  let matched = 0, updated = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("contacts")
      .select("id, email, phone, company, job_title")
      .eq("organization_id", ctx.orgId).eq("status", "active").not("email", "is", null)
      .order("id").range(from, from + 999);
    if (error) throw new Error(`CRM contact read failed: ${error.message}`);
    for (const row of (data ?? []) as CrmRow[]) {
      const e = byEmail.get((row.email ?? "").trim().toLowerCase());
      if (!e) continue;
      matched++;
      const patch = fillBlanks(row, e);
      if (Object.keys(patch).length === 0) continue;
      const { error: upErr } = await supabase.from("contacts")
        .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", row.id);
      if (upErr) throw new Error(`CRM contact update failed: ${upErr.message}`);
      updated++;
    }
    if (!data || data.length < 1000) break;
  }
  return { scanned, matched, updated };
}
