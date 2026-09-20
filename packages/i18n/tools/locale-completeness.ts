/**
 * `gate:locale-completeness` — T-042. SA §TS-12.3, SD §FE-10.
 *
 * THE RULE: no `safety_critical` and no `transactional` key may resolve to a
 * missing translation in any enabled locale. SA §TS-12.3 states it as
 * "every safety_critical and transactional key present in en, el, ru; missing
 * key -> build failure with the key path and the tier". SD §FE-10 adds two
 * words that shape this file: "present **and non-empty**", and "runs against
 * the COMPILED catalogue, so a syntactically valid but structurally empty ICU
 * message also fails".
 *
 * THIS GATE IS NOT THE ONLY ENFORCEMENT AND MUST NOT BECOME IT (T-040
 * § Published contract §8). `compiled/index.ts`'s `STRICT_TIER_COMPLETENESS`
 * makes a strict-tier gap a MISSING PROPERTY, so `pnpm -w typecheck` already
 * does not link. This gate is the readable, key-listing version of the same
 * rule, and it is the one that fires on a catalogue edit that has not been
 * recompiled — which is the state a human is actually in when they delete a
 * `ru` string.
 *
 * TWO READINGS, FROM TWO ARTEFACTS, ON PURPOSE (PROTOCOL §5.1: "a check must
 * not be derived from the same reading as the thing it checks"):
 *
 *   A  THE CATALOGUE SOURCE — `catalogues/<locale>/<ns>.json`. This is what a
 *      human edits. Reading A alone catches a key deleted from `ru` whether or
 *      not `compiled/` was regenerated.
 *   B  THE COMMITTED COMPILED CATALOGUE — `CATALOGUES` from `compiled/`, which
 *      is what ships and what SD §FE-10 names. Reading B alone catches a
 *      compiled artefact that lost a key its source still has.
 *   C  The two key sets are compared with each other AND both are compared
 *      with the registry and the tier table. A gate that derived its expected
 *      key set from the same file it then checked would be green precisely
 *      while it was checking nothing.
 *
 * WHERE EACH INPUT COMES FROM, which is the anti-vacuity design:
 *   - WHICH LOCALES must have a translation: `locale-registry.json`'s ENABLED
 *     rows. NOT `readdirSync('catalogues/')` — deleting the whole `ru/`
 *     directory would then reduce the work to two locales and pass.
 *   - WHICH KEYS must be translated: `tiers.json`, filtered by `TIER_POLICY`
 *     (`packages/i18n/src/tiers.ts`), which is the one place the four tiers'
 *     behaviour is stated. NOT a list written here.
 *   - WHETHER A VALUE IS CONTENT: `rendersNothingVisible()` from
 *     `tools/compile.ts` — the SAME predicate the compiler refuses on
 *     (T-049 § Published contract §5), imported rather than restated, so the
 *     two cannot drift. It carries T-049's named residual: a PRIVATE-USE or
 *     UNASSIGNED code point is NOT refused by it, here or there.
 *   - WHETHER A MESSAGE RENDERS ANYTHING STRUCTURALLY: `hasContent()` and
 *     `assertNoBlankBranches()` from `tools/compile.ts`, likewise imported.
 *
 * IF IT CHECKED NOTHING, WOULD IT SAY SO? It refuses to pass on: fewer than
 * two enabled locales; zero strict-tier keys; a default locale that is not
 * enabled; a missing catalogue directory or namespace file; and — the floor
 * that catches everything else — a count of examined (locale, key) pairs that
 * does not equal `strict keys x enabled locales`. Every run prints that count.
 *
 * USAGE:  node packages/i18n/tools/locale-completeness.ts [--root <dir>]
 *
 * `--root` points reading A at another package root (the Vitest cases build
 * one in a temporary directory). READINGS B AND C ARE THEN NOT RUN, because
 * the compiled catalogue that can be imported is this package's and not that
 * root's — and the PASS/FAIL BANNER SAYS SO, so a `--root` run can never be
 * pasted as evidence of a full one. The committed `pnpm gate:locale-completeness`
 * passes no arguments.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@formatjs/icu-messageformat-parser';
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import {
  rendersNothingVisible,
  describeContentFree,
  hasContent,
  assertNoBlankBranches,
} from './compile.ts';
import { TIER_POLICY } from '../src/tiers.ts';
import type { Tier } from '../src/types.ts';

const GATE = 'gate:locale-completeness';
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ argv */

function parseArgs(argv: readonly string[]): { root: string; explicitRoot: boolean } {
  let root = PACKAGE_ROOT;
  let explicitRoot = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error(`${GATE}: --root needs a directory`);
        process.exit(2);
      }
      root = value;
      explicitRoot = true;
      i += 1;
      continue;
    }
    // Refused rather than ignored: an argument this gate does not understand
    // is far more likely to be a narrowing someone expected to take effect.
    console.error(`${GATE}: unrecognised argument ${JSON.stringify(arg)}`);
    process.exit(2);
  }
  return { root, explicitRoot };
}

/* ----------------------------------------------------------------- output */

/**
 * Everything this gate prints goes to STDOUT, including the failure banner, so
 * that the progress lines and the banner keep their order when the output is
 * piped. Two streams interleave unpredictably through a pipe, and the pasted
 * evidence a reviewer reads is always piped.
 */
function finish(banner: string, failures: readonly string[]): never {
  if (failures.length === 0) {
    console.log(`\nGATE PASS  ${banner}`);
    process.exit(0);
  }
  console.log(`\nGATE FAIL  ${banner} — ${String(failures.length)} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ input */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

interface RegistryRow {
  readonly code: string;
  readonly enabled: boolean;
}

interface Registry {
  readonly defaultLocale: string;
  readonly rows: readonly RegistryRow[];
}

function loadRegistry(root: string, failures: string[]): Registry | undefined {
  const path = join(root, 'locale-registry.json');
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (err) {
    failures.push(`INPUT locale-registry.json is unreadable or not JSON — ${String(err)}`);
    return undefined;
  }
  if (!isRecord(raw)) {
    failures.push('INPUT locale-registry.json is not a JSON object');
    return undefined;
  }
  const defaultLocale = raw['defaultLocale'];
  const locales = raw['locales'];
  if (typeof defaultLocale !== 'string' || !Array.isArray(locales)) {
    failures.push(
      'INPUT locale-registry.json needs a string `defaultLocale` and a `locales` array',
    );
    return undefined;
  }
  const rows: RegistryRow[] = [];
  for (const row of locales) {
    if (!isRecord(row)) continue;
    const code = row['code'];
    const enabled = row['enabled'];
    if (typeof code !== 'string') continue;
    rows.push({ code, enabled: enabled === true });
  }
  return { defaultLocale, rows };
}

function loadTiers(root: string, failures: string[]): ReadonlyMap<string, Tier> {
  const out = new Map<string, Tier>();
  const path = join(root, 'tiers.json');
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (err) {
    failures.push(`INPUT tiers.json is unreadable or not JSON — ${String(err)}`);
    return out;
  }
  const tiers = isRecord(raw) ? raw['tiers'] : undefined;
  if (!isRecord(tiers)) {
    failures.push('INPUT tiers.json needs a `tiers` object mapping fully-qualified key -> tier');
    return out;
  }
  for (const [key, value] of Object.entries(tiers)) {
    if (typeof value === 'string' && value in TIER_POLICY) {
      out.set(key, value as Tier);
    } else {
      failures.push(
        `INPUT tiers.json: '${key}' has tier ${JSON.stringify(value)}, which is not one of ` +
          `${Object.keys(TIER_POLICY).join(', ')}. An untiered or mis-tiered key cannot be ` +
          'placed on either side of this gate, so it is refused rather than skipped.',
      );
    }
  }
  return out;
}

/** locale -> fully-qualified key -> the raw JSON value, exactly as it sits on disk. */
function loadCatalogueSource(
  root: string,
  locales: readonly string[],
  namespaces: readonly string[],
  failures: string[],
): ReadonlyMap<string, ReadonlyMap<string, unknown>> {
  const out = new Map<string, Map<string, unknown>>();
  for (const locale of locales) {
    const perLocale = new Map<string, unknown>();
    out.set(locale, perLocale);
    const dir = join(root, 'catalogues', locale);
    if (!existsSync(dir)) {
      failures.push(
        `MISSING-CATALOGUE catalogues/${locale}/ does not exist, but '${locale}' is an ENABLED ` +
          'locale in locale-registry.json. Every strict-tier key is missing in it.',
      );
      continue;
    }
    for (const ns of namespaces) {
      const file = join(dir, `${ns}.json`);
      if (!existsSync(file)) {
        failures.push(
          `MISSING-CATALOGUE catalogues/${locale}/${ns}.json is absent; the default locale has ` +
            'that namespace, so every strict-tier key in it is untranslated here.',
        );
        continue;
      }
      let raw: unknown;
      try {
        raw = readJson(file);
      } catch (err) {
        failures.push(`INPUT catalogues/${locale}/${ns}.json is not valid JSON — ${String(err)}`);
        continue;
      }
      if (!isRecord(raw)) {
        failures.push(`INPUT catalogues/${locale}/${ns}.json must be a flat JSON object`);
        continue;
      }
      for (const [key, value] of Object.entries(raw)) {
        if (key === '//') continue;
        perLocale.set(`${ns}.${key}`, value);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------- main */

async function main(argv: readonly string[]): Promise<void> {
  const { root, explicitRoot } = parseArgs(argv);
  const banner = explicitRoot
    ? `${GATE}  [--root ${root}: SOURCE READING ONLY — the compiled catalogue was NOT read]`
    : GATE;
  const failures: string[] = [];

  console.log(`${GATE}: reading ${root}`);

  const registry = loadRegistry(root, failures);
  const tiers = loadTiers(root, failures);
  if (registry === undefined) finish(banner, failures);

  const enabled = registry.rows.filter((r) => r.enabled).map((r) => r.code);
  const defaultLocale = registry.defaultLocale;
  const strictKeysFromSource = [...tiers.entries()]
    .filter(([, tier]) => TIER_POLICY[tier].onMissingTranslation === 'build_failure')
    .map(([key]) => key)
    .sort();
  const strictTierNames = (Object.keys(TIER_POLICY) as Tier[]).filter(
    (t) => TIER_POLICY[t].onMissingTranslation === 'build_failure',
  );

  console.log(
    `  enabled locales (locale-registry.json): ${enabled.join(', ')} ` +
      `(default '${defaultLocale}')`,
  );
  console.log(
    `  strict tiers (TIER_POLICY, onMissingTranslation = build_failure): ` +
      `${strictTierNames.join(', ')}`,
  );
  console.log(
    `  strict-tier keys (tiers.json): ${String(strictKeysFromSource.length)} of ` +
      `${String(tiers.size)} tiered keys; the other ${String(tiers.size - strictKeysFromSource.length)} ` +
      'are operational/marketing and MAY fall back to the default locale (SA §TS-12.1) — ' +
      'this gate does not check them, deliberately.',
  );

  // ------------------------------------------------------- V. anti-vacuity
  if (!enabled.includes(defaultLocale)) {
    failures.push(
      `NO-COMPARISON the default locale '${defaultLocale}' is not an enabled registry row. ` +
        'The key set every translation is held against would be empty.',
    );
  }
  if (enabled.length < 2) {
    failures.push(
      `NO-COMPARISON ${String(enabled.length)} enabled locale(s). A completeness gate over fewer ` +
        'than two locales compares a catalogue with itself and would pass whatever it contained.',
    );
  }
  if (strictKeysFromSource.length === 0) {
    failures.push(
      'NO-COMPARISON tiers.json assigns no key to safety_critical or transactional. This gate ' +
        'would then examine nothing and exit 0 — which is the vacuous pass it exists to prevent.',
    );
  }
  if (failures.length > 0) finish(banner, failures);

  // ----------------------------------------------- namespaces, from `en` only
  const defaultDir = join(root, 'catalogues', defaultLocale);
  let namespaces: string[];
  try {
    namespaces = readdirSync(defaultDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    finish(banner, [
      `MISSING-CATALOGUE catalogues/${defaultLocale}/ is missing — the default locale has no ` +
        'catalogue, so there is no key set to hold the translations against.',
    ]);
  }
  console.log(`  namespaces (from catalogues/${defaultLocale}/): ${namespaces.join(', ')}`);

  const source = loadCatalogueSource(root, enabled, namespaces, failures);

  // ------------------------------------- A. every strict key, in every locale
  const defaultKeys = source.get(defaultLocale);
  for (const key of strictKeysFromSource) {
    if (defaultKeys !== undefined && !defaultKeys.has(key)) {
      failures.push(
        `UNSOURCED-KEY '${key}' is tiered ${String(tiers.get(key))} in tiers.json but does not ` +
          `exist in catalogues/${defaultLocale}/. The gate's expected key set must be grounded ` +
          'in real source, or it is a list checking itself.',
      );
    }
  }

  let examined = 0;
  const presentPerLocale = new Map<string, number>();
  for (const locale of enabled) {
    const perLocale = source.get(locale);
    let present = 0;
    for (const key of strictKeysFromSource) {
      examined += 1;
      const tier = tiers.get(key) ?? 'safety_critical';
      const where = `'${key}' (${tier}) in ${locale}`;
      if (perLocale === undefined || !perLocale.has(key)) {
        failures.push(
          `MISSING ${where}: catalogues/${locale}/${key.slice(0, key.indexOf('.'))}.json has no ` +
            `'${key.slice(key.indexOf('.') + 1)}'. A ${tier} key has no runtime fallback path ` +
            '(SA §TS-12.1) — it cannot ship untranslated.',
        );
        continue;
      }
      const value = perLocale.get(key);
      if (typeof value !== 'string') {
        failures.push(
          `NOT-A-STRING ${where}: the catalogue value is ${JSON.stringify(value)}. Catalogues are ` +
            'flat; a nested object is not a namespace.',
        );
        continue;
      }
      if (rendersNothingVisible(value)) {
        failures.push(
          `CONTENT-FREE ${where}: the value ${describeContentFree(value)} and renders nothing a ` +
            'reader would see. Presence is not content (SD §FE-10: "present AND NON-EMPTY").',
        );
        continue;
      }
      let ast: MessageFormatElement[];
      try {
        ast = parse(value, { requiresOtherClause: true, shouldParseSkeletons: true });
      } catch (err) {
        failures.push(
          `MALFORMED ${where}: ${err instanceof Error ? err.message : String(err)}. An unparseable ` +
            'message resolves to nothing at run time.',
        );
        continue;
      }
      const structural: string[] = [];
      assertNoBlankBranches(ast, where, structural);
      if (!hasContent(ast)) {
        structural.push(
          `${where}: the message is syntactically valid ICU and renders nothing (SD §FE-10).`,
        );
      }
      if (structural.length > 0) {
        for (const s of structural) failures.push(`EMPTY-MESSAGE ${s}`);
        continue;
      }
      present += 1;
    }
    presentPerLocale.set(locale, present);
  }

  for (const locale of enabled) {
    const present = presentPerLocale.get(locale) ?? 0;
    console.log(
      `  ${present === strictKeysFromSource.length ? 'ok  ' : '!!  '}${locale}: ` +
        `${String(present)}/${String(strictKeysFromSource.length)} strict-tier keys present, ` +
        'a string, and rendering something',
    );
  }

  // The floor. Every other check above can be made to report nothing by
  // deleting its input; this one cannot, because both factors are read from
  // files that are not the catalogues being examined.
  const expectedPairs = strictKeysFromSource.length * enabled.length;
  console.log(
    `  examined ${String(examined)} (locale, key) pair(s) — ` +
      `${String(strictKeysFromSource.length)} strict key(s) x ${String(enabled.length)} enabled locale(s)`,
  );
  if (examined !== expectedPairs) {
    failures.push(
      `VACUOUS-RUN examined ${String(examined)} (locale, key) pair(s); ` +
        `${String(strictKeysFromSource.length)} strict key(s) x ${String(enabled.length)} enabled ` +
        'locale(s) is ' +
        `${String(expectedPairs)}. Some pair was never looked at.`,
    );
  }

  // ------------------------- B and C. the committed compiled catalogue
  if (explicitRoot) {
    console.log(
      `  READINGS B AND C NOT RUN: --root was given, and the compiled catalogue reachable from ` +
        'this script belongs to packages/i18n, not to that root. This run is reading A only.',
    );
    finish(banner, failures);
  }

  await finishWithCompiledReading(banner, failures, strictKeysFromSource, enabled, examined);
}

async function finishWithCompiledReading(
  banner: string,
  failures: string[],
  strictKeysFromSource: readonly string[],
  enabledFromRegistry: readonly string[],
  sourcePairs: number,
): Promise<void> {
  // Imported late and defensively: a broken `compiled/` must produce this
  // gate's own GATE FAIL banner, never an uncaught exception (PROTOCOL §5.1 —
  // "did nothing", "refused" and "crashed" must be three distinguishable
  // outcomes).
  let strictKeysCompiled: readonly string[];
  let catalogues: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  let enabledCompiled: readonly string[];
  try {
    const mod = (await import('../src/index.ts')) as unknown as {
      strictKeys: () => readonly string[];
      CATALOGUES: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      enabledLocales: () => readonly { code: string }[];
    };
    strictKeysCompiled = [...mod.strictKeys()].sort();
    catalogues = mod.CATALOGUES;
    enabledCompiled = mod.enabledLocales().map((d) => d.code);
  } catch (err) {
    failures.push(
      `COMPILED-UNREADABLE the committed compiled catalogue could not be loaded — ` +
        `${err instanceof Error ? err.message : String(err)}. Run ` +
        '`pnpm --filter @kinvara/i18n build` and commit `compiled/`.',
    );
    finish(banner, failures);
  }

  // C. the three artefacts must agree on WHAT has to be translated and WHERE.
  const onlyInSource = strictKeysFromSource.filter((k) => !strictKeysCompiled.includes(k));
  const onlyInCompiled = strictKeysCompiled.filter((k) => !strictKeysFromSource.includes(k));
  if (onlyInSource.length > 0 || onlyInCompiled.length > 0) {
    failures.push(
      `TIER-DRIFT tiers.json and the committed compiled/tiers.ts disagree on the strict-tier key ` +
        `set — only in tiers.json: [${onlyInSource.join(', ')}]; only in compiled/: ` +
        `[${onlyInCompiled.join(', ')}]. The gate and the type-level assertion in ` +
        'compiled/index.ts would then be enforcing two different rules.',
    );
  }
  const localeDrift =
    enabledFromRegistry.length !== enabledCompiled.length ||
    enabledFromRegistry.some((c) => !enabledCompiled.includes(c));
  if (localeDrift) {
    failures.push(
      `LOCALE-DRIFT locale-registry.json enables [${enabledFromRegistry.join(', ')}] but the ` +
        `committed compiled registry enables [${enabledCompiled.join(', ')}].`,
    );
  }

  // B. SD §FE-10's reading: against the compiled catalogue, which is what ships.
  let compiledPairs = 0;
  for (const locale of enabledCompiled) {
    const cat = catalogues[locale];
    if (cat === undefined) {
      failures.push(
        `COMPILED-MISSING compiled/ has no catalogue for the enabled locale '${locale}'.`,
      );
      continue;
    }
    let present = 0;
    for (const key of strictKeysCompiled) {
      compiledPairs += 1;
      if (typeof cat[key] !== 'function') {
        failures.push(
          `COMPILED-MISSING '${key}' has no compiled message function in '${locale}'. SD §FE-10: ` +
            '"a missing key is a missing function and the build does not link" — this gate names ' +
            'it before the typecheck does.',
        );
        continue;
      }
      present += 1;
    }
    console.log(
      `  ${present === strictKeysCompiled.length ? 'ok  ' : '!!  '}compiled/${locale}: ` +
        `${String(present)}/${String(strictKeysCompiled.length)} strict-tier message functions`,
    );
  }
  const expectedCompiledPairs = strictKeysCompiled.length * enabledCompiled.length;
  console.log(
    `  examined ${String(compiledPairs)} compiled (locale, key) pair(s); reading A examined ` +
      `${String(sourcePairs)}`,
  );
  if (compiledPairs !== expectedCompiledPairs || compiledPairs === 0) {
    failures.push(
      `VACUOUS-RUN examined ${String(compiledPairs)} compiled (locale, key) pair(s); expected ` +
        `${String(expectedCompiledPairs)}.`,
    );
  }

  finish(banner, failures);
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  // A crash is not a refusal. If this gate dies for a reason it did not
  // anticipate, it still prints its own banner so `gate:pr` and any harness
  // reading the output can tell the three outcomes apart.
  console.log(`\nGATE FAIL  ${GATE} — 1 problem(s):`);
  console.log(`  - CRASH ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
