/**
 * `node test/fixtures/fault-server.ts` — the real `startServer` (filter, drain,
 * healthz) with `FaultModule`'s test-only routes, on 127.0.0.1 and an
 * ephemeral port, which it announces as `[core] listening on 127.0.0.1:<port>`.
 */
import { startServer } from '../../src/server.ts';
import { FaultModule } from './faults.ts';

await startServer({ module: FaultModule, port: 0, host: '127.0.0.1' });
