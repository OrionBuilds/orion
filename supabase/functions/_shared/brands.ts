/**
 * Client brands served from the one OS org. A contact's `brand` decides which
 * sender its client-facing email comes from (email_from_addresses.brand).
 * Unrelated to Brandboard's brand_kits / brand_voices.
 */
import type { Db } from "./lead-intake.ts";

/**
 * Brands come from ORION_BRANDS, a JSON array such as
 *   [{"key":"default","label":"My Business"},{"key":"studio","label":"Studio","siteUrl":"https://studio.example.com","legalName":"Studio LLC"}]
 * The first entry is the default brand. Unset or invalid = a single "default" brand.
 * Mirrors src/lib/brands.ts (VITE_ORION_BRANDS).
 */
export type Brand = string;

export interface BrandConfig {
  key: string;
  label: string;
  /** Public website shown on documents written as this brand. */
  siteUrl?: string;
  /** Legal name on documents written as this brand; defaults to the label. */
  legalName?: string;
}

export const FALLBACK_BRANDS: BrandConfig[] = [{ key: "default", label: "My Business" }];

/** Parse a brands JSON array; invalid entries are dropped, an empty result falls back to one "default" brand. */
export function parseBrands(raw: unknown): BrandConfig[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch { list = null; }
  }
  if (!Array.isArray(list)) return FALLBACK_BRANDS;
  const out: BrandConfig[] = [];
  for (const item of list) {
    const key = typeof item?.key === "string" ? item.key.trim() : "";
    if (!key || out.some((b) => b.key === key)) continue;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const siteUrl = str(item.siteUrl);
    const legalName = str(item.legalName);
    out.push({ key, label: str(item.label) ?? key, ...(siteUrl ? { siteUrl } : {}), ...(legalName ? { legalName } : {}) });
  }
  return out.length ? out : FALLBACK_BRANDS;
}

export const BRANDS: BrandConfig[] = parseBrands(Deno.env.get("ORION_BRANDS"));

/** Brand keys, for tool-schema enums. */
export const BRAND_KEYS: string[] = BRANDS.map((b) => b.key);

export const DEFAULT_BRAND: Brand = BRANDS[0].key;

export function isBrand(v: unknown): v is Brand {
  return typeof v === "string" && BRANDS.some((b) => b.key === v);
}

/** A configured brand key from an env var (e.g. SITE_LEAD_BRAND), else the default brand. */
export function brandFromEnv(name: string): Brand {
  const v = Deno.env.get(name)?.trim();
  return isBrand(v) ? v : DEFAULT_BRAND;
}

/** `settings.brand` from a forms / calendars settings jsonb, when valid. */
export function brandFromSettings(settings: unknown): Brand | null {
  const v = settings && typeof settings === "object" ? (settings as Record<string, unknown>).brand : null;
  return isBrand(v) ? v : null;
}

export interface BrandSenderRow {
  id: string;
  email: string;
  display_name: string | null;
  reply_to: string | null;
  brand: Brand;
}

/** The contact's brand as stored; the default when the contact is unknown or the column is empty. */
export async function loadContactBrand(db: Db, contactId: string | null | undefined): Promise<Brand> {
  if (!contactId) return DEFAULT_BRAND;
  try {
    const { data } = await db.from("contacts").select("brand").eq("id", contactId).maybeSingle();
    return typeof data?.brand === "string" && data.brand.trim() ? data.brand : DEFAULT_BRAND;
  } catch {
    return DEFAULT_BRAND;
  }
}

/** The active sender row flagged for a brand, or null when none is configured. */
export async function loadBrandSender(db: Db, orgId: string, brand: Brand): Promise<BrandSenderRow | null> {
  try {
    const { data } = await db.from("email_from_addresses")
      .select("id, email, display_name, reply_to, brand")
      .eq("org_id", orgId).eq("brand", brand).eq("active", true)
      .limit(1).maybeSingle();
    return (data as BrandSenderRow | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Sender for a client-facing email: the explicit brand, else the contact's brand.
 * Returns the brand and its sender row (null row = fall back to the org default).
 */
export async function resolveBrandSender(
  db: Db,
  orgId: string,
  o: { brand?: Brand | null; contactId?: string | null },
): Promise<{ brand: Brand; row: BrandSenderRow | null }> {
  const brand = o.brand ?? (o.contactId ? await loadContactBrand(db, o.contactId) : DEFAULT_BRAND);
  return { brand, row: await loadBrandSender(db, orgId, brand) };
}

export interface BrandOrgFields {
  name?: string | null;
  display_name?: string | null;
  legal_name?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
}

/**
 * The business a client document is written as. The default brand is the org row's identity
 * (display_name, legal_name); another configured brand is written as its own name (legalName,
 * else label) with its siteUrl and that brand's sender address.
 */
export function brandIdentity(
  brand: Brand,
  org: BrandOrgFields | null | undefined,
  sender?: { email?: string | null } | null,
  brands: BrandConfig[] = BRANDS,
): { name: string; legal_name: string; email: string; phone: string; website: string } {
  const cfg = brands.find((b) => b.key === brand);
  if (cfg && cfg.key !== brands[0].key) {
    const name = cfg.legalName || cfg.label;
    return {
      name,
      legal_name: name,
      email: sender?.email || org?.email || "",
      phone: org?.phone || "",
      website: cfg.siteUrl || org?.website || "",
    };
  }
  return {
    name: org?.display_name || org?.name || "Our Company",
    legal_name: org?.legal_name || "",
    email: org?.email || "",
    phone: org?.phone || "",
    website: org?.website || "",
  };
}
