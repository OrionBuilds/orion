import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Globe, Search } from 'lucide-react';
import { Portal } from '../shared/Portal';

interface TimezoneSelectProps {
  value: string;
  onChange: (tz: string) => void;
  className?: string;
}

const FALLBACK_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Phoenix',
  'America/Toronto',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'America/Buenos_Aires',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Europe/Rome',
  'Europe/Athens',
  'Europe/Istanbul',
  'Europe/Moscow',
  'Africa/Lagos',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Perth',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Pacific/Auckland',
  'Pacific/Honolulu',
];

function getAllZones(): string[] {
  const intlAny = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  if (typeof intlAny.supportedValuesOf === 'function') {
    try {
      const list = intlAny.supportedValuesOf('timeZone');
      if (Array.isArray(list) && list.length > 0) return list;
    } catch {
      // fall through
    }
  }
  return FALLBACK_ZONES;
}

// Common names people search by. Intl's long names ("Central Standard Time") and short names
// ("CST", "GMT+1") are added per zone at runtime; these cover the rest and rank a canonical zone first.
const ZONE_ALIASES: Record<string, string[]> = {
  'America/New_York': ['eastern', 'et', 'est', 'edt', 'us eastern'],
  'America/Chicago': ['central', 'ct', 'cst', 'cdt', 'us central'],
  'America/Denver': ['mountain', 'mt', 'mst', 'mdt', 'us mountain'],
  'America/Phoenix': ['arizona', 'mst'],
  'America/Los_Angeles': ['pacific', 'pt', 'pst', 'pdt', 'us pacific'],
  'America/Anchorage': ['alaska', 'akst', 'akdt'],
  'Pacific/Honolulu': ['hawaii', 'hst'],
  'America/Halifax': ['atlantic', 'ast', 'adt'],
  'America/St_Johns': ['newfoundland', 'nst', 'ndt'],
  'Europe/London': ['uk', 'britain', 'gmt', 'bst'],
  'Europe/Paris': ['cet', 'cest', 'central european'],
  'Europe/Berlin': ['cet', 'cest', 'central european', 'germany'],
  'Europe/Athens': ['eet', 'eest', 'eastern european'],
  'Asia/Kolkata': ['india', 'ist'],
  'Asia/Tokyo': ['japan', 'jst'],
  'Asia/Shanghai': ['china'],
  'Australia/Sydney': ['aest', 'aedt', 'australia eastern'],
  UTC: ['utc', 'gmt', 'universal', 'zulu'],
};

function zoneNames(tz: string): { offset: string; short: string; long: string } {
  const pick = (timeZoneName: 'shortOffset' | 'short' | 'long') => {
    try {
      return (
        new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName })
          .formatToParts(new Date())
          .find((p) => p.type === 'timeZoneName')?.value ?? ''
      );
    } catch {
      return '';
    }
  };
  return { offset: pick('shortOffset').replace('GMT', 'UTC'), short: pick('short'), long: pick('long') };
}

interface ZoneItem {
  tz: string;
  region: string;
  city: string;
  offset: string;
  /** Lower-cased search terms: zone id, city, region, offset, abbreviation, long name, aliases. */
  terms: string[];
  aliases: string[];
}

function buildZones(): ZoneItem[] {
  return getAllZones().map((tz) => {
    const [region, ...rest] = tz.split('/');
    const city = rest.join('/').replace(/_/g, ' ') || tz;
    const { offset, short, long } = zoneNames(tz);
    const aliases = ZONE_ALIASES[tz] ?? [];
    const terms = [tz, city, region, offset, short, long, ...aliases]
      .filter(Boolean)
      .map((t) => t.toLowerCase().replace(/_/g, ' '));
    return { tz, region, city, offset, terms, aliases };
  });
}

/** Lower is better: alias hit, then city prefix, then any term prefix, then substring. -1 = no match. */
function matchScore(z: ZoneItem, q: string): number {
  if (z.aliases.some((a) => a === q || a.startsWith(q))) return 0;
  if (z.city.toLowerCase().startsWith(q)) return 1;
  if (z.terms.some((t) => t.startsWith(q))) return 2;
  if (z.terms.some((t) => t.includes(q))) return 3;
  return -1;
}

const PANEL_MAX_HEIGHT = 320;
const SEARCH_BOX_HEIGHT = 56;

interface PanelPosition {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function TimezoneSelect({ value, onChange, className }: TimezoneSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const zones = useMemo(() => buildZones(), []);
  const q = query.trim().toLowerCase();

  // No query: grouped by region. With a query: one list, best matches first.
  const results = useMemo(() => {
    if (!q) return null;
    return zones
      .map((z) => ({ z, score: matchScore(z, q) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => a.score - b.score || a.z.tz.localeCompare(b.z.tz))
      .map((r) => r.z);
  }, [zones, q]);

  const grouped = useMemo(() => {
    const map = new Map<string, ZoneItem[]>();
    for (const z of zones) {
      const arr = map.get(z.region) || [];
      arr.push(z);
      map.set(z.region, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [zones]);

  const selected = useMemo(() => zones.find((z) => z.tz === value), [zones, value]);

  // The booking card clips overflow, so the panel renders in the overlay layer, anchored to the
  // button: below it when there is room, otherwise above it, never taller than the space left.
  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gutter = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const width = Math.min(Math.max(rect.width, 280), viewportW - gutter * 2);
    const left = Math.min(Math.max(rect.left, gutter), viewportW - width - gutter);
    const below = viewportH - rect.bottom - gutter;
    const above = rect.top - gutter;
    if (below >= 240 || below >= above) {
      setPosition({ left, width, top: rect.bottom + 4, maxHeight: Math.min(PANEL_MAX_HEIGHT, below - 4) });
    } else {
      setPosition({ left, width, bottom: viewportH - rect.top + 4, maxHeight: Math.min(PANEL_MAX_HEIGHT, above - 4) });
    }
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
    } else {
      setQuery('');
    }
  }, [isOpen]);

  const choose = (tz: string) => {
    onChange(tz);
    setIsOpen(false);
    buttonRef.current?.focus();
  };

  const renderZone = (z: ZoneItem, showRegion: boolean) => {
    const isSelected = z.tz === value;
    return (
      <button
        key={z.tz}
        type="button"
        role="option"
        aria-selected={isSelected}
        onClick={() => choose(z.tz)}
        className={`w-full px-3 py-2 flex items-center justify-between text-left text-sm transition-colors ${
          isSelected ? 'bg-hud-gold/10 text-hud-gold-soft' : 'text-hud-cream-soft hover:bg-hud-bg-card'
        }`}
      >
        <span className="truncate">
          {z.city || z.tz}
          {showRegion && z.region !== z.tz && <span className="text-hud-cream-mute"> · {z.region}</span>}
        </span>
        {z.offset && <span className="ml-3 text-xs text-hud-cream-mute font-mono shrink-0">{z.offset}</span>}
      </button>
    );
  };

  const opensUpward = position?.bottom !== undefined;

  return (
    <div className={`relative ${className || ''}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
      >
        <Globe className="w-4 h-4 text-hud-cream-dim shrink-0" />
        <span className="flex-1 text-left truncate">{selected ? `${selected.city || selected.tz}` : value}</span>
        {selected?.offset && <span className="text-xs text-hud-cream-dim font-mono">{selected.offset}</span>}
        <ChevronDown className={`w-4 h-4 text-hud-cream-dim transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && position && (
        <Portal>
          <div
            ref={panelRef}
            style={{ position: 'fixed', left: position.left, width: position.width, top: position.top, bottom: position.bottom }}
            className={`z-[110] flex bg-hud-bg-mid border border-hud-bg-elev rounded-lg shadow-xl overflow-hidden ${
              opensUpward ? 'flex-col-reverse' : 'flex-col'
            }`}
          >
            {/* Search sits next to the button: on top when opening down, at the bottom when opening up. */}
            <div className={`p-2 border-hud-bg-elev shrink-0 ${opensUpward ? 'border-t' : 'border-b'}`}>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setIsOpen(false);
                      buttonRef.current?.focus();
                    } else if (e.key === 'Enter' && results?.[0]) {
                      e.preventDefault();
                      choose(results[0].tz);
                    }
                  }}
                  placeholder="City, region or abbreviation (e.g. Central, CET)"
                  aria-label="Search timezones"
                  className="w-full pl-9 pr-3 py-2 rounded-md bg-hud-bg-card border border-hud-bg-elev text-white text-sm placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
                />
              </div>
            </div>

            <div
              role="listbox"
              className="overflow-y-auto overscroll-contain"
              style={{ maxHeight: Math.max(position.maxHeight - SEARCH_BOX_HEIGHT, 120) }}
            >
              {results ? (
                results.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-hud-cream-mute">No timezones match "{query}"</div>
                ) : (
                  results.map((z) => renderZone(z, true))
                )
              ) : (
                grouped.map(([region, list]) => (
                  <div key={region}>
                    <div className="px-3 py-1.5 bg-hud-bg-card text-xs font-medium text-hud-cream-dim uppercase tracking-wider sticky top-0">
                      {region}
                    </div>
                    {list.map((z) => renderZone(z, false))}
                  </div>
                ))
              )}
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
}
