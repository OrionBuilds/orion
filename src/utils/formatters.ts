/**
 * Shared display formatters.
 *
 * These replace the per-component `formatCurrency` / `formatDate` / `getInitials`
 * helpers that were previously redefined in dozens of files.
 */

const DEFAULT_LOCALE = 'en-US';
const DEFAULT_CURRENCY = 'USD';

export interface CurrencyFormatOptions {
  currency?: string | null;
  locale?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

/** A bare currency code (`'USD'`) is accepted as shorthand for `{ currency }`. */
export type CurrencyFormatArg = string | null | undefined | CurrencyFormatOptions;

function toCurrencyOptions(arg: CurrencyFormatArg): CurrencyFormatOptions {
  return typeof arg === 'string' || arg === null || arg === undefined ? { currency: arg } : arg;
}

export function formatCurrency(amount: number, arg: CurrencyFormatArg = {}): string {
  const {
    currency,
    locale = DEFAULT_LOCALE,
    minimumFractionDigits,
    maximumFractionDigits,
  } = toCurrencyOptions(arg);

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency || DEFAULT_CURRENCY,
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(amount);
}

/** Currency without cents, e.g. `$1,250`. */
export function formatWholeCurrency(amount: number, arg: CurrencyFormatArg = {}): string {
  return formatCurrency(amount, {
    ...toCurrencyOptions(arg),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/** Currency that only shows cents when they are non-zero, e.g. `$1,250` / `$1,250.75`. */
export function formatCurrencyOptionalCents(amount: number, arg: CurrencyFormatArg = {}): string {
  return formatCurrency(amount, { ...toCurrencyOptions(arg), minimumFractionDigits: 0 });
}

/** Abbreviated currency for dense summaries, e.g. `$1.2M`, `$12.5K`, `$980`. */
export function formatCompactCurrency(amount: number, arg: CurrencyFormatArg = {}): string {
  if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (Math.abs(amount) >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return formatWholeCurrency(amount, arg);
}

export type DateInput = string | number | Date | null | undefined;

export interface DateFormatOptions {
  /** Returned when the input is empty or unparseable. Defaults to `'-'`. */
  fallback?: string;
  locale?: string;
  timeZone?: string;
  /** Include the weekday, e.g. `Monday, March 5, 2025`. */
  weekday?: boolean;
}

export interface DateTimeFormatOptions extends DateFormatOptions {
  /** `'2-digit'` renders `02:30 PM`, `'numeric'` renders `2:30 PM`. Defaults to `'2-digit'`. */
  hour?: 'numeric' | '2-digit';
}

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function format(
  value: DateInput,
  options: DateFormatOptions,
  intlOptions: Intl.DateTimeFormatOptions,
  method: 'toLocaleDateString' | 'toLocaleString'
): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? '-';
  return date[method](options.locale ?? DEFAULT_LOCALE, {
    ...intlOptions,
    ...(options.weekday ? { weekday: intlOptions.month === 'long' ? 'long' : 'short' } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
}

/** `Mar 5, 2025` */
export function formatDateShort(value: DateInput, options: DateFormatOptions = {}): string {
  return format(
    value,
    options,
    { month: 'short', day: 'numeric', year: 'numeric' },
    'toLocaleDateString'
  );
}

/** `March 5, 2025` */
export function formatDateLong(value: DateInput, options: DateFormatOptions = {}): string {
  return format(
    value,
    options,
    { year: 'numeric', month: 'long', day: 'numeric' },
    'toLocaleDateString'
  );
}

/** Locale-default numeric date, e.g. `3/5/2025`. */
export function formatDateNumeric(value: DateInput, options: DateFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? '-';
  return date.toLocaleDateString(
    options.locale,
    options.timeZone ? { timeZone: options.timeZone } : undefined
  );
}

/** `Mar 5, 2025, 02:30 PM` */
export function formatDateTimeShort(value: DateInput, options: DateTimeFormatOptions = {}): string {
  return format(
    value,
    options,
    {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: options.hour ?? '2-digit',
      minute: '2-digit',
    },
    'toLocaleString'
  );
}

/** Locale-default date and time, e.g. `3/5/2025, 2:30:00 PM`. */
export function formatDateTimeNumeric(value: DateInput, options: DateFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? '-';
  return date.toLocaleString(
    options.locale,
    options.timeZone ? { timeZone: options.timeZone } : undefined
  );
}

/** `2:30 PM` */
export function formatTimeOfDay(value: DateInput, options: DateFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? '-';
  return date.toLocaleTimeString(options.locale ?? DEFAULT_LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
}

/** `1.4 MB` */
export function formatFileSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, exponent);
  return `${exponent === 0 ? size : size.toFixed(1)} ${units[exponent]}`;
}

/** Tailwind background classes used for generated (letter) avatars. */
export const AVATAR_PALETTES = {
  conversation: [
    'bg-blue-600',
    'bg-hud-emerald-dim',
    'bg-hud-rust',
    'bg-rose-600',
    'bg-hud-gold-deep',
    'bg-hud-teal',
  ],
} as const;

/** Stable avatar background class for a name, picked from `palette`. */
export function getAvatarColor(
  name: string | null | undefined,
  palette: readonly string[] = AVATAR_PALETTES.conversation
): string {
  const index = (name || '')
    .split('')
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return palette[index % palette.length];
}

/** First letters of the first two words of a name, e.g. `Ada Lovelace` -> `AL`. */
export function getInitials(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/** Initials from separate name fields, e.g. `('Ada', 'Lovelace')` -> `AL`. */
export function getInitialsFromParts(
  firstName?: string | null,
  lastName?: string | null,
  fallback = '?'
): string {
  const initials = `${firstName?.[0] ?? ''}${lastName?.[0] ?? ''}`.toUpperCase();
  return initials || fallback;
}
