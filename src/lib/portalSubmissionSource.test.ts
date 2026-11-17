// Guard: the client-portal edge function inserts change requests and support tickets with a
// hard-coded `source`, and each table CHECKs that column. A value outside the CHECK fails every
// submission with a bare 500 — which is what happened to change requests from 2026-08-24 to
// 2026-09-14 ('portal' was written into project_change_requests, whose CHECK has no 'portal').
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const edge = readFileSync(join(ROOT, 'supabase/functions/client-portal-auth/index.ts'), 'utf8');
const migrations = readdirSync(join(ROOT, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8'))
  .join('\n');

/** The `source:` value in the edge function's insert into `table`. */
function insertedSource(table: string): string {
  const start = edge.indexOf(`from("${table}").insert(`);
  expect(start, `no insert into ${table} found`).toBeGreaterThan(-1);
  const m = /source:\s*"([^"]+)"/.exec(edge.slice(start, start + 2000));
  expect(m, `no source: in the ${table} insert`).not.toBeNull();
  return m![1];
}

const SOURCE_CHECK = /CHECK\s*\(+\s*source\s*(?:IN\s*\(([^)]*)\)|=\s*ANY\s*\(\s*ARRAY\s*\[([^\]]*)\]\s*\))/i;

/** Allowed values from the LAST source CHECK for `table`, scoped to that table only: the inline
 *  CHECK inside its CREATE TABLE block, or a later `<table>_source_check` constraint. */
function allowedSources(table: string): string[] {
  const found: { at: number; list: string }[] = [];
  for (const m of migrations.matchAll(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?(?:public\\.)?${table}\\s*\\(`, 'gi'))) {
    const body = migrations.slice(m.index!, migrations.indexOf('\n);', m.index!));
    const c = SOURCE_CHECK.exec(body);
    if (c) found.push({ at: m.index!, list: c[1] ?? c[2] });
  }
  for (const m of migrations.matchAll(new RegExp(`${table}_source_check\\s+CHECK`, 'gi'))) {
    const c = SOURCE_CHECK.exec(migrations.slice(m.index!, m.index! + 400));
    if (c) found.push({ at: m.index!, list: c[1] ?? c[2] });
  }
  expect(found.length, `no source CHECK for ${table}`).toBeGreaterThan(0);
  const last = found.sort((a, b) => a.at - b.at)[found.length - 1].list;
  return [...last.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('client-portal-auth submission source values satisfy the table CHECKs', () => {
  for (const table of ['project_change_requests', 'project_support_tickets']) {
    it(table, () => {
      expect(allowedSources(table)).toContain(insertedSource(table));
    });
  }
});
