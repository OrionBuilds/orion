/** The rows of one register: chosen columns, DueBadge dates, client-visible marker, sorting, pagination. Row click opens the drawer. */
import { Eye, EyeOff } from 'lucide-react';
import { Table, THead, TH, SortableTH, TBody, TD } from '../ui/Table';
import { Badge } from '../ui/Badge';
import { DueBadge } from './ui';
import type { CaioRecord, RegisterField } from '../../services/caio';
import { truncate, type SortDir, type SortKey } from './registerView';

interface Props {
  columns: RegisterField[];
  rows: CaioRecord[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  onOpen: (record: CaioRecord) => void;
}

export function RegisterTable({ columns, rows, sortKey, sortDir, onSort, onOpen }: Props) {
  return (
    <Table>
      <THead>
        <SortableTH<SortKey> field="record_key" activeField={sortKey} direction={sortKey === 'record_key' ? sortDir : null} onSort={onSort}>Key</SortableTH>
        {columns.map((c) => c.is_due
          ? <SortableTH<SortKey> key={c.field_key} field="due_date" activeField={sortKey} direction={sortKey === 'due_date' ? sortDir : null} onSort={onSort}>{c.label}</SortableTH>
          : <TH key={c.field_key}>{c.label}</TH>)}
        <TH>Client</TH>
      </THead>
      <TBody>
        {rows.map((r) => (
          <tr key={r.id} tabIndex={0} onClick={() => onOpen(r)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r); } }}
            className="cursor-pointer transition-colors hover:bg-hud-bg-card/50 focus:bg-hud-bg-card/50 focus:outline-none">
            <TD className="whitespace-nowrap font-mono text-xs text-white">{r.record_key}</TD>
            {columns.map((c) => {
              const v = r.data?.[c.field_key];
              const s = v === undefined || v === null ? '' : String(v);
              return (
                <TD key={c.field_key} className={c.ftype === 'longtext' || c.ftype === 'text' ? 'min-w-[12rem] max-w-md' : 'whitespace-nowrap'}>
                  {c.is_due ? <DueBadge date={s || null} /> : s ? <span title={s.length > 80 ? s : undefined}>{truncate(s)}</span> : <span className="text-hud-cream-mute">–</span>}
                </TD>
              );
            })}
            <TD className="whitespace-nowrap">
              {r.client_visible
                ? <Badge tone="accent"><Eye className="h-3 w-3" aria-hidden="true" />Visible</Badge>
                : <span className="inline-flex items-center gap-1 text-hud-cream-mute"><EyeOff className="h-3.5 w-3.5" aria-hidden="true" /><span className="sr-only">Hidden from client</span></span>}
            </TD>
          </tr>
        ))}
      </TBody>
    </Table>
  );
}
export default RegisterTable;
