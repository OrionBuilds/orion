import { brandName, DEFAULT_BRAND, type Brand } from '../../lib/brands';

/** Small label showing which client base a contact belongs to. */
export function BrandBadge({ brand, size = 'sm' }: { brand: Brand | string | null | undefined; size?: 'sm' | 'md' }) {
  const alt = !!brand && brand !== DEFAULT_BRAND;
  return (
    <span
      title={`${brandName(brand)} client`}
      className={`inline-flex items-center rounded font-medium whitespace-nowrap ${
        size === 'md' ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-0.5 text-[10px]'
      } ${alt ? 'bg-hud-gold/10 text-hud-gold-soft' : 'bg-hud-teal/10 text-hud-teal'}`}
    >
      {brandName(brand)}
    </span>
  );
}
