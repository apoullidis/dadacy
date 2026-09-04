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
