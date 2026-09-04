/**
 * `size-limit` / `gate:size-limit` — SD §QD-4 PR row ("`size-limit` per route")
 * and SD §PERF "Per-route JS budgets (enforced, not aspirational)".
 *
 * Two jobs, because at T-001 there are no built bundles yet and a gate that
 * silently measures nothing is the failure mode platform-infrastructure.md
 * names first:
 *
 *   1. CONFIG — .size-limit.json must carry every route group in the SD table,
 *      each marked gzip, each at or under the SD ceiling. Raising a budget in
 *      the config therefore fails the gate; changing the product's budget is a
 *      specification change, not a config edit.
 *   2. MEASUREMENT — for every entry whose path actually resolves to a built
 *      file, run size-limit for real. Today that is zero entries and the gate
 *      SAYS SO on stdout, loudly, with the ticket that will supply them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, bin, stream, finish } from './lib/run.ts';

/** SD §PERF "Per-route JS budgets". The ceiling; config may be lower, never higher. */
const SD_CEILING_KB: ReadonlyMap<string, number> = new Map([
  ['(public)', 0],
  ['/p/search', 45],
  ['/p/sitters/[id]', 45],
  ['/p/book/*', 90],
  ['/p/book/[draftId]/pay', 180],
  ['/s/inbox', 70],
  ['/s/availability', 130],
  ['/session/[id]', 150],
  ['Shared app shell', 60],
]);

interface Entry {
  readonly name?: unknown;
  readonly path?: unknown;
  readonly limit?: unknown;
  readonly gzip?: unknown;
}

const failures: string[] = [];
const CONFIG = path.join(REPO_ROOT, '.size-limit.json');

if (!fs.existsSync(CONFIG)) {
  finish('gate:size-limit', ['.size-limit.json is missing']);
}

let parsed: unknown;
try {
  parsed = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
} catch (err: unknown) {
  finish('gate:size-limit', [`.size-limit.json does not parse: ${String(err)}`]);
}

if (!Array.isArray(parsed) || parsed.length === 0) {
  finish('gate:size-limit', ['.size-limit.json must be a non-empty array']);
}

const entries = parsed as readonly Entry[];

/** "45 KB" -> 45. Only KB is accepted; a bare number or MB is a config error. */
function limitKb(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*KB\s*$/i.exec(raw);
  if (m === null) return null;
  const n = m[1];
  if (n === undefined) return null;
  return Number.parseFloat(n);
}

const seen = new Set<string>();
console.log('CONFIG CHECK — .size-limit.json against SD §PERF per-route budgets\n');

for (const [i, e] of entries.entries()) {
  const where = `entry ${String(i)}`;
  const name = e.name;
  if (typeof name !== 'string' || name === '') {
    failures.push(`${where}: missing "name"`);
    continue;
  }
  if (seen.has(name)) failures.push(`${where}: duplicate route group "${name}"`);
  seen.add(name);

  if (typeof e.path !== 'string' && !Array.isArray(e.path)) {
    failures.push(`"${name}": missing "path"`);
  }
  if (e.gzip !== true) {
    failures.push(`"${name}": must set "gzip": true — SD budgets are compressed sizes`);
  }

  const kb = limitKb(e.limit);
  if (kb === null) {
    failures.push(`"${name}": "limit" must be a string like "45 KB" (got ${JSON.stringify(e.limit)})`);
    continue;
  }
  const ceiling = SD_CEILING_KB.get(name);
  if (ceiling === undefined) {
    console.log(`  ?  ${name.padEnd(24)} ${String(kb).padStart(4)} KB   (not in the SD table — allowed, but unbudgeted by the spec)`);
    continue;
  }
  if (kb > ceiling) {
    failures.push(
      `"${name}": budget ${String(kb)} KB exceeds the SD §PERF ceiling of ${String(ceiling)} KB. ` +
        'Raising a product budget is a specification change, not a config edit.',
    );
    console.log(`  X  ${name.padEnd(24)} ${String(kb).padStart(4)} KB  > SD ${String(ceiling)} KB`);
  } else {
    console.log(`  ok ${name.padEnd(24)} ${String(kb).padStart(4)} KB  <= SD ${String(ceiling)} KB`);
  }
}

for (const required of SD_CEILING_KB.keys()) {
  if (!seen.has(required)) {
    failures.push(`SD §PERF budgets "${required}" but .size-limit.json has no entry for it`);
  }
}

/** A path glob is measurable only if at least one file it names exists. */
function resolves(p: unknown): boolean {
  const globs = typeof p === 'string' ? [p] : Array.isArray(p) ? p : [];
  for (const g of globs) {
    if (typeof g !== 'string') continue;
    const literal = g.split('*')[0] ?? '';
    const base = literal.endsWith('/') ? literal.slice(0, -1) : path.dirname(literal);
    const candidate = path.join(REPO_ROOT, g.includes('*') ? base : g);
    if (fs.existsSync(candidate)) return true;
  }
  return false;
}

const measurable = entries.filter((e) => resolves(e.path));
console.log(
  `\nMEASUREMENT — ${String(measurable.length)} of ${String(entries.length)} entries resolve to files on disk`,
);

if (measurable.length === 0) {
  console.log(
    '  No built bundles exist yet. apps/web is a placeholder (T-001 scaffolds topology only);\n' +
      '  EP-4 / T-006 build the routes and this section starts measuring them. The CONFIG\n' +
      '  half above is live now and is what blocks a budget being raised in the meantime.',
  );
} else {
  console.log('\n$ size-limit');
  const code = stream(bin('size-limit'), []);
  if (code !== 0) failures.push(`size-limit exited ${String(code)} — a budget was exceeded`);
}

finish('gate:size-limit', failures);
