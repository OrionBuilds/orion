// supabase-js adapter for the CRUD runner's CrudDb interface.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { CrudDb, DbResult } from "../_shared/system-health/crud-runner.ts";
import type { Row } from "../_shared/system-health/crud-registry.ts";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function err(e: { message: string; code?: string } | null) {
  return e ? { message: e.message, code: e.code } : null;
}

export function supabaseCrudDb(client: SupabaseClient): CrudDb {
  return {
    async insert(table, row): Promise<DbResult<Row>> {
      const { data, error } = await client.from(table).insert(row).select("*").single();
      return { data: (data as Row) ?? null, error: err(error) };
    },
    async selectById(table, id): Promise<DbResult<Row>> {
      const { data, error } = await client.from(table).select("*").eq("id", id).maybeSingle();
      return { data: (data as Row) ?? null, error: err(error) };
    },
    async updateById(table, id, patch): Promise<DbResult<Row>> {
      const { data, error } = await client.from(table).update(patch).eq("id", id).select("*");
      const rows = (data as Row[] | null) ?? [];
      return { data: rows[0] ?? null, error: err(error) };
    },
    async deleteById(table, id): Promise<DbResult<number>> {
      const { data, error } = await client.from(table).delete().eq("id", id).select("id");
      return { data: ((data as unknown[] | null) ?? []).length, error: err(error) };
    },
    async list(table, columns, orgColumn, orgId, limit): Promise<DbResult<Row[]>> {
      let q = client.from(table).select(columns).limit(limit);
      if (orgColumn) q = q.eq(orgColumn, orgId);
      const { data, error } = await q;
      return { data: (data as unknown as Row[]) ?? null, error: err(error) };
    },
    async deleteTagged(table, orgColumn, orgId, tagColumn, prefix, createdBefore, createdColumn): Promise<DbResult<number>> {
      let q = client.from(table).delete().like(tagColumn, `${escapeLike(prefix)}%`);
      if (orgColumn) q = q.eq(orgColumn, orgId);
      if (createdBefore) q = q.lt(createdColumn ?? "created_at", createdBefore);
      const { data, error } = await q.select("id");
      return { data: ((data as unknown[] | null) ?? []).length, error: err(error) };
    },
  };
}
