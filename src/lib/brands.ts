/**
 * Client brands served from this OS org. A contact's brand decides which sender
 * its client-facing email comes from (Settings → Email → From Addresses, "Brand").
 * Mirrors supabase/functions/_shared/brands.ts.
 *
 * Configured with VITE_ORION_BRANDS, a JSON array such as
 *   [{"key":"default","label":"My Business"},{"key":"studio","label":"Studio","short":"ST"}]
 * The first entry is the default brand. Unset or invalid = a single "default" brand.
 */
export type Brand = string;

export interface BrandConfig {
  key: string;
  label: string;
  short?: string;
}

export const FALLBACK_BRANDS: BrandConfig[] = [{ key: 'default', label: 'My Business' }];

/** Parse a brands JSON array; invalid entries are dropped, an empty result falls back to one "default" brand. */
export function parseBrands(raw: unknown): BrandConfig[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = null; }
  }
  if (!Array.isArray(list)) return FALLBACK_BRANDS;
  const out: BrandConfig[] = [];
  for (const item of list) {
    const key = typeof item?.key === 'string' ? item.key.trim() : '';
    if (!key || out.some((b) => b.key === key)) continue;
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : key;
    const short = typeof item.short === 'string' && item.short.trim() ? item.short.trim() : undefined;
    out.push({ key, label, ...(short ? { short } : {}) });
  }
  return out.length ? out : FALLBACK_BRANDS;
}

const CONFIGURED = parseBrands(import.meta.env.VITE_ORION_BRANDS);

export const BRANDS: { slug: Brand; name: string; short: string }[] = CONFIGURED.map((b) => ({
  slug: b.key,
  name: b.label,
  short: b.short ?? b.label.slice(0, 2).toUpperCase(),
}));

export const DEFAULT_BRAND: Brand = BRANDS[0].slug;

export function brandName(slug: string | null | undefined): string {
  return BRANDS.find((b) => b.slug === slug)?.name ?? BRANDS[0].name;
}

export function isBrand(v: unknown): v is Brand {
  return typeof v === 'string' && BRANDS.some((b) => b.slug === v);
}
