#!/usr/bin/env node
/**
 * Compare deployed Supabase edge functions with this checkout, and (optionally) deploy the ones
 * that drifted. Merging to main ships the frontend (Netlify) but NOT edge functions, so production
 * functions silently fall behind main. This finds and fixes that.
 *
 * For each function it downloads the deployed source into a temp dir (read-only: nothing downloaded
 * is executed), walks the repo's relative-import graph from supabase/functions/<slug>/index.ts, and
 * compares file by file. It also compares the deployed verify_jwt with supabase/config.toml.
 *
 * Usage:
 *   node scripts/deploy-changed-functions.mjs <slug>...       # report drift for these functions
 *   node scripts/deploy-changed-functions.mjs --all           # every function, plus orphans
 *   node scripts/deploy-changed-functions.mjs <slug>... --deploy [--yes]
 *
 * --deploy only runs from a clean tree whose HEAD equals origin/main and that passes
 * scripts/security/check-repo.sh, asks before deploying (unless --yes), and never deletes orphans.
 * Env: SUPABASE_PROJECT_REF (required). Needs a logged-in supabase CLI.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTIONS = join(ROOT, "supabase", "functions");
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
if (!PROJECT_REF) throw new Error("Set SUPABASE_PROJECT_REF to your Supabase project ref");
const CONCURRENCY = 4;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const slugsArg = args.filter((a) => !a.startsWith("--"));
const ALL = flags.has("--all");
const DEPLOY = flags.has("--deploy");
const YES = flags.has("--yes");

if (!ALL && slugsArg.length === 0) {
  console.error("usage: deploy-changed-functions.mjs (<slug>... | --all) [--deploy] [--yes]");
  process.exit(2);
}

function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

function shAsync(cmd, argv, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => (code === 0 ? res(out) : rej(new Error(out.trim().split("\n").pop()))));
  });
}

/**
 * Relative-import closure of a function, as paths relative to supabase/functions. Type-only
 * imports (`import type …`) are skipped: they are erased at bundle time, so the deployed
 * source never contains those files.
 */
function importClosure(entry) {
  const seen = new Set();
  const stack = [entry];
  const spec = /(import|export)(\s+type)?\s[^"']*?from\s*["'](\.{1,2}\/[^"']+)["']|import\s*["'](\.{1,2}\/[^"']+)["']/g;
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(spec)) {
      if (m[2]) continue;
      stack.push(resolve(dirname(file), m[3] ?? m[4]));
    }
  }
  return [...seen].map((f) => relative(FUNCTIONS, f)).sort();
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

/** verify_jwt per function from supabase/config.toml (Supabase defaults to true when unset). */
function configVerifyJwt() {
  const map = new Map();
  let current = null;
  for (const line of readFileSync(join(ROOT, "supabase", "config.toml"), "utf8").split("\n")) {
    const section = line.match(/^\[functions\.([^\]]+)\]/);
    if (section) { current = section[1]; continue; }
    if (/^\[/.test(line)) { current = null; continue; }
    const v = line.match(/^\s*verify_jwt\s*=\s*(true|false)/);
    if (current && v) map.set(current, v[1] === "true");
  }
  return map;
}

async function compare(slug, deployed, verifyJwt) {
  const entry = join(FUNCTIONS, slug, "index.ts");
  if (!existsSync(entry)) return { slug, status: "ORPHAN", detail: "deployed, not in repo" };
  const meta = deployed.get(slug);
  if (!meta) return { slug, status: "NOT_DEPLOYED", detail: "in repo, never deployed" };

  const tmp = mkdtempSync(join(tmpdir(), `fn-${slug}-`));
  try {
    await shAsync("supabase", ["functions", "download", slug, "--project-ref", PROJECT_REF, "--use-api"], { cwd: tmp });
    const live = join(tmp, "supabase", "functions");
    const liveFiles = new Set(listFiles(live).map((f) => relative(live, f)));
    const repoFiles = importClosure(entry);
    const changed = [];
    for (const f of repoFiles) {
      if (!liveFiles.has(f)) changed.push(`+ ${f}`);
      // Line endings don't count: the Linux box's checkout came over from Windows and deploys CRLF copies
      // of otherwise identical files.
      else if (readFileSync(join(FUNCTIONS, f), "utf8").replace(/\r\n/g, "\n") !== readFileSync(join(live, f), "utf8").replace(/\r\n/g, "\n")) changed.push(`~ ${f}`);
    }
    for (const f of liveFiles) if (!repoFiles.includes(f)) changed.push(`- ${f}`);
    const wantJwt = verifyJwt.get(slug) ?? true;
    if (meta.verify_jwt !== wantJwt) changed.push(`! verify_jwt live=${meta.verify_jwt} config=${wantJwt}`);
    return changed.length
      ? { slug, status: "DRIFT", detail: `v${meta.version}, ${new Date(meta.updated_at).toISOString().slice(0, 10)}`, changed }
      : { slug, status: "IN_SYNC", detail: `v${meta.version}` };
  } catch (e) {
    return { slug, status: "ERROR", detail: e.message };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function pool(items, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const item = items[i++]; out.push(await fn(item)); }
  }));
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function assertDeployable() {
  if (sh("git", ["status", "--porcelain"], { cwd: ROOT }).trim()) throw new Error("working tree is not clean; deploy only committed code");
  sh("git", ["fetch", "-q", "origin", "main"], { cwd: ROOT });
  const head = sh("git", ["rev-parse", "HEAD"], { cwd: ROOT }).trim();
  const main = sh("git", ["rev-parse", "origin/main"], { cwd: ROOT }).trim();
  if (head !== main) throw new Error(`HEAD (${head.slice(0, 7)}) is not origin/main (${main.slice(0, 7)}); deploy only what is on main`);
  // Refuse to deploy code that shows supply-chain worm warning signs (throws on a non-zero exit).
  sh("bash", [join(ROOT, "scripts", "security", "check-repo.sh"), "HEAD"], { cwd: ROOT });
  return head.slice(0, 7);
}

const deployed = new Map(
  JSON.parse(sh("supabase", ["functions", "list", "--project-ref", PROJECT_REF, "-o", "json"])).map((f) => [f.slug, f]),
);
const repoSlugs = readdirSync(FUNCTIONS).filter((d) => !d.startsWith("_") && existsSync(join(FUNCTIONS, d, "index.ts")));
const slugs = ALL ? [...new Set([...repoSlugs, ...deployed.keys()])] : slugsArg;

const verifyJwt = configVerifyJwt();
const results = await pool(slugs, (s) => compare(s, deployed, verifyJwt));
for (const r of results) {
  console.log(`${r.status.padEnd(12)} ${r.slug}  (${r.detail})`);
  for (const c of r.changed ?? []) console.log(`               ${c}`);
}
const counts = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
console.log(`\n${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join("  ")}`);

if (!DEPLOY) process.exit(0);

const drifted = results.filter((r) => r.status === "DRIFT" || r.status === "NOT_DEPLOYED").map((r) => r.slug);
if (drifted.length === 0) { console.log("Nothing to deploy."); process.exit(0); }
const sha = assertDeployable();
if (!YES) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Deploy ${drifted.length} function(s) from ${sha} to ${PROJECT_REF}? [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== "y") { console.log("Aborted."); process.exit(1); }
}
for (const slug of drifted) {
  process.stdout.write(`deploying ${slug} ... `);
  sh("supabase", ["functions", "deploy", slug, "--project-ref", PROJECT_REF, "--use-api"], { cwd: ROOT });
  console.log("ok");
}
