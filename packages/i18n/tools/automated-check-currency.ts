/**
 * The automated-check half of `gate:safety-review-currency` — T-264 (OE-82;
 * `state/EP-0/OE-82-cut.md` §3 `T-264`).
 *
 * Under stakeholder ruling OE-5 no human reviews safety copy, and under OE-82
 * the two checks SA §TS-12.4 asked a person to make — the read-aloud pass and
 * the in-context 360 px review — are made by gates instead: `gate:read-aloud`
 * (T-263) writes `checks/read-aloud.json`, `gate:safety-copy-render` (T-265)
 * writes `checks/render-360.json`. Those PRODUCER gates re-derive their records
 * and refuse drift. THIS module is the CURRENCY side: it reads only the
 * committed records, against the register's `content_hash` and the gate's
 * `AUTHORED_CONTENT_PINNED`, and refuses a pair at the terminal status
 * (`unreviewed_by_ruling`) whose check is absent, stale, failed or made by
 * anything but the automation literal. A hand-edited record is the producer's
 * to catch (`RECORD-DRIFT`); a deleted or stale one is caught here. The two
 * read different things (PROTOCOL §5.1).
 *
 * Every function takes the pins as an ARGUMENT. The gate passes the literals
 * from `tools/automated-checks.ts`; `tools/safety-review-currency.test.ts`
 * passes mutated copies, which is how a pin mutation (a key removed from
 * `AWAITING_SURFACE`, an empty ticket id) is falsified continuously rather
 * than only by the NEG suite. Nothing here reads a pin from `review.json`.
 *
 * A BUILD-TIME module under `tools/`, outside `package.json` `exports`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The pins this module applies. The gate passes `tools/automated-checks.ts`'s literals. */
export interface AutomatedCheckPins {
  /** key -> channel: every key whose channel is not `screen` (T-263's READ_ALOUD_KEYS_PINNED). */
  readonly readAloudKeys: Readonly<Record<string, string>>;
  /** key -> channel: every key whose channel is not `voice` (RENDER_KEYS_PINNED). */
  readonly renderKeys: Readonly<Record<string, string>>;
  /** key -> owning surface ticket (AWAITING_SURFACE). */
  readonly awaiting: Readonly<Record<string, string>>;
  /** The `tool` a read-aloud record must carry: `espeak-ng <CHECK_TOOLS['espeak-ng']>`. */
  readonly readAloudTool: string;
  /** The `checked_by` literal of `checks/read-aloud.json`. */
  readonly readAloudCheckedBy: string;
  /** The `checked_by` literal of `checks/render-360.json`. */
  readonly renderCheckedBy: string;
}

type Rec = Readonly<Record<string, unknown>>;
/** `records[locale][key]`, as committed. A record that is not an object is kept as-is and read as absent. */
export type CheckRecords = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface CheckFiles {
  readonly readAloud: CheckRecords;
  readonly render: CheckRecords;
}

export const READ_ALOUD_FILE = join('checks', 'read-aloud.json');
export const RENDER_FILE = join('checks', 'render-360.json');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read one record file's `records` block. Absent, not JSON, or with no
 * `records` object is an `INPUT` failure, and the file is then read as holding
 * NO records, so every pair that needs one is also refused below — an
 * unreadable record is a failed build, never an empty pass.
 */
function loadOne(root: string, rel: string, failures: string[]): CheckRecords {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, rel), 'utf8')) as unknown;
  } catch (err) {
    failures.push(
      `INPUT ${rel} is absent, unreadable or not JSON — ${err instanceof Error ? err.message : String(err)}. ` +
        'Every pair that needs a record from it is refused below.',
    );
    return {};
  }
  const records = isRecord(raw) ? raw['records'] : undefined;
  if (!isRecord(records)) {
    failures.push(`INPUT ${rel} has no \`records\` object. Every pair that needs a record from it is refused below.`);
    return {};
  }
  const out: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [locale, perLocale] of Object.entries(records)) {
    out[locale] = isRecord(perLocale) ? perLocale : {};
  }
  return out;
}

export function loadCheckFiles(root: string, failures: string[]): CheckFiles {
  return { readAloud: loadOne(root, READ_ALOUD_FILE, failures), render: loadOne(root, RENDER_FILE, failures) };
}

function recordAt(records: CheckRecords, locale: string, key: string): Rec | undefined {
  const r = records[locale]?.[key];
  return isRecord(r) ? r : undefined;
}

/** Whether a check record names a person: `checked_by` not the literal, or any `review`-named field. */
function humanClaims(record: Rec, checkedBy: string): string[] {
  const claims: string[] = [];
  if (record['checked_by'] !== checkedBy) {
    claims.push(`checked_by is ${record['checked_by'] === undefined ? 'absent' : JSON.stringify(record['checked_by'])}`);
  }
  for (const field of Object.keys(record)) {
    if (/review/iu.test(field)) claims.push(`it carries a field named ${JSON.stringify(field)}`);
  }
  return claims;
}

/* ------------------------------------------------ at ANY status, file-level */

/**
 * The checks that do not depend on a register record's status:
 *   - CLAIMS-HUMAN-CHECK over EVERY record in both files (any locale, any key);
 *   - CHANNEL-DRIFT for both pin sets against `review.json`'s
 *     `pipeline.assignments[*].channel`;
 *   - MALFORMED-AWAITING for an `AWAITING_SURFACE` entry;
 *   - AWAITING-AND-CHECKED for a render record of a key still awaiting.
 */
export function fileLevelProblems(
  pins: AutomatedCheckPins,
  files: CheckFiles,
  assignments: unknown,
  failures: string[],
): void {
  for (const [file, records, literal] of [
    [READ_ALOUD_FILE, files.readAloud, pins.readAloudCheckedBy],
    [RENDER_FILE, files.render, pins.renderCheckedBy],
  ] as const) {
    for (const [locale, perLocale] of Object.entries(records)) {
      for (const [key, r] of Object.entries(perLocale)) {
        if (!isRecord(r)) continue;
        const claims = humanClaims(r, literal);
        if (claims.length === 0) continue;
        failures.push(
          `CLAIMS-HUMAN-CHECK ${file} '${key}' in ${locale}: ${claims.join('; ')}. A check record is ` +
            `made by automation and says so with checked_by "${literal}"; since stakeholder rulings ` +
            'OE-5 and OE-82 no person performs or reviews this check, and nothing may claim one did.',
        );
      }
    }
  }

  channelDrift(pins, assignments, failures);

  for (const [key, ticket] of Object.entries(pins.awaiting)) {
    if (typeof ticket !== 'string' || !/^T-[0-9]+$/u.test(ticket)) {
      failures.push(
        `MALFORMED-AWAITING '${key}': owning ticket is ${JSON.stringify(ticket)}, not a ticket id ` +
          '(T-<n>). A key may wait for a surface only against the named ticket that builds it.',
      );
    }
    if (!Object.hasOwn(pins.renderKeys, key)) {
      failures.push(
        `MALFORMED-AWAITING '${key}': it is not in RENDER_KEYS_PINNED, so there is no render check ` +
          'for it to be awaiting. AWAITING_SURFACE lists only render-applicable keys.',
      );
    }
  }

  for (const [locale, perLocale] of Object.entries(files.render)) {
    for (const key of Object.keys(perLocale)) {
      if (!Object.hasOwn(pins.awaiting, key)) continue;
      failures.push(
        `AWAITING-AND-CHECKED '${key}' in ${locale}: ${RENDER_FILE} holds a record for it, and ` +
          `AWAITING_SURFACE still lists it against ${String(pins.awaiting[key])}. A key is either ` +
          'rendered and checked or awaiting its surface, never both: the surface ticket removes it ' +
          'from AWAITING_SURFACE in the commit that declares the surface.',
      );
    }
  }
}

/**
 * CHANNEL-DRIFT. The read-aloud set is every assignment whose channel is not
 * `screen`; the render set is every assignment whose channel is not `voice`.
 * A missing channel counts into BOTH sets (fail closed). Each set, with its
 * channels, must equal its pin exactly, in both directions. An absent
 * `pipeline.assignments`, and an empty pin, are each refused.
 */
function channelDrift(pins: AutomatedCheckPins, assignments: unknown, failures: string[]): void {
  if (!isRecord(assignments)) {
    failures.push(
      'CHANNEL-DRIFT review.json has no `pipeline.assignments` object, so no key\'s channel can be ' +
        'held against READ_ALOUD_KEYS_PINNED or RENDER_KEYS_PINNED. Fails closed.',
    );
    return;
  }
  const channelOf = (a: unknown): string =>
    isRecord(a) && typeof a['channel'] === 'string' ? a['channel'] : '(none)';
  for (const [pinName, pin, excluded] of [
    ['READ_ALOUD_KEYS_PINNED', pins.readAloudKeys, 'screen'],
    ['RENDER_KEYS_PINNED', pins.renderKeys, 'voice'],
  ] as const) {
    if (Object.keys(pin).length === 0) {
      failures.push(`CHANNEL-DRIFT ${pinName} is empty. An empty pin would check nothing; fails closed.`);
      continue;
    }
    const derived = new Map<string, string>();
    for (const [key, a] of Object.entries(assignments)) {
      const ch = channelOf(a);
      if (ch !== excluded) derived.set(key, ch);
    }
    for (const [key, ch] of derived) {
      if (pin[key] !== ch) {
        failures.push(
          `CHANNEL-DRIFT '${key}': review.json's channel is ${JSON.stringify(ch)}, and ${pinName} ` +
            `${pin[key] === undefined ? 'does not list it' : `pins it as ${JSON.stringify(pin[key])}`}. ` +
            `A channel change moves ${pinName} in tools/automated-checks.ts in the same commit.`,
        );
      }
    }
    for (const key of Object.keys(pin)) {
      if (!derived.has(key)) {
        const a = assignments[key];
        failures.push(
          `CHANNEL-DRIFT '${key}': ${pinName} pins it as ${JSON.stringify(pin[key])}, and review.json ` +
            `${a === undefined ? 'has no assignment for it' : `gives it channel ${JSON.stringify(channelOf(a))}`}. ` +
            `A channel change moves ${pinName} in tools/automated-checks.ts in the same commit.`,
        );
      }
    }
  }
}

/* ------------------------------------------- one pair, at the terminal status */

export interface PairAssessment {
  /** Refusal lines for this pair. The gate prints them only when the register record is terminal. */
  readonly problems: readonly string[];
  /** `null` when the key is not read-aloud pinned; else whether its record is current and passing. */
  readonly readAloudCurrent: boolean | null;
  /** `null` when the key is not render pinned. */
  readonly render: 'checked' | 'awaiting' | 'unchecked' | null;
}

/**
 * Assess one (locale, key) pair against both record files. `entryHash` is the
 * register record's `content_hash`; `pinnedHash` is `AUTHORED_CONTENT_PINNED`
 * for the pair (`undefined` when unpinned, which never matches).
 *
 * Read-aloud (key in readAloudKeys): NO-READ-ALOUD-CHECK when there is no
 * record (or it is not an object); otherwise STALE-READ-ALOUD-CHECK when its
 * `content_hash` differs from `entryHash` or from `pinnedHash`,
 * READ-ALOUD-FAILED when `result` is not `"pass"`, UNPINNED-CHECK-TOOL when
 * `tool` is not `readAloudTool`, each its own line.
 * Render (key in renderKeys): a key in `awaiting` needs nothing here;
 * otherwise NO-RENDER-CHECK, STALE-RENDER-CHECK, RENDER-FAILED, the same way.
 * A record's `checked_by` counts toward "current" in the printed totals; its
 * refusal is CLAIMS-HUMAN-CHECK, in `fileLevelProblems`.
 */
export function assessPair(
  pins: AutomatedCheckPins,
  files: CheckFiles,
  locale: string,
  key: string,
  entryHash: unknown,
  pinnedHash: string | undefined,
  where: string,
): PairAssessment {
  const problems: string[] = [];
  let readAloudCurrent: boolean | null = null;
  let render: PairAssessment['render'] = null;

  const staleness = (r: Rec): string | undefined => {
    const h = r['content_hash'];
    if (h !== entryHash) {
      return `its content_hash ${JSON.stringify(h)} is not the register's ${JSON.stringify(entryHash)}`;
    }
    if (h !== pinnedHash) {
      return `its content_hash ${JSON.stringify(h)} is not AUTHORED_CONTENT_PINNED's ${pinnedHash === undefined ? '(none pinned)' : pinnedHash}`;
    }
    return undefined;
  };

  if (Object.hasOwn(pins.readAloudKeys, key)) {
    const r = recordAt(files.readAloud, locale, key);
    if (r === undefined) {
      problems.push(
        `NO-READ-ALOUD-CHECK ${where}: ${READ_ALOUD_FILE} has no record for this pair. A spoken ` +
          'safety string ships at the terminal status only with a current read-aloud check ' +
          '(OE-82; run `node packages/i18n/tools/read-aloud.ts --write`).',
      );
      readAloudCurrent = false;
    } else {
      const before = problems.length;
      const stale = staleness(r);
      if (stale !== undefined) {
        problems.push(
          `STALE-READ-ALOUD-CHECK ${where}: ${stale}. The read-aloud check was made on other ` +
            'bytes than the ones that ship.',
        );
      }
      if (r['result'] !== 'pass') {
        problems.push(`READ-ALOUD-FAILED ${where}: result is ${JSON.stringify(r['result'])}, not "pass".`);
      }
      if (r['tool'] !== pins.readAloudTool) {
        problems.push(
          `UNPINNED-CHECK-TOOL ${where}: tool is ${JSON.stringify(r['tool'])}, not the pinned ` +
            `"${pins.readAloudTool}" (CHECK_TOOLS, tools/automated-checks.ts).`,
        );
      }
      readAloudCurrent =
        problems.length === before && humanClaims(r, pins.readAloudCheckedBy).length === 0;
    }
  }

  if (Object.hasOwn(pins.renderKeys, key)) {
    if (Object.hasOwn(pins.awaiting, key)) {
      render = 'awaiting';
    } else {
      const r = recordAt(files.render, locale, key);
      if (r === undefined) {
        problems.push(
          `NO-RENDER-CHECK ${where}: ${RENDER_FILE} has no record for this pair, and the key is not ` +
            'in AWAITING_SURFACE. A shown safety string ships at the terminal status only with a ' +
            'current 360 px render check (OE-82; `gate:safety-copy-render`, T-265) or listed against ' +
            'the ticket that builds its surface.',
        );
        render = 'unchecked';
      } else {
        const before = problems.length;
        const stale = staleness(r);
        if (stale !== undefined) {
          problems.push(
            `STALE-RENDER-CHECK ${where}: ${stale}. The render check was made on other bytes than ` +
              'the ones that ship.',
          );
        }
        if (r['result'] !== 'pass') {
          problems.push(`RENDER-FAILED ${where}: result is ${JSON.stringify(r['result'])}, not "pass".`);
        }
        render =
          problems.length === before && humanClaims(r, pins.renderCheckedBy).length === 0
            ? 'checked'
            : 'unchecked';
      }
    }
  }
  return { problems, readAloudCurrent, render };
}

/* --------------------------------------- RENDERED-UNCHECKED: the app source */

/** The app directories whose source the scan reads, repository-relative. */
export const APP_DIRS: readonly string[] = ['apps/web', 'apps/admin'];

/** A test file: `*.test.*`, `*.spec.*`, or anything under a `__tests__/` directory. */
export function isTestPath(path: string): boolean {
  return /(^|\/)__tests__\//u.test(path) || /\.(test|spec)\.[^/]+$/u.test(path);
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * The TRACKED, non-test files under `APP_DIRS` (`git ls-files`, so the index,
 * including an intent-to-add entry; an untracked file is not read), read raw
 * as UTF-8. Returns an error string instead when git cannot list them or a
 * listed file cannot be read, which the gate refuses (APP-SOURCE-UNREADABLE).
 */
export function trackedAppSources(repoRoot: string): { files: SourceFile[] } | { error: string } {
  const r = spawnSync('git', ['-C', repoRoot, 'ls-files', '-z', '--', ...APP_DIRS], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { error: `git ls-files exited ${String(r.status)}: ${(r.stderr ?? '').trim() || String(r.error)}` };
  }
  const files: SourceFile[] = [];
  for (const path of r.stdout.split('\0')) {
    if (path === '' || isTestPath(path)) continue;
    try {
      files.push({ path, text: readFileSync(join(repoRoot, path), 'utf8') });
    } catch (err) {
      return { error: `${path} is tracked but cannot be read — ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { files };
}

/**
 * RENDERED-UNCHECKED. A key in `AWAITING_SURFACE` whose id appears, as a raw
 * substring, in any of `files`: some app source names it, so a surface may
 * already show it with no render check. Read raw: no parse, no word boundary,
 * so a longer key containing it also counts (fail closed). A key built at run
 * time from pieces (`` `safety.sos.${x}` ``) is not seen. One line per key,
 * naming every file.
 */
export function renderedUnchecked(
  pins: AutomatedCheckPins,
  files: readonly SourceFile[],
  failures: string[],
): void {
  for (const [key, ticket] of Object.entries(pins.awaiting)) {
    const hits = files.filter((f) => f.text.includes(key)).map((f) => f.path);
    if (hits.length === 0) continue;
    failures.push(
      `RENDERED-UNCHECKED '${key}': it is in AWAITING_SURFACE (against ${String(ticket)}), and tracked ` +
        `app source names it: ${hits.join(', ')}. A surface that renders a safety string declares it ` +
        'for gate:safety-copy-render and removes the key from AWAITING_SURFACE in the same commit.',
    );
  }
}

/* ------------------------------------------------------------- the count line */

export interface AutomatedCounts {
  readAloudCurrent: number;
  readAloudPairs: number;
  renderChecked: number;
  renderAwaiting: number;
  renderUnchecked: number;
  /** pairs awaiting, per owning ticket, in AWAITING_SURFACE order */
  readonly awaitingByTicket: Map<string, number>;
}

export function newCounts(pins: AutomatedCheckPins): AutomatedCounts {
  const byTicket = new Map<string, number>();
  for (const t of Object.values(pins.awaiting)) if (!byTicket.has(t)) byTicket.set(t, 0);
  return {
    readAloudCurrent: 0,
    readAloudPairs: 0,
    renderChecked: 0,
    renderAwaiting: 0,
    renderUnchecked: 0,
    awaitingByTicket: byTicket,
  };
}

export function tally(pins: AutomatedCheckPins, counts: AutomatedCounts, key: string, a: PairAssessment): void {
  if (a.readAloudCurrent !== null) {
    counts.readAloudPairs += 1;
    if (a.readAloudCurrent) counts.readAloudCurrent += 1;
  }
  if (a.render === 'checked') counts.renderChecked += 1;
  else if (a.render === 'unchecked') counts.renderUnchecked += 1;
  else if (a.render === 'awaiting') {
    counts.renderAwaiting += 1;
    const t = String(pins.awaiting[key]);
    counts.awaitingByTicket.set(t, (counts.awaitingByTicket.get(t) ?? 0) + 1);
  }
}

/** `automated checks: read-aloud <a>/<b> pairs current; render-360 <c> checked, <d> awaiting surface (T-110: <x>, T-107: <y>)` */
export function countsLine(counts: AutomatedCounts): string {
  const byTicket = [...counts.awaitingByTicket].filter(([, n]) => n > 0);
  const tickets = byTicket.length === 0 ? 'none' : byTicket.map(([t, n]) => `${t}: ${String(n)}`).join(', ');
  const unchecked = counts.renderUnchecked === 0 ? '' : `, ${String(counts.renderUnchecked)} with no current record`;
  return (
    `automated checks: read-aloud ${String(counts.readAloudCurrent)}/${String(counts.readAloudPairs)} pairs current; ` +
    `render-360 ${String(counts.renderChecked)} checked, ${String(counts.renderAwaiting)} awaiting surface ` +
    `(${tickets})${unchecked}`
  );
}
