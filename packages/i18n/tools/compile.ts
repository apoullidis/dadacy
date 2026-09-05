/**
 * The build-time ICU compiler — SA §TS-12.2 rule 4, SD §FE-10.
 *
 * Reads `locale-registry.json`, `tiers.json` and `catalogues/<locale>/<ns>.json`;
 * validates them fail-closed; parses every ICU message with
 * `@formatjs/icu-messageformat-parser`; and emits `compiled/**` — one TypeScript
 * module per locale per namespace, exporting **one typed function per key** over
 * a pre-parsed AST.
 *
 * Why compile rather than parse at run time (SD §FE-10, in its order of weight):
 *   1. a malformed ICU message becomes a BUILD failure instead of a runtime
 *      exception on a safety screen;
 *   2. the ~40 KB ICU parser never enters the 180 KB route budget;
 *   3. tree-shaking removes namespaces a route does not use.
 *
 * And the fourth, which is this ticket's real product: because the strict tiers
 * are emitted as a `Record<StrictMessageKey, …>` in `compiled/index.ts`, a
 * `safety_critical` or `transactional` key missing from any locale is a missing
 * property and the repo-wide typecheck does not link. That is SD §FE-10's "there
 * is no runtime fallback code path to test, because there is no runtime
 * fallback" expressed as a type rather than as a convention.
 *
 * Usage:  node tools/compile.ts [--check] [--root <dir>] [--out <dir>]
 *   --check  compile to memory and diff against what is on disk; exit 1 on drift.
 *            Nothing is written. This is what keeps a committed `compiled/`
 *            honest against the catalogues it claims to come from.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import prettier from 'prettier';
import type { Tier, PluralCategory, Direction } from '../src/types.ts';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** SD §FE-10: the four tiers, and nothing else is a tier. */
const VALID_TIERS: readonly string[] = [
  'safety_critical',
  'transactional',
  'operational',
  'marketing',
];

/** The two tiers with no runtime fallback path (SA §TS-12.1, SD §FE-10). */
const STRICT_TIERS: readonly string[] = ['safety_critical', 'transactional'];

/** CLDR cardinal categories. Closed by CLDR, not by us. */
const VALID_PLURAL_CATEGORIES: readonly string[] = [
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
];

/**
 * The key convention, as a regex rather than a list.
 * Namespace = the catalogue filename. Key = a flat dotted path inside it.
 * A fully-qualified key is `<namespace>.<key>`.
 */
const NAMESPACE_RE = /^[a-z][a-z0-9_]*$/;
const KEY_RE = /^[a-z0-9][a-z0-9_]*(\.[a-z0-9][a-z0-9_]*)*$/;
const LOCALE_CODE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export class CompileError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`i18n compile failed with ${String(problems.length)} problem(s):\n  - ${problems.join('\n  - ')}`);
    this.name = 'CompileError';
    this.problems = problems;
  }
}

interface RegistryEntry {
  code: string;
  endonym: string;
  direction: Direction;
  isSafetyLanguage: boolean;
  pluralCategories: PluralCategory[];
  enabled: boolean;
}

interface Registry {
  defaultLocale: string;
  locales: RegistryEntry[];
}

type ParamKind =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'datetime' }
  | { kind: 'select'; options: string[] };

interface CompiledMessage {
  /** Fully-qualified key, `<namespace>.<key>`. */
  fqk: string;
  /** The key as it appears inside the namespace file. */
  localKey: string;
  ast: MessageFormatElement[];
  params: Map<string, ParamKind>;
}

export interface CompileOptions {
  root?: string;
  out?: string;
  check?: boolean;
}

export interface CompileResult {
  /** Absolute path → file content. */
  files: Map<string, string>;
  locales: string[];
  namespaces: string[];
  keyCount: number;
  strictKeyCount: number;
  /** Populated only in `--check` mode: paths whose on-disk content differs. */
  drift: string[];
}

function readJson(path: string, problems: string[]): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    problems.push(`${path}: not valid JSON — ${String(err)}`);
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ------------------------------------------------------------------ registry */

function loadRegistry(root: string, problems: string[]): Registry | undefined {
  const raw = readJson(join(root, 'locale-registry.json'), problems);
  if (!isRecord(raw)) return undefined;

  const defaultLocale = raw['defaultLocale'];
  const locales = raw['locales'];
  if (typeof defaultLocale !== 'string') {
    problems.push('locale-registry.json: `defaultLocale` must be a string');
    return undefined;
  }
  if (!Array.isArray(locales) || locales.length === 0) {
    problems.push('locale-registry.json: `locales` must be a non-empty array');
    return undefined;
  }

  const entries: RegistryEntry[] = [];
  const seen = new Set<string>();
  for (const [i, row] of locales.entries()) {
    const at = `locale-registry.json locales[${String(i)}]`;
    if (!isRecord(row)) {
      problems.push(`${at}: must be an object`);
      continue;
    }
    const code = row['code'];
    if (typeof code !== 'string' || !LOCALE_CODE_RE.test(code)) {
      problems.push(`${at}: \`code\` must be a BCP-47 code, got ${JSON.stringify(code)}`);
      continue;
    }
    if (seen.has(code)) {
      problems.push(`${at}: duplicate locale code ${code}`);
      continue;
    }
    seen.add(code);

    const endonym = row['endonym'];
    if (typeof endonym !== 'string' || endonym.trim() === '') {
      problems.push(`${at}: \`endonym\` must be a non-empty string — the switcher names each language in its own language`);
    }
    const direction = row['direction'];
    if (direction !== 'ltr' && direction !== 'rtl') {
      problems.push(`${at}: \`direction\` must be 'ltr' or 'rtl'`);
    }
    const isSafetyLanguage = row['isSafetyLanguage'];
    if (typeof isSafetyLanguage !== 'boolean') {
      problems.push(`${at}: \`isSafetyLanguage\` must be a boolean`);
    }
    const enabled = row['enabled'];
    if (typeof enabled !== 'boolean') {
      problems.push(`${at}: \`enabled\` must be a boolean`);
    }
    const cats = row['pluralCategories'];
    if (!Array.isArray(cats) || cats.length === 0) {
      problems.push(`${at}: \`pluralCategories\` must be a non-empty array — gate:plural-completeness (EV-2) reads it`);
      continue;
    }
    const badCat = cats.find((c) => typeof c !== 'string' || !VALID_PLURAL_CATEGORIES.includes(c));
    if (badCat !== undefined) {
      problems.push(`${at}: ${JSON.stringify(badCat)} is not a CLDR cardinal category`);
      continue;
    }
    if (!cats.includes('other')) {
      problems.push(`${at}: every CLDR locale has an 'other' category; ${code} does not declare one`);
    }
    entries.push({
      code,
      endonym: typeof endonym === 'string' ? endonym : '',
      direction: direction === 'rtl' ? 'rtl' : 'ltr',
      isSafetyLanguage: isSafetyLanguage === true,
      pluralCategories: cats as PluralCategory[],
      enabled: enabled !== false,
    });
  }

  const def = entries.find((e) => e.code === defaultLocale);
  if (def === undefined) {
    problems.push(`locale-registry.json: defaultLocale '${defaultLocale}' is not a registered locale`);
  } else if (!def.enabled) {
    problems.push(`locale-registry.json: defaultLocale '${defaultLocale}' is disabled`);
  }
  return { defaultLocale, locales: entries };
}

/* --------------------------------------------------------------------- tiers */

function loadTiers(root: string, problems: string[]): Map<string, Tier> {
  const out = new Map<string, Tier>();
  const raw = readJson(join(root, 'tiers.json'), problems);
  if (!isRecord(raw)) return out;
  const tiers = raw['tiers'];
  if (!isRecord(tiers)) {
    problems.push('tiers.json: `tiers` must be an object mapping fully-qualified key → tier');
    return out;
  }
  for (const [key, value] of Object.entries(tiers)) {
    if (!KEY_RE.test(key)) {
      problems.push(`tiers.json: '${key}' is not a valid fully-qualified key`);
      continue;
    }
    if (typeof value !== 'string' || !VALID_TIERS.includes(value)) {
      problems.push(`tiers.json: '${key}' has tier ${JSON.stringify(value)}; expected one of ${VALID_TIERS.join(', ')}`);
      continue;
    }
    out.set(key, value as Tier);
  }
  return out;
}

/* ---------------------------------------------------------------- parameters */

function mergeParam(
  params: Map<string, ParamKind>,
  name: string,
  next: ParamKind,
  where: string,
  problems: string[],
): void {
  const existing = params.get(name);
  if (existing === undefined) {
    params.set(name, next);
    return;
  }
  if (existing.kind !== next.kind) {
    problems.push(`${where}: parameter '${name}' is used as both ${existing.kind} and ${next.kind}`);
    return;
  }
  if (existing.kind === 'select' && next.kind === 'select') {
    for (const opt of next.options) if (!existing.options.includes(opt)) existing.options.push(opt);
  }
}

function walk(
  elements: readonly MessageFormatElement[],
  params: Map<string, ParamKind>,
  where: string,
  problems: string[],
): void {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.literal:
      case TYPE.pound:
        break;
      case TYPE.argument:
        mergeParam(params, el.value, { kind: 'string' }, where, problems);
        break;
      case TYPE.number:
        mergeParam(params, el.value, { kind: 'number' }, where, problems);
        break;
      case TYPE.date:
      case TYPE.time:
        mergeParam(params, el.value, { kind: 'datetime' }, where, problems);
        break;
      case TYPE.plural:
        mergeParam(params, el.value, { kind: 'number' }, where, problems);
        for (const opt of Object.values(el.options)) walk(opt.value, params, where, problems);
        break;
      case TYPE.select:
        mergeParam(
          params,
          el.value,
          { kind: 'select', options: Object.keys(el.options) },
          where,
          problems,
        );
        for (const opt of Object.values(el.options)) walk(opt.value, params, where, problems);
        break;
      case TYPE.tag:
        problems.push(
          `${where}: XML-like tag <${el.value}> is not supported. The compiled message type is \`string\`; tag formatting returns a fragment array. A surface needing rich text should request an extension to this compiler rather than concatenating (SA §TS-12.2 rule 1).`,
        );
        break;
      default:
        problems.push(`${where}: unsupported ICU element`);
    }
  }
}

function paramType(p: ParamKind): string {
  switch (p.kind) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'datetime':
      return 'Date | number';
    case 'select':
      return [...p.options].sort().map((o) => `'${o}'`).join(' | ');
  }
}

function paramsSignature(params: Map<string, ParamKind>): string {
  if (params.size === 0) return '';
  const fields = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, kind]) => `readonly ${name}: ${paramType(kind)}`)
    .join('; ');
  return `params: { ${fields} }`;
}

/* ----------------------------------------------------------------- emission */

const BANNER =
  '/* GENERATED by packages/i18n/tools/compile.ts — DO NOT EDIT.\n' +
  ' * Regenerate with `scripts/dev pnpm --filter @kinvara/i18n build`.\n' +
  ' * `build:check` fails if this file and the catalogues have drifted. */\n';

function emitNamespaceModule(
  locale: string,
  namespace: string,
  messages: readonly CompiledMessage[],
): string {
  const lines: string[] = [BANNER];
  lines.push(`import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';`);
  lines.push(`import { formatAst } from '../../src/runtime.ts';`);
  lines.push('');
  lines.push(`export const locale = '${locale}';`);
  lines.push(`export const namespace = '${namespace}';`);
  lines.push('');
  messages.forEach((m, i) => {
    lines.push(
      `const a${String(i)} = ${JSON.stringify(m.ast)} as unknown as readonly MessageFormatElement[];`,
    );
  });
  lines.push('');
  lines.push('export const messages = {');
  messages.forEach((m, i) => {
    const sig = paramsSignature(m.params);
    const arg = sig === '' ? '{}' : 'params';
    lines.push(`  '${m.fqk}': (${sig}): string => formatAst(a${String(i)}, locale, ${arg}),`);
  });
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

function emitLocaleIndex(locale: string, namespaces: readonly string[]): string {
  const lines: string[] = [BANNER];
  for (const ns of namespaces) lines.push(`import { messages as ${ns} } from './${ns}.ts';`);
  lines.push('');
  lines.push(`export const locale = '${locale}';`);
  lines.push('');
  lines.push(`export const messages = { ${namespaces.map((n) => `...${n}`).join(', ')} };`);
  lines.push('');
  return lines.join('\n');
}

function emitTiers(tiers: ReadonlyMap<string, Tier>): string {
  const keys = [...tiers.keys()].sort();
  const strict = keys.filter((k) => STRICT_TIERS.includes(tiers.get(k) ?? ''));
  const lines: string[] = [BANNER];
  lines.push(`import type { Tier } from '../src/types.ts';`);
  lines.push('');
  lines.push('/** Every fully-qualified key known to the catalogues. */');
  lines.push(`export type MessageKey =\n${keys.map((k) => `  | '${k}'`).join('\n')};`);
  lines.push('');
  lines.push(
    '/**\n' +
      ' * Keys whose tier has NO runtime fallback path (SA §TS-12.1, SD §FE-10):\n' +
      ' * `safety_critical` and `transactional`. `compiled/index.ts` asserts that\n' +
      ' * every registered locale supplies all of them, so a gap is a missing\n' +
      ' * property and the repo-wide typecheck does not link.\n' +
      ' */',
  );
  lines.push(
    strict.length === 0
      ? 'export type StrictMessageKey = never;'
      : `export type StrictMessageKey =\n${strict.map((k) => `  | '${k}'`).join('\n')};`,
  );
  lines.push('');
  lines.push('export const TIERS: Readonly<Record<MessageKey, Tier>> = {');
  for (const k of keys) lines.push(`  '${k}': '${String(tiers.get(k))}',`);
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

function emitRegistry(registry: Registry): string {
  const lines: string[] = [BANNER];
  lines.push(`import type { LocaleDescriptor } from '../src/types.ts';`);
  lines.push('');
  lines.push(
    '/* The locale set is DATA (SA §TS-12.2 rule 5). This module is generated from\n' +
      ' * locale-registry.json, which mirrors the `locale_registry` table. Adding a\n' +
      ' * locale is a row there — never a union type here. */',
  );
  lines.push(`export const DEFAULT_LOCALE = ${JSON.stringify(registry.defaultLocale)};`);
  lines.push('');
  lines.push(
    `export const LOCALE_DESCRIPTORS: readonly LocaleDescriptor[] = ${JSON.stringify(registry.locales)};`,
  );
  lines.push('');
  return lines.join('\n');
}

function emitRootIndex(locales: readonly string[]): string {
  const lines: string[] = [BANNER];
  lines.push(`import type { MessageFunction } from '../src/runtime.ts';`);
  lines.push(`import type { StrictMessageKey } from './tiers.ts';`);
  for (const l of locales) lines.push(`import { messages as ${l} } from './${l}/index.ts';`);
  lines.push('');
  lines.push('/** Every compiled catalogue, keyed by locale code. */');
  lines.push(
    `export const CATALOGUES: Readonly<Record<string, Readonly<Record<string, MessageFunction>>>> = { ${locales.join(', ')} };`,
  );
  lines.push('');
  lines.push(
    '/**\n' +
      ' * SD §FE-10: "a missing key is a missing function and the build does not link."\n' +
      ' *\n' +
      ' * This declaration IS that mechanism. Every registered locale must supply\n' +
      ' * every `safety_critical` and `transactional` key; a gap is a missing property\n' +
      ' * on this object literal and `pnpm -w typecheck` fails, naming the locale and\n' +
      ' * the key. It is deliberately scoped to the two strict tiers — `operational`\n' +
      ' * and `marketing` keys ARE permitted to fall back to the default locale at run\n' +
      ' * time (SA §TS-12.1), and a type that forbade that would contradict the spec.\n' +
      ' */',
  );
  lines.push(
    `export const STRICT_TIER_COMPLETENESS: Readonly<Record<string, Readonly<Record<StrictMessageKey, MessageFunction>>>> = { ${locales.join(', ')} };`,
  );
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ compile */

export async function compile(options: CompileOptions = {}): Promise<CompileResult> {
  const root = options.root ?? PACKAGE_ROOT;
  const out = options.out ?? join(root, 'compiled');
  const problems: string[] = [];

  const registry = loadRegistry(root, problems);
  const tiers = loadTiers(root, problems);
  if (registry === undefined) throw new CompileError(problems);

  const locales = registry.locales.filter((l) => l.enabled).map((l) => l.code);
  const defaultLocale = registry.defaultLocale;
  const cataloguesDir = join(root, 'catalogues');

  // Namespaces are DERIVED from the default locale's directory, not listed.
  // Adding `handover.json` to catalogues/en/ adds a namespace; there is no
  // second place to remember to edit.
  let namespaces: string[] = [];
  try {
    namespaces = readdirSync(join(cataloguesDir, defaultLocale))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    problems.push(`catalogues/${defaultLocale}/ is missing — the default locale has no catalogue`);
    throw new CompileError(problems);
  }
  for (const ns of namespaces) {
    if (!NAMESPACE_RE.test(ns)) problems.push(`catalogues/${defaultLocale}/${ns}.json: '${ns}' is not a valid namespace name`);
  }

  // locale → fqk → source string
  const sources = new Map<string, Map<string, string>>();
  for (const locale of locales) {
    const perLocale = new Map<string, string>();
    const dir = join(cataloguesDir, locale);
    if (!existsSync(dir)) {
      problems.push(`catalogues/${locale}/ is missing but '${locale}' is an enabled registry locale`);
      continue;
    }
    const present = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    for (const extra of present) {
      if (!namespaces.includes(extra)) {
        problems.push(`catalogues/${locale}/${extra}.json: no matching namespace in the default locale '${defaultLocale}'`);
      }
    }
    for (const ns of namespaces) {
      const file = join(dir, `${ns}.json`);
      if (!existsSync(file)) {
        problems.push(`catalogues/${locale}/${ns}.json is missing`);
        continue;
      }
      const raw = readJson(file, problems);
      if (!isRecord(raw)) {
        if (raw !== undefined) problems.push(`catalogues/${locale}/${ns}.json: must be a flat JSON object`);
        continue;
      }
      for (const [key, value] of Object.entries(raw)) {
        if (key === '//') continue;
        if (!KEY_RE.test(key)) {
          problems.push(`catalogues/${locale}/${ns}.json: '${key}' does not match the key convention ${String(KEY_RE)}`);
          continue;
        }
        if (typeof value !== 'string') {
          problems.push(`catalogues/${locale}/${ns}.json: '${key}' must be a string (catalogues are FLAT — nesting is not a namespace)`);
          continue;
        }
        perLocale.set(`${ns}.${key}`, value);
      }
    }
    sources.set(locale, perLocale);
  }

  const defaultKeys = sources.get(defaultLocale) ?? new Map<string, string>();

  // Fail-closed tier assignment: every key in the default locale must be tiered,
  // and every tier entry must correspond to a real key. There is no prefix rule
  // and no namespace default, because a key that silently inherits `marketing`
  // from its neighbours is exactly how a safety string escapes the gates.
  for (const fqk of defaultKeys.keys()) {
    if (!tiers.has(fqk)) {
      problems.push(`tiers.json: '${fqk}' has no tier. Every catalogue key carries a tier and the tier drives the gate (SA §TS-12.3).`);
    }
  }
  for (const fqk of tiers.keys()) {
    if (!defaultKeys.has(fqk)) {
      problems.push(`tiers.json: '${fqk}' is tiered but does not exist in catalogues/${defaultLocale}/`);
    }
  }
  // A key in a translation with no source is an orphan — usually a rename that
  // was applied to one locale only.
  for (const [locale, keys] of sources) {
    if (locale === defaultLocale) continue;
    for (const fqk of keys.keys()) {
      if (!defaultKeys.has(fqk)) {
        problems.push(`catalogues/${locale}/: '${fqk}' has no counterpart in the default locale '${defaultLocale}'`);
      }
    }
  }

  // Parse.
  const compiled = new Map<string, Map<string, CompiledMessage[]>>();
  for (const [locale, keys] of sources) {
    const byNamespace = new Map<string, CompiledMessage[]>();
    for (const ns of namespaces) byNamespace.set(ns, []);
    for (const [fqk, source] of [...keys.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const ns = fqk.slice(0, fqk.indexOf('.'));
      const localKey = fqk.slice(ns.length + 1);
      const where = `catalogues/${locale}/${ns}.json '${localKey}'`;
      let ast: MessageFormatElement[];
      try {
        ast = parse(source, { requiresOtherClause: true, shouldParseSkeletons: true });
      } catch (err) {
        problems.push(`${where}: malformed ICU message — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const params = new Map<string, ParamKind>();
      walk(ast, params, where, problems);
      byNamespace.get(ns)?.push({ fqk, localKey, ast, params });
    }
    compiled.set(locale, byNamespace);
  }

  if (problems.length > 0) throw new CompileError(problems);

  // Emit.
  const files = new Map<string, string>();
  const prettierConfig = (await prettier.resolveConfig(join(out, 'index.ts'))) ?? {};
  const format = async (path: string, text: string): Promise<void> => {
    files.set(path, await prettier.format(text, { ...prettierConfig, filepath: path }));
  };

  for (const locale of locales) {
    const byNamespace = compiled.get(locale);
    if (byNamespace === undefined) continue;
    for (const ns of namespaces) {
      await format(join(out, locale, `${ns}.ts`), emitNamespaceModule(locale, ns, byNamespace.get(ns) ?? []));
    }
    await format(join(out, locale, 'index.ts'), emitLocaleIndex(locale, namespaces));
  }
  await format(join(out, 'registry.ts'), emitRegistry(registry));
  await format(join(out, 'tiers.ts'), emitTiers(tiers));
  await format(join(out, 'index.ts'), emitRootIndex(locales));

  const strictKeyCount = [...tiers.values()].filter((t) => STRICT_TIERS.includes(t)).length;
  const result: CompileResult = {
    files,
    locales,
    namespaces,
    keyCount: defaultKeys.size,
    strictKeyCount,
    drift: [],
  };

  if (options.check === true) {
    for (const [path, content] of files) {
      const onDisk = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (onDisk !== content) result.drift.push(relative(root, path));
    }
    // A file on disk that the compiler no longer produces is drift too.
    const walkDir = (dir: string): string[] => {
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walkDir(join(dir, e.name)) : [join(dir, e.name)],
      );
    };
    for (const path of walkDir(out)) {
      if (!files.has(path)) result.drift.push(`${relative(root, path)} (orphan)`);
    }
    return result;
  }

  rmSync(out, { recursive: true, force: true });
  for (const [path, content] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return result;
}

/* ---------------------------------------------------------------------- CLI */

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');
  const root = argValue(argv, '--root');
  const out = argValue(argv, '--out');
  const options: CompileOptions = { check };
  if (root !== undefined) options.root = root;
  if (out !== undefined) options.out = out;

  try {
    const result = await compile(options);
    if (check) {
      if (result.drift.length > 0) {
        console.error('i18n compiled/ is STALE — these files differ from the catalogues:');
        for (const p of result.drift) console.error(`  - ${p}`);
        console.error('\nRun `pnpm --filter @kinvara/i18n build` and commit the result.');
        return 1;
      }
      console.log(
        `i18n compiled/ is current: ${String(result.files.size)} files, ${String(result.keyCount)} keys ` +
          `(${String(result.strictKeyCount)} strict-tier) across ${result.locales.join(', ')}.`,
      );
      return 0;
    }
    console.log(
      `i18n compiled: ${String(result.files.size)} modules, ${String(result.keyCount)} keys ` +
        `(${String(result.strictKeyCount)} strict-tier) × ${String(result.locales.length)} locales ` +
        `[${result.locales.join(', ')}], namespaces [${result.namespaces.join(', ')}].`,
    );
    return 0;
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
