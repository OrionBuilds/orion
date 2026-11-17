/** Pure view helpers for the CAIO registers UI (column choice, filtering, sorting, history diffs). Unit-tested in registerView.test.ts. */
import type { CaioRecord, RecordHistory, RegisterDef, RegisterField } from '../../services/caio';

export const MAX_TABLE_FIELDS = 5;
export const PAGE_SIZE = 50;

/**
 * The fields shown in the table after the record key: the first non-ID text/longtext field (name, title, scenario...),
 * then the promoted status, risk tier, owner and the due-date column when the register has them. Capped at 5.
 */
export function pickColumns(def: Pick<RegisterDef, 'fields'>): RegisterField[] {
  const out: RegisterField[] = [];
  const add = (f: RegisterField | undefined) => { if (f && !out.includes(f) && out.length < MAX_TABLE_FIELDS) out.push(f); };
  add(def.fields.find((f) => !f.is_id && (f.ftype === 'text' || f.ftype === 'longtext') && !f.promote_as));
  for (const p of ['status', 'risk_tier', 'owner'] as const) add(def.fields.find((f) => f.promote_as === p));
  add(def.fields.find((f) => f.is_due));
  return out;
}

export function truncate(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function isUrl(v: unknown): v is string {
  return typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());
}

/** Link-like fields: URLs are clickable in read mode. */
export function isLinkField(f: Pick<RegisterField, 'field_key' | 'label'>): boolean {
  return /link|url|evidence|reference|ref\b|source|location|doc/i.test(`${f.field_key} ${f.label}`);
}

export interface RecordFilters {
  search: string;
  status: string;
  owner: string;
  overdueOnly: boolean;
  clientOnly: boolean;
}
export const NO_FILTERS: RecordFilters = { search: '', status: '', owner: '', overdueOnly: false, clientOnly: false };

export function filtersActive(f: RecordFilters): boolean {
  return !!(f.search.trim() || f.status || f.owner || f.overdueOnly || f.clientOnly);
}

/** Distinct non-empty values of a promoted column, sorted, for the filter dropdowns. */
export function distinctValues(records: Pick<CaioRecord, 'status' | 'owner_name'>[], key: 'status' | 'owner_name'): string[] {
  return [...new Set(records.map((r) => r[key]).filter((v): v is string => !!v && v.trim() !== ''))].sort((a, b) => a.localeCompare(b));
}

/** `today` is an ISO date (yyyy-mm-dd); overdue = due_date strictly before it. */
export function filterRecords(records: CaioRecord[], f: RecordFilters, today: string): CaioRecord[] {
  const q = f.search.trim().toLowerCase();
  return records.filter((r) => {
    if (f.status && r.status !== f.status) return false;
    if (f.owner && r.owner_name !== f.owner) return false;
    if (f.overdueOnly && !(r.due_date && r.due_date.slice(0, 10) < today)) return false;
    if (f.clientOnly && !r.client_visible) return false;
    if (q) {
      const hay = [r.record_key, ...Object.values(r.data ?? {}).map(String)].join('\n').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export type SortKey = 'record_key' | 'due_date';
export type SortDir = 'asc' | 'desc';

/** Record keys sort by prefix then number (RSK-0002 before RSK-0010). Empty due dates always go last. */
export function sortRecords(records: CaioRecord[], key: SortKey, dir: SortDir): CaioRecord[] {
  const sign = dir === 'asc' ? 1 : -1;
  const out = [...records];
  out.sort((a, b) => {
    if (key === 'due_date') {
      const x = a.due_date?.slice(0, 10) ?? '';
      const y = b.due_date?.slice(0, 10) ?? '';
      if (!x && !y) return a.record_key.localeCompare(b.record_key, undefined, { numeric: true });
      if (!x) return 1;
      if (!y) return -1;
      return x === y ? a.record_key.localeCompare(b.record_key, undefined, { numeric: true }) : (x < y ? -sign : sign);
    }
    return sign * a.record_key.localeCompare(b.record_key, undefined, { numeric: true });
  });
  return out;
}

export function pageSlice<T>(rows: T[], page: number, size = PAGE_SIZE): T[] {
  return rows.slice(page * size, page * size + size);
}

export function pageCount(total: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

export interface FieldChange { key: string; label: string; from: string; to: string }

const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '(empty)' : String(v));

/** What one history entry changed, per field (old -> new). The internal _client_visible key reads as "client visibility". */
export function historyChanges(def: Pick<RegisterDef, 'fields'>, h: Pick<RecordHistory, 'op' | 'old_data' | 'new_data'>): FieldChange[] {
  const oldD = h.old_data ?? {};
  const newD = h.op === 'delete' ? {} : (h.new_data ?? {});
  const label = (k: string) => (k === '_client_visible' ? 'Client visibility' : def.fields.find((f) => f.field_key === k)?.label ?? k);
  const fmt = (k: string, v: unknown) =>
    k === '_client_visible' ? (v === true || v === 'true' ? 'visible' : v === undefined || v === null ? '(empty)' : 'hidden') : show(v);
  const order = def.fields.map((f) => f.field_key);
  const keys = [...new Set([...Object.keys(oldD), ...Object.keys(newD)])]
    .sort((a, b) => (order.indexOf(a) < 0 ? 999 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 999 : order.indexOf(b)));
  const out: FieldChange[] = [];
  for (const k of keys) {
    if (k.startsWith('_') && k !== '_client_visible') continue;
    const a = (oldD as Record<string, unknown>)[k];
    const b = (newD as Record<string, unknown>)[k];
    if (h.op !== 'delete' && String(a ?? '') === String(b ?? '')) continue;
    out.push({ key: k, label: label(k), from: fmt(k, a), to: fmt(k, b) });
  }
  return out;
}

/** Download file name: <engagement_code>-<register_key>-<yyyy-mm-dd>.csv */
export function exportFileName(engagementCode: string, registerKey: string, today: string): string {
  return `${engagementCode}-${registerKey}-${today}.csv`.replace(/[^A-Za-z0-9._-]+/g, '_');
}
