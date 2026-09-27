import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export type ReportStatus = 'blocked' | 'needs_decision' | 'ready_for_review' | 'clear';
export interface WorkerReport {
  version: 1;
  sessionId: string;
  status: ReportStatus;
  summary: string;
  updatedAt: string;
}
const MAX_BYTES = 8 * 1024;
const MAX_IDS = 256;
const statuses = new Set<ReportStatus>(['blocked', 'needs_decision', 'ready_for_review', 'clear']);
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 256 && id.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(id);
}
function validate(value: unknown): WorkerReport | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !validId(v.sessionId) || !statuses.has(v.status as ReportStatus)) return;
  if (typeof v.summary !== 'string' || v.summary.length > 2000 || controls.test(v.summary)) return;
  if (v.status === 'clear' ? v.summary !== '' : !v.summary.trim()) return;
  if (typeof v.updatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.updatedAt)) return;
  const timestamp = Date.parse(v.updatedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== v.updatedAt) return;
  return { version: 1, sessionId: v.sessionId, status: v.status as ReportStatus, summary: v.summary, updatedAt: v.updatedAt };
}
function filename(id: string): string {
  return `${createHash('sha256').update(id).digest('hex')}.json`;
}
/** Reject links at the root and both extension-owned directory components. */
async function directory(root: string, create: boolean, assertCurrent?: () => void): Promise<string> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error('unsafe root');
  let current = await realpath(root);
  for (const segment of ['.pi-intercom', 'reports']) {
    current = path.join(current, segment);
    if (create) {
      assertCurrent?.();
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(current, await realpath(current)) !== '') throw new Error('unsafe directory');
  }
  return current;
}
async function regularOrAbsent(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe file');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Persist only the explicitly authored public report; clear is an atomic tombstone. */
export async function saveWorkerReport(root: string, report: WorkerReport, assertCurrent?: () => void): Promise<void> {
  let temporary: string | undefined;
  let ownsTemporary = false;
  let dir: string | undefined;
  try {
    const safe = validate(report);
    if (!safe) throw new Error('invalid report');
    const content = JSON.stringify(safe) + '\n';
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('oversized report');
    assertCurrent?.();
    dir = await directory(root, true, assertCurrent);
    const target = path.join(dir, filename(safe.sessionId));
    await regularOrAbsent(target);
    temporary = path.join(dir, `.${filename(safe.sessionId)}.${randomUUID()}.tmp`);
    assertCurrent?.();
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    ownsTemporary = true;
    try { assertCurrent?.(); await handle.writeFile(content, 'utf8'); }
    finally { await handle.close(); }
    if (await directory(root, false) !== dir) throw new Error('directory changed');
    await regularOrAbsent(target);
    assertCurrent?.();
    await rename(temporary, target);
    temporary = undefined;
  } catch { throw new Error('Worker report could not be saved.'); }
  finally {
    if (temporary && ownsTemporary && dir) {
      // Cleanup only our own unpublished temporary file, even if authorization expired.
      try { if (await directory(root, false) === dir) await unlink(temporary); } catch { /* No raw filesystem errors or unsafe cleanup. */ }
    }
  }
}

/** Read at most 256 configured IDs; no directory scan, repair, transport, or host access. */
export async function readWorkerReports(root: string, sessionIds: readonly string[]): Promise<WorkerReport[]> {
  const reports: WorkerReport[] = [];
  let dir: string;
  try { dir = await directory(root, false); } catch { return reports; }
  const seen = new Set<string>();
  for (const id of sessionIds.slice(0, MAX_IDS)) {
    if (!validId(id) || seen.has(id)) continue;
    seen.add(id);
    try {
      if (await directory(root, false) !== dir) break;
      const file = path.join(dir, filename(id));
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) continue;
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      let text: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) continue;
        // One extra byte detects concurrent growth, while keeping reads bounded.
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) continue;
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
      const report = validate(JSON.parse(text));
      if (report?.sessionId === id) reports.push(report);
    } catch { /* Missing, unsafe, malformed or concurrently replaced evidence is unavailable. */ }
  }
  return reports;
}
