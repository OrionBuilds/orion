import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';

/**
 * Table primitives.
 *
 * 68 files hand-roll a `<table>`, with at least eight competing header styles --
 * the two most common differ only in whether padding is written before or after
 * the text utilities, and roughly 30 headers still use the legacy `text-hud-cream-mute`.
 *
 * These are deliberately styling primitives rather than a configurable
 * `<DataTable columns={...} />`. Of those 68 files, 11 sort, 16 select and 20
 * paginate, but only ONE does all three -- the population is mostly plain display
 * tables, so a single configured component would force 68 call sites through a
 * schema built for the one outlier. Primitives kill the style drift without
 * taking the markup away from the page.
 */

export function Table({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  // Wrapper owns the horizontal scroll so a wide table never pushes the page sideways.
  return (
    <div className="overflow-x-auto">
      <table className={`w-full ${className}`}>{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="border-b border-hud-bg-elev">
      <tr>{children}</tr>
    </thead>
  );
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-hud-bg-card">{children}</tbody>;
}

export function TR({
  children,
  onClick,
  className = '',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      className={`${onClick ? 'cursor-pointer hover:bg-hud-bg-card/50 transition-colors' : ''} ${className}`}
    >
      {children}
    </tr>
  );
}

const TH_BASE =
  'text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider px-4 py-3 whitespace-nowrap';

export function TH({
  children,
  className = '',
  align = 'left',
}: {
  children?: React.ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
}) {
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : '';
  return <th className={`${TH_BASE} ${alignCls} ${className}`}>{children}</th>;
}

/**
 * Header cell that toggles sort. `direction` is null when this column is not the
 * active sort, which is what drives the neutral up/down affordance.
 */
export function SortableTH<T extends string>({
  children,
  field,
  activeField,
  direction,
  onSort,
  align = 'left',
}: {
  children: React.ReactNode;
  field: T;
  activeField: T | null;
  direction: 'asc' | 'desc' | null;
  onSort: (field: T) => void;
  align?: 'left' | 'right' | 'center';
}) {
  const isActive = activeField === field;
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : '';

  return (
    <th className={`${TH_BASE} ${alignCls}`}>
      <button
        type="button"
        onClick={() => onSort(field)}
        aria-label={`Sort by ${typeof children === 'string' ? children : field}`}
        className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors ${
          isActive ? 'text-white' : 'hover:text-hud-cream-soft'
        }`}
      >
        {children}
        {!isActive && <ChevronsUpDown className="w-3 h-3 opacity-50" />}
        {isActive && direction === 'asc' && <ChevronUp className="w-3 h-3" />}
        {isActive && direction === 'desc' && <ChevronDown className="w-3 h-3" />}
      </button>
    </th>
  );
}

export function TD({
  children,
  className = '',
  align = 'left',
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
  colSpan?: number;
}) {
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : '';
  return (
    <td colSpan={colSpan} className={`px-4 py-3 text-sm text-hud-cream-soft ${alignCls} ${className}`}>
      {children}
    </td>
  );
}

/** Full-width empty state that spans the table. */
export function TableEmpty({
  colSpan,
  children,
}: {
  colSpan: number;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-hud-cream-mute">
        {children}
      </td>
    </tr>
  );
}
