/**
 * A raw HTTP/1.1 GET over a TCP socket, so the request target reaches the server
 * BYTE FOR BYTE. `fetch` and `URL` may normalise a path before sending it; QA-F1's
 * malformed percent-encodings (T-135 § QA verification, QA-8) are only a test if
 * they arrive unmodified, which is also how QA sent them.
 *
 * A timeout is REJECTED, never read as a response, so "the server answered nothing"
 * (OD-103's hung middleware) is a distinct, failing outcome.
 */
import net from 'node:net';

export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function decodeChunked(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = raw.indexOf('\r\n', at, 'latin1');
    if (lineEnd < 0) throw new TypeError('rawGet: truncated chunked body');
    const size = Number.parseInt(raw.subarray(at, lineEnd).toString('latin1'), 16);
    if (!Number.isInteger(size)) throw new TypeError('rawGet: bad chunk size');
    if (size === 0) return Buffer.concat(parts);
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
}

function parse(raw: Buffer): RawResponse {
  const split = raw.indexOf('\r\n\r\n', 0, 'latin1');
  if (split < 0) throw new TypeError('rawGet: no complete response head');
  const [statusLine = '', ...headerLines] = raw.subarray(0, split).toString('latin1').split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
  if (!Number.isInteger(status)) throw new TypeError('rawGet: no status line');
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const rest = raw.subarray(split + 4);
  const body = headers['transfer-encoding'] === 'chunked' ? decodeChunked(rest) : rest;
  return { status, headers, body: body.toString('utf8') };
}

export function rawGet(base: string, path: string, timeoutMs = 5000): Promise<RawResponse> {
  const url = new URL(base);
  const port = Number(url.port === '' ? '80' : url.port);
  const request = `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect({ host: url.hostname, port }, () => {
      socket.write(request, 'latin1');
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new TypeError(`rawGet: NO RESPONSE within ${String(timeoutMs)} ms`));
    });
    socket.on('data', (d: Buffer) => chunks.push(d));
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        resolve(parse(Buffer.concat(chunks)));
      } catch (thrown) {
        reject(thrown instanceof Error ? thrown : new TypeError('rawGet: parse failed'));
      }
    });
  });
}
