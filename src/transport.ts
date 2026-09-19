import http from 'node:http';
import { fail, port, text } from './config.js';

export const BODY_LIMIT = 64 * 1024;
export const RECEIPT_TIMEOUT = 5000;
export type Kind = 'message' | 'registration' | 'status' | 'request_status' | 'reload' | 'stop' | 'close';
export interface Envelope {
  version: 1;
  kind: Kind;
  from: string;
  to: string;
  payload: Record<string, unknown>;
}
export function envelope(value: unknown): Envelope {
  const m = value as Envelope;
  if (!m || m.version !== 1 || !['message', 'registration', 'status', 'request_status', 'reload', 'stop', 'close'].includes(m.kind)) fail('invalid wire schema/version/kind');
  text(m.from, 'sender sessionId', 256); text(m.to, 'recipient sessionId', 256);
  if (!m.payload || Array.isArray(m.payload) || typeof m.payload !== 'object') fail('invalid payload');
  if (m.kind === 'message') text(m.payload.message, 'message', 48000);
  if (m.kind === 'registration' || m.kind === 'status') port(m.payload.port);
  if (m.kind === 'registration') text(m.payload.projectDirectory, 'projectDirectory');
  if (m.kind === 'status' && typeof m.payload.busy !== 'boolean') fail('invalid busy flag');
  return m;
}
export interface Endpoint { port: number; close(): Promise<void> }
export async function listen(preferred: number | undefined, accept: (message: Envelope) => Promise<void>): Promise<Endpoint> {
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, data: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(data)); } };
    if (req.method !== 'POST' || req.url !== '/intercom') { reply(404, { error: 'POST /intercom required' }); req.resume(); return; }
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > BODY_LIMIT) { reply(413, { error: 'body exceeds 64 KiB' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      await accept(envelope(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      reply(202, { accepted: true });
    } catch (error) { reply(400, { error: String(error) }); }
  });
  server.requestTimeout = RECEIPT_TIMEOUT;
  server.headersTimeout = RECEIPT_TIMEOUT;
  server.setTimeout(RECEIPT_TIMEOUT, socket => socket.destroy());
  const bind = (p: number) => new Promise<void>((resolve, reject) => {
    const error = (e: Error) => { server.off('listening', ready); reject(e); };
    const ready = () => { server.off('error', error); resolve(); };
    server.once('error', error); server.once('listening', ready); server.listen(p, '127.0.0.1');
  });
  try { await bind(preferred ?? 0); }
  catch (e) { if (preferred && (e as NodeJS.ErrnoException).code === 'EADDRINUSE') await bind(0); else throw e; }
  const address = server.address();
  if (!address || typeof address === 'string') fail('listener has no port');
  return { port: address.port, close: () => new Promise((resolve, reject) => {
    server.close(e => e ? reject(e) : resolve()); server.closeAllConnections();
  }) };
}
export async function send(destinationPort: number, message: Envelope, timeout = RECEIPT_TIMEOUT): Promise<void> {
  port(destinationPort); envelope(message);
  const body = JSON.stringify(message);
  if (Buffer.byteLength(body) > BODY_LIMIT) fail('message exceeds 64 KiB');
  // Node HTTP bypasses proxy environment variables; never redirects or retries.
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: destinationPort, path: '/intercom', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let result = '';
      res.on('data', chunk => { result += chunk; if (result.length > BODY_LIMIT) req.destroy(new Error('oversized acknowledgment')); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          if (res.statusCode !== 202 || JSON.parse(result).accepted !== true) fail(`receipt rejected (${res.statusCode}): ${result}`);
          resolve();
        } catch (e) { reject(e); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('PiIntercom: receipt timeout; outcome unknown; no automatic retry')), timeout);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(body);
  });
}
