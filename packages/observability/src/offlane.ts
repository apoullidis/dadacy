/**
 * THE COLLECTOR'S NAME IS RESOLVED OFF LIBUV'S DNS LANE (T-205, OD-230).
 *
 * WHY. `fetch` (and any `http.request` without a `lookup` option) resolves a
 * host name with `dns.lookup`, which is `getaddrinfo` on libuv's thread pool.
 * libuv lets at most ceil(n/2) pool threads run it at once, n being the pool
 * size (OD-229): 2 of the default 4. Node cannot cancel a `getaddrinfo`, so an
 * export abandoned at its deadline leaves its lookup holding a lane until the
 * resolver gives up. T-204 bounded how many exports start; it could not bound
 * how long each leftover lookup stalls. With a resolver that stalls a failing
 * collector lookup 30 s, two of them overlapped, every other lookup in `core`
 * (the HIBP check's, `pg`'s) queued behind them, and a breached password was
 * accepted (state/EP-1/T-204.md QA Q8; state/EP-1/T-205.md E2, E3).
 *
 * WHAT THIS DOES. The exporter's own transport resolves the collector with
 * `dns.Resolver` (c-ares), which sends DNS queries from the event loop and
 * does not use the thread pool (Node's `dns` docs). A stalled query here
 * therefore holds no lane. Each resolution gets its own `Resolver`, and its
 * query is cancelled when the export's deadline aborts (case `an aborted
 * resolution cancels its c-ares query and rejects`). That cancellation is what
 * bounds the query. No case holds the `Resolver`'s own `timeout`/`tries`
 * settings (QA's mutant S4, a default `Resolver`, passes every case), and the
 * bound does not need them: the export deadline cancels the query whatever
 * they are. `localhost` and IP literals are answered without a query.
 *
 * WHAT IT COSTS, stated rather than hidden:
 *   - c-ares sends a DNS query. It does NOT read `/etc/hosts`, and it does not
 *     apply `resolv.conf`'s `search` list. A collector name that exists only in
 *     `/etc/hosts`, or only as a short name completed by a search domain, does
 *     not resolve. The export then fails as `export_network` and its spans are
 *     dropped and counted. The request path is not affected. `localhost` is the
 *     one hosts-file name answered here, as 127.0.0.1 (RFC 6761) and ONLY
 *     127.0.0.1: a collector listening only on `::1` is not reached.
 *   - Only the address of the FIRST A record is used (AAAA if there is no A).
 *   - Nothing is cached. A new connection resolves again. The HTTP agent keeps
 *     connections alive, so a healthy collector costs a query per new
 *     connection, not per export.
 *   - This covers the exporter's own lookups only. Every other name lookup in
 *     the process still uses `getaddrinfo` and the lane. OD-125's other half
 *     (HIBP itself unreachable) is not touched (OD-229).
 */
import { Resolver } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolve a host name for the exporter. Must not use `dns.lookup`. */
export type ResolveHost = (
  hostname: string,
  signal: AbortSignal,
  timeoutMs: number,
) => Promise<ResolvedAddress>;

/** POST `body` to `url`; resolve with the HTTP status. */
export type Transport = (url: string, body: string, signal: AbortSignal) => Promise<number>;

const NO_ADDRESS = new Set(['ENODATA', 'ENOTFOUND']);

/**
 * c-ares resolution: an IP literal is returned as it is, `localhost` is
 * 127.0.0.1, anything else is an A query and then, if there is no A record, an
 * AAAA query. Aborting `signal` cancels the query.
 */
export const resolveOffLane: ResolveHost = (hostname, signal, timeoutMs) => {
  const bare = hostname.replace(/^\[(.*)\]$/, '$1');
  const literal = isIP(bare);
  if (literal === 4 || literal === 6) return Promise.resolve({ address: bare, family: literal });
  if (bare.toLowerCase() === 'localhost')
    return Promise.resolve({ address: '127.0.0.1', family: 4 });
  if (signal.aborted) return Promise.reject(new Error('aborted before resolution'));
  const resolver = new Resolver({ timeout: Math.max(1, Math.floor(timeoutMs)), tries: 1 });
  return new Promise<ResolvedAddress>((resolve, reject) => {
    let settled = false;
    const settle = (error: Error | null, value?: ResolvedAddress): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (value !== undefined) resolve(value);
      else reject(error ?? new Error('no address'));
    };
    function onAbort(): void {
      resolver.cancel();
      settle(new Error('resolution aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
    resolver.resolve4(bare, (error4, addresses4) => {
      const first4 = addresses4?.[0];
      if (error4 === null && first4 !== undefined) {
        settle(null, { address: first4, family: 4 });
        return;
      }
      if (signal.aborted || (error4 !== null && !NO_ADDRESS.has(error4.code ?? ''))) {
        settle(error4);
        return;
      }
      resolver.resolve6(bare, (error6, addresses6) => {
        const first6 = addresses6?.[0];
        if (error6 === null && first6 !== undefined) settle(null, { address: first6, family: 6 });
        else settle(error6);
      });
    });
  });
};

/**
 * The exporter's default transport: `node:http`/`node:https` with a `lookup`
 * that calls `resolveHost`, so the connection never reaches `getaddrinfo`.
 * TLS still verifies against the URL's host name, because only the address
 * lookup is replaced.
 */
export function offLaneTransport(resolveHost: ResolveHost, resolveTimeoutMs: number): Transport {
  return (url, body, signal) =>
    new Promise<number>((resolve, reject) => {
      const target = new URL(url);
      const lookup: LookupFunction = (hostname, options, callback) => {
        resolveHost(hostname, signal, resolveTimeoutMs).then(
          ({ address, family }) => {
            if (options.all === true) callback(null, [{ address, family }]);
            else callback(null, address, family);
          },
          (error: unknown) => {
            callback(error instanceof Error ? error : new Error('resolution failed'), '', 4);
          },
        );
      };
      const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const outgoing = request(
        target,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          signal,
          lookup,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
}
