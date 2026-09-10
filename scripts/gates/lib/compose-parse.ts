/**
 * THE ONE PLACE THESE GATES READ A COMPOSE FILE (T-037 rework, OD-39).
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS A FILE RATHER THAN THREE FIXES
 * -----------------------------------------------------------------
 * `T-037` shipped three independent `parseYaml(text)` call sites —
 * `app-images.ts`, `egress-boundary.ts` and `composed-files.ts` — each on
 * `yaml@2.8.1`'s DEFAULTS, which are **YAML 1.2**. Docker Compose resolves
 * `<<` merge keys; YAML 1.2 treats `<<` as an ordinary key. So a `build:`
 * reached through an `x-` fragment was invisible to every per-build rule while
 * compose built it. Measured by `tech-lead` on `47c6fb9` (decisions.md
 * **OD-39**): `gate:app-images` exit 0, `gate:pr` 9/9, this gate's own summary
 * still printing the clean-tree `builds read 7`, and the artefact at
 * `User=[]`, a shell at PID 1, `Healthcheck=null`, 167,508,709 B —
 * byte-identical to OD-32's and OD-33's figure. The same key hid a base-file
 * `ports:`, falsifying `T-036` § contract 4's first row as well.
 *
 * THE DEFECT WAS NOT `<<`. `T-017` §R3 measured this exact divergence on
 * 2026-09-05, wrote it up, and found that `egress-boundary.ts` FAILS CLOSED on
 * it — but only through an invariant derived from OUTSIDE the parse: *every
 * compose service declares `image:` or `build:`*. OD-39 is the shape that
 * SATISFIES that invariant while still being misread, because the merged
 * fragment supplies `build:` to a service that already declares `image:`. And
 * `app-images.ts`, written five days later, modelled neither `<<` nor
 * `extends` and had no equivalent net. **A known parser divergence sat in one
 * gate file's evidence for five days and never reached its sibling.** One
 * reader, shared by every site, is the fix for that. Closing `<<` alone would
 * have been the fix for the instance.
 *
 * THE ENUMERATION — every known divergence, MODELLED or FAIL-CLOSED
 * ----------------------------------------------------------------
 * `T-037`'s rework brief: "for each, either model it or make it fail closed,
 * and say in your contract which of the two you did."
 *
 *   CLASS A — the YAML version. **COMPOSE IS NEITHER 1.1 NOR 1.2, AND IT
 *   SPLITS WITHIN ONE DOCUMENT.** Measured against compose itself, not
 *   inferred from its source — `docker compose -f <probe> config`, one file
 *   with a merge key, `A: on` and `B: 0777`:
 *
 *       probe:  build: {context: ., dockerfile: Dockerfile.probe}   <- `<<` RESOLVED
 *       A: 'on'      <- a STRING: compose agrees with YAML 1.2 here
 *       B: "511"     <- OCTAL:    compose agrees with YAML 1.1 here
 *
 *   and this reader's two options, on the same shapes:
 *
 *       1.2 + merge -> {"a":".", "d":"on", "e":777, "f":"12:30"}
 *       1.1 + merge -> {"a":null,"d":true, "e":511, "f":750}
 *
 *   So NO single option here equals compose. Picking one and calling it
 *   "compose's parser" would be this family's own defect in a new place —
 *   which is why merge keys are modelled (compose resolves them, measured
 *   above) and every OTHER disagreement refuses the file instead of guessing.
 *
 *   A1  `<<` merge keys ....... MODELLED. `{ merge: true }`, which BOTH
 *       readings below then resolve identically, so a legitimate `x-` fragment
 *       stays usable and OD-39's build becomes visible to the ordinary rules.
 *   A2  1.1-only booleans (`on`, `yes`, `no`, `off`, `y`, `n`)
 *   A3  leading-zero octal (`0777`)
 *   A4  sexagesimal (`12:30`)
 *   A5  ANY other scalar or tag resolution that differs between the versions
 *       ....... all FAIL CLOSED, and A2-A4 are named as EXAMPLES rather than
 *       as the covered set: the check is that the two readings AGREE, not a
 *       list of spellings. The rule it enforces is a property of the compose
 *       file, not of the reader:
 *
 *           A COMPOSED FILE MUST MEAN THE SAME THING UNDER YAML 1.1 AND 1.2.
 *
 *       The repair is always to quote the ambiguous scalar, which changes
 *       nothing for compose. `docker/compose.yml`'s `context: .` was the one
 *       instance on the delivered tree and is now `context: '.'`.
 *   A6  a tag no reader can resolve (`!reset`, `!override`, any `!custom`)
 *       ....... FAIL CLOSED, from `parseDocument`'s own warnings — derived
 *       from the reader, not from a list of tag names. At 1.2 defaults
 *       `weird: !reset []` parsed to `[]` with a console warning and NO gate
 *       failure. Measured.
 *   A7  parse error, duplicate key, non-mapping root ....... FAIL CLOSED.
 *
 *   CLASS B — COMPOSE-SPEC features no YAML reader models
 *   B1  `extends:` ....... FAIL CLOSED. It can name a service in a file this
 *       gate never reads (`T-017` §R5's ruling), now applied at EVERY call
 *       site instead of one — that relocation is the other half of the fix.
 *   B2  top-level `include:` ....... FAIL CLOSED. The same shape, one level up.
 *
 * WHAT IS NOT CLOSED, AND IS STATED RATHER THAN GUESSED: this reads compose
 * files with `yaml`, not with compose-go. "Modelled" means merge keys are
 * resolved as compose resolves them, measured above; "fail closed" means every
 * OTHER known point of disagreement refuses the file rather than picking a
 * reading. **A construct on which `yaml`'s two versions AGREE and compose-go
 * disagrees with both would still be misread, and nothing here detects that.**
 * It would be a finding. The honest instrument for it is `docker compose
 * config`, which these gates cannot run — they have no Docker socket by design
 * and `gate:toolbox` §6 asserts its absence during a gate run — so the
 * comparison is a per-ticket measurement, not a gate.
 *
 * A UNIVERSAL IS ONLY AS WIDE AS THE PARSE IT IS COMPUTED FROM. That sentence
 * is in `T-037` § Published contract §1 because of this file.
 */
import { parseDocument } from 'yaml';

export interface ComposeParse {
  /** The document, read as compose reads it. `null` means FAIL CLOSED. */
  readonly doc: Record<string, unknown> | null;
  /** Diagnostics the caller must push onto its failure list. */
  readonly problems: readonly string[];
  /** True when both readings agreed and the file was read. */
  readonly versionAgreed: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first few paths at which two readings of the same file disagree. */
function divergences(a: unknown, b: unknown, at: string, out: string[]): void {
  if (out.length >= 4) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const bothArr = Array.isArray(a) && Array.isArray(b);
  const bothObj = isRecord(a) && isRecord(b);
  if (bothArr || bothObj) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      divergences(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${at}.${k}`,
        out,
      );
    }
    return;
  }
  out.push(
    `${at || '(root)'}: YAML 1.2 reads ${JSON.stringify(a)}, YAML 1.1 reads ${JSON.stringify(b)}`,
  );
}

/** Read a compose file the way Docker Compose reads it, or fail closed. */
export function parseCompose(rel: string, text: string): ComposeParse {
  const problems: string[] = [];
  const fail = (): ComposeParse => ({ doc: null, problems, versionAgreed: false });

  // A1. `merge: true` on BOTH readings: compose resolves `<<`, so an x-
  // fragment is a legitimate spelling and is modelled rather than refused.
  const d12 = parseDocument(text, { merge: true, logLevel: 'silent' });
  const d11 = parseDocument(text, { version: '1.1', merge: true, logLevel: 'silent' });

  // A7.
  for (const d of [d12, d11]) {
    for (const e of d.errors) problems.push(`${rel} is not parseable YAML: ${e.message}`);
  }
  if (problems.length > 0) return fail();

  // A6. Derived from the READER: anything it cannot resolve is a construct
  // this gate does not model, and an unmodelled construct must fail rather
  // than be silently dropped to a default value.
  const warned = new Set<string>();
  for (const d of [d12, d11]) {
    for (const w of d.warnings) warned.add(w.message.split('\n')[0] ?? w.message);
  }
  for (const w of warned) {
    problems.push(
      `${rel}: this gate's YAML reader could not resolve a construct in it — ${w}. ` +
        `Compose may resolve it, and this gate would then be reading a different file ` +
        `from the one that gets built (OD-39). Compose Spec tags such as !reset and ` +
        `!override are refused here rather than silently dropped to a default: teach ` +
        `this gate the construct before using it.`,
    );
  }
  if (problems.length > 0) return fail();

  const parsed: unknown = d12.toJS();
  if (!isRecord(parsed)) {
    problems.push(`${rel} did not parse to a mapping — refusing to report a pass on it`);
    return fail();
  }

  // A2-A5. The property is about the FILE, not about the reader: a composed
  // file must not mean two different things to two YAML versions, because no
  // reading of it can then be trusted to be compose's. The repair is to quote
  // the scalar, which changes nothing for compose.
  const diffs: string[] = [];
  divergences(parsed, d11.toJS(), '', diffs);
  if (diffs.length > 0) {
    problems.push(
      `${rel} means something DIFFERENT under YAML 1.1 and YAML 1.2, so no reading of it ` +
        `can be trusted to be the one Docker Compose takes: ${diffs.join('; ')}. ` +
        `This is OD-39's class — 'on'/'yes'/'off' are booleans in 1.1 and strings in 1.2, ` +
        `'0777' is 511 in 1.1 and 777 in 1.2, '12:30' is 750 in 1.1 and a string in 1.2, ` +
        `and a bare '.' is null in 1.1 and '.' in 1.2. Quote the value. (Merge keys are ` +
        `NOT this: both readings resolve '<<', so an x- fragment is fine.)`,
    );
    return fail();
  }

  // B2. `include:` pulls whole compose files in; nothing here follows it.
  if ('include' in parsed) {
    problems.push(
      `${rel} uses the top-level 'include:' key, which this gate does not follow — the ` +
        `included file may declare services, builds, ports and networks it never reads. ` +
        `Wire the file into scripts/svc's compose_files_for() instead, where it is part ` +
        `of the derived set (OD-37), or teach this gate to resolve 'include:' first.`,
    );
    return fail();
  }

  // B1. `extends:` names a service, possibly in another file. T-017 §R5 ruled
  // this a hard failure in gate:egress-boundary; OD-39's lesson is that the
  // ruling belonged at the PARSE, where every reader gets it.
  const services = parsed['services'];
  if (isRecord(services)) {
    for (const [name, svc] of Object.entries(services)) {
      if (isRecord(svc) && 'extends' in svc) {
        problems.push(
          `${rel}: service '${name}' uses 'extends', which this gate cannot follow — the ` +
            `inherited definition may carry a build:, a ports: key or a networks: key ` +
            `this gate never sees. Teach the gate to resolve 'extends' before using it ` +
            `here. (An unmodelled compose feature FAILS; it is never passed — T-017 §R5.)`,
        );
      }
    }
  }
  if (problems.length > 0) return fail();

  return { doc: parsed, problems, versionAgreed: true };
}
