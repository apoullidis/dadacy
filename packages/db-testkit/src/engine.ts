/**
 * A minimal Docker Engine API client over the unix socket.
 *
 * WHY NOT THE `testcontainers` npm PACKAGE. `DOCKER.md` §1 names the
 * *mechanism* — "a disposable database per suite, created and destroyed by the
 * test process" — not a library. The npm package brings `dockerode`, a
 * transitive tree, and a second container (`ryuk`) whose image nobody in this
 * programme has pinned; `DOCKER.md` §1's last line says the Postgres tag is
 * published once and "nothing else declares it", and a reaper image would be a
 * second undeclared pin. The five calls we need are `POST /networks/create`,
 * `POST /containers/create`, `POST /containers/{id}/start`,
 * `POST /networks/{id}/connect` and two deletes. That is this file, with no
 * dependency and no second image.
 *
 * OD-16. This talks to `/var/run/docker.sock`, which `scripts/dev` and
 * `scripts/svc run` DO NOT MOUNT — measured, see `state/EP-QA/T-115.md`. The
 * diagnostic below is deliberately long: an unmounted socket surfaces as
 * `ENOENT` and a mounted-but-ungrouped socket surfaces as `EACCES`, and both
 * read as "the harness is broken" rather than "the toolbox cannot reach the
 * daemon".
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';

export const DOCKER_SOCKET = '/var/run/docker.sock';

export class DockerUnavailableError extends Error {
  constructor(cause: string) {
    super(
      [
        `the Docker daemon is not reachable from this container: ${cause}`,
        '',
        'Testcontainers is the mandated mechanism for constraint and invariant',
        'suites (DOCKER.md §1) and it needs the daemon. The toolbox does not get',
        'it today — recorded as OD-16 in tasks/state/decisions.md.',
        '',
        'The fix is two flags on the `docker run` in scripts/lib/toolbox.sh, and',
        'it is platform-infrastructure’s file (T-016 § Published contract §9):',
        '',
        `    --volume ${DOCKER_SOCKET}:${DOCKER_SOCKET} \\`,
        `    --group-add "$(stat -c %g ${DOCKER_SOCKET})"`,
        '',
        'BOTH are required and the second is the one that gets forgotten. The',
        'socket is root:docker mode 660 and the toolbox runs as the invoking',
        'uid:gid, which is not in that group: mounting alone was measured to give',
        'EACCES on this host, and the cheapest wrong repair for that is running',
        'the toolbox as root, which would undo T-000’s file-ownership property.',
      ].join('\n'),
    );
    this.name = 'DockerUnavailableError';
  }
}

interface EngineResponse {
  readonly status: number;
  readonly body: string;
}

function request(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<EngineResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { socketPath: DOCKER_SOCKET, method, path, headers, timeout: timeoutMs },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: text });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Engine API timeout after ${String(timeoutMs)}ms on ${path}`));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'ECONNREFUSED') {
        reject(new DockerUnavailableError(`${err.code} on ${DOCKER_SOCKET}`));
        return;
      }
      reject(err);
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function ok(res: EngineResponse, what: string): EngineResponse {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `docker: ${what} failed (HTTP ${String(res.status)}): ${res.body.slice(0, 600)}`,
    );
  }
  return res;
}

function parse(res: EngineResponse, what: string): unknown {
  return JSON.parse(ok(res, what).body) as unknown;
}

/**
 * Fail fast, with the OD-16 diagnostic, before a suite creates anything.
 * `fs.statSync` distinguishes "no socket at all" from "socket present but the
 * process cannot open it"; the `/_ping` that follows distinguishes both from a
 * dead daemon.
 */
export async function assertDockerAvailable(): Promise<void> {
  try {
    fs.statSync(DOCKER_SOCKET);
  } catch (err) {
    throw new DockerUnavailableError(
      `${(err as NodeJS.ErrnoException).code ?? 'stat failed'} — the socket is not mounted into this container`,
    );
  }
  const res = await request('GET', '/_ping', undefined, 10_000);
  if (res.status !== 200)
    throw new DockerUnavailableError(`GET /_ping returned ${String(res.status)}`);
}

export interface CreatedNetwork {
  readonly id: string;
  readonly name: string;
}

/**
 * An `internal: true` bridge, per suite. Internal on purpose: the cluster this
 * network carries must have no route off the host, exactly as `compose.yml`'s
 * `kinvara-int` does (`DOCKER.md` §7). A harness that put its database on a
 * default bridge would hand a test process the egress the compose stack spends
 * a whole gate denying it.
 */
export async function createInternalNetwork(name: string): Promise<CreatedNetwork> {
  const res = parse(
    await request('POST', '/networks/create', {
      Name: name,
      Driver: 'bridge',
      Internal: true,
      CheckDuplicate: true,
      Labels: { 'io.kinvara.dbtestkit': '1', 'io.kinvara.egress': 'denied' },
    }),
    `create network ${name}`,
  ) as { Id: string };
  return { id: res.Id, name };
}

export async function removeNetwork(id: string): Promise<void> {
  await request('DELETE', `/networks/${id}`);
}

export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly env: readonly string[];
  readonly cmd?: readonly string[];
  readonly networkId: string;
  readonly networkAlias: string;
  readonly memoryBytes: number;
  readonly nanoCpus: number;
}

export async function createAndStartContainer(spec: ContainerSpec): Promise<string> {
  const created = parse(
    await request(`POST`, `/containers/create?name=${encodeURIComponent(spec.name)}`, {
      Image: spec.image,
      Env: [...spec.env],
      ...(spec.cmd === undefined ? {} : { Cmd: [...spec.cmd] }),
      Labels: { 'io.kinvara.dbtestkit': '1' },
      HostConfig: {
        Memory: spec.memoryBytes,
        NanoCpus: spec.nanoCpus,
        AutoRemove: false,
        // No PortBindings, ever. A ticket-scoped project publishes no host
        // port (OD-4) and neither does a harness cluster: the test process
        // reaches it by container alias on the suite's own network.
        NetworkMode: spec.networkId,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [spec.networkId]: { Aliases: [spec.networkAlias] },
        },
      },
    }),
    `create container ${spec.name}`,
  ) as { Id: string };
  ok(await request('POST', `/containers/${created.Id}/start`), `start container ${spec.name}`);
  return created.Id;
}

export async function removeContainer(id: string): Promise<void> {
  await request('DELETE', `/containers/${id}?force=true&v=true`);
}

export async function containerLogs(id: string): Promise<string> {
  const res = await request('GET', `/containers/${id}/logs?stdout=true&stderr=true&tail=60`);
  return res.body;
}

/**
 * The id of the container this process is running in.
 *
 * Docker sets the container hostname to the short id unless `--hostname` is
 * given, and neither `scripts/dev` nor `scripts/svc run` gives one. The value
 * is then CONFIRMED against the daemon rather than trusted: if the inspect
 * fails we are not in a container the daemon knows about, and attaching the
 * cluster to "our" network would silently produce an unreachable database.
 */
export async function selfContainerId(): Promise<string> {
  const hostname = os.hostname();
  const res = await request('GET', `/containers/${hostname}/json`);
  if (res.status !== 200) {
    throw new Error(
      `db-testkit must run inside a container the daemon knows: GET /containers/${hostname}/json ` +
        `returned ${String(res.status)}. Run the suite under scripts/dev or scripts/svc run.`,
    );
  }
  return (JSON.parse(res.body) as { Id: string }).Id;
}

export async function connectSelfToNetwork(networkId: string, containerId: string): Promise<void> {
  ok(
    await request('POST', `/networks/${networkId}/connect`, { Container: containerId }),
    'connect the test process to the suite network',
  );
}

export async function disconnectSelfFromNetwork(
  networkId: string,
  containerId: string,
): Promise<void> {
  await request('POST', `/networks/${networkId}/disconnect`, {
    Container: containerId,
    Force: true,
  });
}

/** Is the image already on the daemon? A harness never pulls silently. */
export async function imagePresent(image: string): Promise<boolean> {
  const res = await request('GET', `/images/${encodeURIComponent(image)}/json`);
  return res.status === 200;
}
