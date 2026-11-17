/**
 * Minimal in-memory stand-in for the supabase-js query builder, for unit tests.
 *
 * Supports: from(t).select/insert/upsert/update/delete with eq/neq/in/is/not/gte/lte/lt/gt/ilike
 * filters, order/limit, and single()/maybeSingle(); update/insert/delete + select() return the
 * affected rows. Unique constraints can be declared per table to exercise 23505 paths.
 * Intentionally small: it models the subset our code uses, nothing more.
 */
type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export interface FakeOpts {
  /** table -> list of column sets that must be unique (violations return code 23505). */
  unique?: Record<string, string[][]>;
  /** table -> partial-unique predicates: at most one row may satisfy `where`. */
  uniqueWhere?: Record<string, ((r: Row) => boolean)[]>;
  /** RPC stubs: name -> handler returning the data. */
  rpc?: Record<string, (args: Record<string, unknown>) => unknown>;
  /** Hook to observe every write: (op, table, rows). */
  onWrite?: (op: string, table: string, rows: Row[]) => void;
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  constructor(seed: Record<string, Row[]> = {}, public opts: FakeOpts = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables[t] = rows.map((r) => ({ ...r }));
  }
  rows(t: string): Row[] { return (this.tables[t] ??= []); }
  from(table: string) { return new Query(this, table); }
  rpc(name: string, args: Record<string, unknown> = {}) {
    const h = this.opts.rpc?.[name];
    return Promise.resolve(h ? { data: h(args), error: null } : { data: null, error: { message: `no rpc stub ${name}` } });
  }
}

class Query implements PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row | Row[] | null = null;
  private onConflict: string[] | null = null;
  private wantRows = false;
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private mode: "many" | "single" | "maybe" = "many";
  constructor(private db: FakeSupabase, private table: string) {}

  private wantCount = false;
  select(_cols?: string, o?: { count?: string; head?: boolean }) { if (this.op !== "select") this.wantRows = true; if (o?.count) this.wantCount = true; return this; }
  insert(p: Row | Row[]) { this.op = "insert"; this.payload = p; return this; }
  upsert(p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = "upsert"; this.payload = p; this.onConflict = o?.onConflict?.split(",").map((s) => s.trim()) ?? null; return this;
  }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: unknown) {
    // PostgREST JSON path, e.g. "metadata->>call_sid"
    const j = c.split("->>");
    if (j.length === 2) this.filters.push((r) => ((r[j[0]] as Record<string, unknown> | null) ?? {})[j[1]] === v);
    else this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, op: string, v: unknown) { if (op === "is") this.filters.push((r) => (r[c] ?? null) !== v); return this; }
  gte(c: string, v: unknown) { this.filters.push((r) => (r[c] as string) >= (v as string)); return this; }
  gt(c: string, v: unknown) { this.filters.push((r) => (r[c] as string) > (v as string)); return this; }
  lte(c: string, v: unknown) { this.filters.push((r) => (r[c] as string) <= (v as string)); return this; }
  lt(c: string, v: unknown) { this.filters.push((r) => (r[c] as string) < (v as string)); return this; }
  ilike(c: string, v: string) {
    // SQL ILIKE: % is a wildcard, everything else literal, case-insensitive.
    const re = new RegExp("^" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
    this.filters.push((r) => re.test(String(r[c] ?? "")));
    return this;
  }
  like(c: string, v: string) {
    // SQL LIKE: % wildcard, case-sensitive.
    const re = new RegExp("^" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$");
    this.filters.push((r) => re.test(String(r[c] ?? "")));
    return this;
  }
  contains(c: string, v: Record<string, unknown>) {
    // jsonb @> for a flat object: every key/value in v is present on the column.
    this.filters.push((r) => {
      const col = (r[c] ?? {}) as Record<string, unknown>;
      return Object.entries(v).every(([k, val]) => col[k] === val);
    });
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  range(a: number, b: number) { this.max = b - a + 1; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }

  private violates(row: Row, others: Row[]): boolean {
    for (const cols of this.db.opts.unique?.[this.table] ?? []) {
      if (others.some((o) => o !== row && cols.every((c) => o[c] === row[c] && row[c] !== undefined))) return true;
    }
    for (const pred of this.db.opts.uniqueWhere?.[this.table] ?? []) {
      if (pred(row) && others.some((o) => o !== row && pred(o))) return true;
    }
    return false;
  }

  private exec(): { data: unknown; error: { code?: string; message: string } | null } {
    const all = this.db.rows(this.table);
    let affected: Row[] = [];
    if (this.op === "insert" || this.op === "upsert") {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      for (const item of items) {
        const row = { ...item };
        if (row.id === undefined) row.id = crypto.randomUUID(); // DB default gen_random_uuid()
        if (this.op === "upsert" && this.onConflict) {
          const existing = all.find((o) => this.onConflict!.every((c) => o[c] === row[c]));
          if (existing) { Object.assign(existing, row); affected.push(existing); continue; }
        }
        all.push(row);
        if (this.violates(row, all)) {
          all.pop();
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        affected.push(row);
      }
      this.db.opts.onWrite?.(this.op, this.table, affected);
    } else if (this.op === "update") {
      affected = all.filter((r) => this.filters.every((f) => f(r)));
      for (const r of affected) Object.assign(r, this.payload);
      this.db.opts.onWrite?.("update", this.table, affected);
    } else if (this.op === "delete") {
      affected = all.filter((r) => this.filters.every((f) => f(r)));
      this.db.tables[this.table] = all.filter((r) => !affected.includes(r));
      this.db.opts.onWrite?.("delete", this.table, affected);
    } else {
      affected = all.filter((r) => this.filters.every((f) => f(r)));
    }

    if (this.op !== "select" && !this.wantRows) return { data: null, error: null };
    let out = affected.map((r) => ({ ...r }));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out.sort((a, b) => ((a[col] as string) > (b[col] as string) ? 1 : (a[col] as string) < (b[col] as string) ? -1 : 0) * (asc ? 1 : -1));
    }
    if (this.max !== null) out = out.slice(0, this.max);
    if (this.wantCount) return { data: null, error: null, count: affected.length } as never;
    if (this.mode === "many") return { data: out, error: null };
    if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
    return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no rows" } };
  }

  // deno-lint-ignore no-explicit-any
  then<T1 = any, T2 = never>(res?: ((v: any) => T1 | PromiseLike<T1>) | null, rej?: ((e: unknown) => T2 | PromiseLike<T2>) | null): PromiseLike<T1 | T2> {
    return Promise.resolve(this.exec()).then(res, rej);
  }
}

/** Cast helper: the fake satisfies the subset of SupabaseClient our modules call. */
// deno-lint-ignore no-explicit-any
export const asClient = (f: FakeSupabase) => f as any;
