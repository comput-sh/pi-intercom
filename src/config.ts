import { mkdir, readFile, realpath, rename, unlink, open, link, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Agent {
  sessionId: string;
  name: string;
  coordinator: boolean;
  description: string;
  port: number;
  projectDirectory: string;
}
export interface Config { version: 1; multiplexer: 'herdr' | 'none'; agents: Agent[] }
export const DEFAULT_DESCRIPTION = 'Coordinate workers, delegate work, and manage shared configuration.';
export const key = (name: string) => name.toLowerCase();
export function fail(message: string): never { throw new Error(`PiIntercom: ${message}`); }
export function text(value: unknown, field: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(`invalid ${field}`);
}
export function port(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) fail('invalid port');
}
export function relativeDirectory(value: unknown): asserts value is string {
  text(value, 'projectDirectory');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.split(/[\\/]/).includes('..')) fail('projectDirectory must be root-relative, without ..');
}
export function validateConfig(value: unknown): Config {
  const c = value as Config;
  if (!c || c.version !== 1 || !['herdr', 'none'].includes(c.multiplexer) || !Array.isArray(c.agents)) fail('invalid config schema/version');
  const names = new Set<string>(), ids = new Set<string>();
  for (const a of c.agents) {
    if (!a || typeof a.coordinator !== 'boolean') fail('invalid agent');
    text(a.sessionId, 'sessionId', 256); text(a.name, 'name', 128); text(a.description, 'description');
    if (a.name !== a.name.trim() || /[\r\n\x00-\x1f]/.test(a.name)) fail('invalid name');
    port(a.port); relativeDirectory(a.projectDirectory);
    if (names.has(key(a.name)) || ids.has(a.sessionId)) fail('duplicate name or session ID');
    names.add(key(a.name)); ids.add(a.sessionId);
    if (a.coordinator ? (a.name !== 'Coordinator' || a.projectDirectory !== '.') : key(a.name) === 'coordinator') fail('reserved Coordinator identity');
  }
  if (c.agents.filter(a => a.coordinator).length !== 1) fail('config requires exactly one coordinator');
  return c;
}
export const coordinator = (c: Config) => c.agents.find(a => a.coordinator)!;
export function named(c: Config, name: string): Agent {
  text(name, 'to', 128);
  return c.agents.find(a => key(a.name) === key(name)) ?? fail(`unknown recipient ${name}`);
}
export function requireCoordinator(c: Config, id: string): Agent {
  const a = c.agents.find(a => a.sessionId === id);
  return a?.coordinator ? a : fail('coordinator permission required');
}
export async function directory(root: string, requested: string): Promise<string> {
  text(requested, 'projectDirectory');
  const base = await realpath(root), target = await realpath(path.resolve(root, requested));
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('project directory must be coordinator root or descendant (including symlinks)');
  if (!(await stat(target)).isDirectory()) fail('projectDirectory is not a directory');
  return rel.split(path.sep).join('/') || '.';
}
export class ConfigStore {
  readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) { this.file = path.join(root, '.pi-intercom', 'config.json'); }
  async read(): Promise<Config> {
    // Missing, malformed and unreadable files propagate; never overwrite them.
    return validateConfig(JSON.parse(await readFile(this.file, 'utf8')));
  }
  static async discover(cwd: string): Promise<ConfigStore | undefined> {
    let at = path.resolve(cwd);
    for (;;) {
      const store = new ConfigStore(at);
      try { await store.read(); return store; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = path.dirname(at); if (parent === at) return undefined; at = parent;
    }
  }
  private async temporary(config: Config): Promise<string> {
    validateConfig(config);
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(config, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    return temp;
  }
  async initialize(id: string, boundPort: number): Promise<boolean> {
    // Publish an already complete file using an atomic, no-replace hard link.
    // Losers only ever see complete JSON; unsupported filesystems fail explicitly.
    const temp = await this.temporary({ version: 1, multiplexer: 'herdr', agents: [{ sessionId: id, name: 'Coordinator', coordinator: true, description: DEFAULT_DESCRIPTION, port: boundPort, projectDirectory: '.' }] });
    try { await link(temp, this.file); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') { await this.read(); return false; } throw e; }
    finally { await unlink(temp); }
  }
  async update(id: string, mutate: (config: Config) => void | Promise<void>): Promise<Config> {
    const operation = this.tail.then(async () => {
      const c = await this.read(); requireCoordinator(c, id);
      await mutate(c); validateConfig(c);
      const temp = await this.temporary(c);
      try { await rename(temp, this.file); }
      finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      return c;
    });
    this.tail = operation.catch(() => {}); return operation;
  }
  async configure(id: string, values: Omit<Agent, 'coordinator'>): Promise<Config> {
    return this.update(id, async c => {
      if (values.sessionId === coordinator(c).sessionId) fail('cannot configure coordinator as worker');
      const projectDirectory = await directory(this.root, values.projectDirectory);
      const a: Agent = { sessionId: values.sessionId, name: values.name, description: values.description, port: values.port, projectDirectory, coordinator: false };
      const index = c.agents.findIndex(old => old.sessionId === a.sessionId);
      if (index < 0) c.agents.push(a); else c.agents[index] = a;
    });
  }
}
