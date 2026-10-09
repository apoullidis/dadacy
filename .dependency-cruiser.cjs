/**
 * Kinvara dependency-cruiser configuration.
 *
 * OWNERSHIP: T-001 wires the tool, proves it blocks, and ships the baseline
 * rules below. **The module-boundary rule set is T-002's** (SA §SA-2, SD §DH-1):
 * "fail CI on any cross-module import not through a published module interface,
 * and on any import from apps/admin/components into apps/web". Those rules
 * cannot be written yet — there are no modules to name. T-002 adds them here.
 *
 * platform-infrastructure.md, "You do not touch": the CONTENT of a gate's rule
 * set belongs to its owning agent; platform-infra owns the fact that the gate
 * runs and blocks.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A circular import is a module boundary that was not thought through. It also breaks ' +
        'the deterministic initialisation order the policy and crypto packages depend on.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'An import that does not resolve. Usually a typo or a dependency that was never declared.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-dev-dep-in-src',
      severity: 'error',
      comment:
        'Application source must not import a devDependency — it will be absent from the ' +
        'production image and the failure will surface at deploy time.',
      from: { path: '^(apps|packages)/[^/]+/src', pathNot: '\\.(spec|test)\\.[cm]?tsx?$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-duplicate-dep-types',
      severity: 'error',
      comment: 'A dependency declared in more than one section of package.json.',
      from: {},
      to: { moreThanOneDependencyType: true, dependencyTypesNot: ['type-only'] },
    },
    // T-244 (OD-292a, CUT-OD-292 §1). Each deployable image carries its OWN app directory and
    // nothing of any other app (`docker/app.Dockerfile` runtime stage; T-242 E14: the worker image
    // holds /srv/kinvara/apps/worker only). So an import from one app into another typechecks and
    // lints in the toolbox and fails at import time in the image (T-242 § QA Q10). Shared code
    // reaches a second app through a `packages/*` workspace package (OD-292a, EV-30), never
    // through `../../<other-app>/…`. These two rules and the manifest rule in scripts/gates/deps.ts
    // (`no-app-package-dependency`) are T-244's; they are NOT T-002's cross-MODULE rules (SA §SA-2),
    // which T-002 adds beside them without restating them.
    //
    // `$1` is dependency-cruiser's group substitution: the first capture group of `from.path`
    // (the source module's app directory) is substituted into `to.pathNot`, so a module may
    // resolve into its OWN app and into no other. Measured to bind: T-244 evidence, and cases
    // R1/R5 (red) against C2 (core -> its own ./identity, green) in
    // scripts/negative-tests/deps-cross-app.sh.
    //
    // NOT SEEN by either rule, stated as bounds (T-244 § Published contract): an import whose
    // specifier is not a literal (`import(x)`, `createRequire(...)(computed)`), and code loaded
    // by a runtime flag (`node --import …` in a start script) rather than by an import.
    {
      name: 'no-cross-app-import',
      severity: 'error',
      comment:
        'T-244 rule (1): a module under apps/<a>/ resolves to a path under apps/<b>/, b != a. ' +
        'Each image carries only its own app, so this fails at import time in the image ' +
        '(OD-292, T-242 Q10). Move the shared code to a packages/* workspace package (OD-292a).',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/[^/]+/', pathNot: '^apps/$1/' },
    },
    {
      name: 'no-package-to-app-import',
      severity: 'error',
      comment:
        'T-244 rule (2): a module under packages/ resolves to a path under apps/. A package is ' +
        'shared code; an app is a deployable, and no image but its own carries it (OD-292a).',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'placeholder-module-boundaries',
      severity: 'info',
      comment:
        'T-002 replaces this with the real SA §SA-2 boundary rules. It is an `info` marker so ' +
        '`depcruise --config` prints a reminder rather than a green result that means nothing.',
      from: { path: '^__t002_not_yet_written__$' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|build|out|\\.next|\\.turbo|coverage|\\.cache)(/|$)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.d.ts'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
