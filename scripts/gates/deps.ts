/**
 * gate:deps — dependency-cruiser. SD §DH-1: "Module boundaries are enforced at
 * build time (SA SA-2): dependency-cruiser rules fail CI on a cross-module
 * import that does not go through a published module interface, and on any
 * import from apps/admin/components into apps/web."
 *
 * T-001 wires the tool and proves it blocks. The module-boundary RULE SET is
 * T-002's — see .dependency-cruiser.cjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, bin, stream, finish } from './lib/run.ts';

const failures: string[] = [];

const roots = ['apps', 'packages', 'scripts'].filter((d) => fs.existsSync(path.join(REPO_ROOT, d)));
console.log(`$ depcruise --config .dependency-cruiser.cjs ${roots.join(' ')}`);
const code = stream(bin('depcruise'), ['--config', '.dependency-cruiser.cjs', ...roots]);
if (code !== 0) failures.push(`dependency-cruiser exited ${String(code)}`);

finish('gate:deps', failures);
