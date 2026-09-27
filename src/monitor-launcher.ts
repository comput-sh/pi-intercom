import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { run, shQuote, psQuote, encoded, type Run } from './launcher.js';

interface Pane { pane_id: string; tab_id: string; workspace_id?: string; label?: string }
interface RecordState { version: 1; sessionId: string; workspace: string; caller: string; pane?: string; stage: string }
export interface MonitorLaunchOptions {
  root: string; sessionId: string; script: string;
  node?: string; platform?: string; env?: NodeJS.ProcessEnv; run?: Run;
  assertCurrent?(): void;
}
/** Pane ownership is separate from agent config. Pending records fence uncertain
 * mutations across reloads; neither errors nor absence of readiness cause retries. */
export async function ensureMonitorPane(options: MonitorLaunchOptions): Promise<{ outcome: string; pane?: string }> {
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== '1') return { outcome: 'unavailable: coordinator is not inside Herdr' };
  if (!env.HERDR_PANE_ID) throw new Error('Monitor requires caller pane identity; no focused-pane fallback');
  const platform = options.platform ?? process.platform;
  if (!['win32', 'linux'].includes(platform)) throw new Error('Monitor launcher supports Windows/Linux only');
  const exec = options.run ?? run;
  const check = () => options.assertCurrent?.();
  const call = async (args: string[]) => {
    check();
    const output = await exec('herdr', args);
    check();
    // pane run acknowledges command submission with an empty stdout on current Herdr.
    if (!output.trim() && args[1] === 'run') return {};
    return JSON.parse(output).result;
  };
  const caller = (await call(['pane', 'current', '--current']))?.pane as Pane;
  if (!caller?.pane_id || !caller.tab_id || !caller.workspace_id) throw new Error('Missing current Herdr pane identity');
  const label = 'Intercom monitor';
  const legacyMarker = `Intercom monitor [${options.sessionId}]`;
  const key = createHash('sha256').update(options.sessionId).digest('hex').slice(0, 24);
  const directory = path.join(options.root, '.pi-intercom');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `monitor-${key}.json`), lock = `${file}.lock`;
  check();
  try { await writeFile(lock, '', { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error(`Monitor launch locked; inspect ${lock} before recovery. No pane created.`); }
  let state: RecordState | undefined;
  const save = async () => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => {}); }
  };
  try {
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
      if (state?.version !== 1 || state.sessionId !== options.sessionId || typeof state.stage !== 'string') throw new Error('Invalid monitor ownership record');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const panes = (await call(['pane', 'list', '--workspace', caller.workspace_id]))?.panes as Pane[];
    if (!Array.isArray(panes) || panes.some(p => !p?.pane_id || !p.tab_id)) throw new Error('Invalid Herdr pane inventory');
    const matches = panes.filter(p => p.label === legacyMarker ||
      (state && state.workspace === caller.workspace_id && state.pane === p.pane_id));
    if (matches.length > 1) throw new Error('Multiple monitor markers; inspect panes. No automatic changes.');
    if (matches.length === 1) {
      const pane = matches[0];
      if (pane.pane_id === caller.pane_id || pane.tab_id !== caller.tab_id) throw new Error('Monitor marker is on caller or moved to another tab; no duplicate created');
      if (state && (state.workspace !== caller.workspace_id || state.caller !== caller.pane_id || (state.pane && state.pane !== pane.pane_id))) {
        throw new Error('Monitor ownership differs from current caller; no automatic changes');
      }
      if (state && !['submitted', 'observed'].includes(state.stage)) {
        throw new Error(`Monitor partial launch needs inspection (${state.stage}); no retry or duplicate`);
      }
      if (!state) {
        state = { version: 1, sessionId: options.sessionId, workspace: caller.workspace_id, caller: caller.pane_id, pane: pane.pane_id, stage: 'observed' };
        await save();
      }
      if (pane.label !== label) await call(['pane', 'rename', pane.pane_id, label]);
      return { outcome: 'existing pane preserved; process readiness not checked', pane: pane.pane_id };
    }
    if (panes.some(p => p.tab_id === caller.tab_id && p.label === label)) {
      throw new Error('Unowned monitor label in coordinator tab; inspect before creating another pane');
    }
    if (state && (!['submitted', 'observed'].includes(state.stage) || state.workspace !== caller.workspace_id || panes.some(p => p.pane_id === state!.pane))) {
      throw new Error(`Monitor ownership/partial launch needs inspection (${state.stage}, pane ${state.pane ?? 'unknown'}); no retry or duplicate`);
    }
    await access(options.script); // Missing build must not leave a new empty pane.
    check();
    state = { version: 1, sessionId: options.sessionId, workspace: caller.workspace_id, caller: caller.pane_id, stage: 'split_pending' };
    await save();
    // Small top quarter after swapping pane identities. Verify actual geometry below.
    const split = await call(['pane', 'split', '--pane', caller.pane_id, '--direction', 'down', '--ratio', '0.25', '--cwd', options.root, '--no-focus']);
    const pane = split?.pane?.pane_id;
    if (typeof pane !== 'string' || pane === caller.pane_id) throw new Error('Split returned no distinct pane ID');
    state.pane = pane; state.stage = 'rename_pending'; await save();
    await call(['pane', 'rename', pane, label]);
    state.stage = 'swap_pending'; await save();
    const swapped = await call(['pane', 'swap', '--source-pane', caller.pane_id, '--target-pane', pane]);
    if (swapped?.swap?.changed !== true) throw new Error('Herdr did not confirm pane swap');
    const layout = (await call(['pane', 'layout', '--pane', caller.pane_id]))?.layout;
    const top = layout?.panes?.find((p: { pane_id: string }) => p.pane_id === pane)?.rect;
    const bottom = layout?.panes?.find((p: { pane_id: string }) => p.pane_id === caller.pane_id)?.rect;
    if (!top || !bottom || top.y >= bottom.y || layout.focused_pane_id !== caller.pane_id) throw new Error('Monitor geometry/focus not confirmed; inspect panes before recovery');
    state.stage = 'run_pending'; await save();
    const args = [options.script, '--root', options.root];
    const command = platform === 'win32'
      ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded(`& ${psQuote(options.node ?? process.execPath)} ${args.map(psQuote).join(' ')}`)}`
      : `sh -c ${shQuote(`exec ${shQuote(options.node ?? process.execPath)} ${args.map(shQuote).join(' ')}`)}`;
    await call(['pane', 'run', pane, command]);
    state.stage = 'submitted'; await save();
    return { outcome: 'command submitted; monitor readiness not awaited', pane };
  } catch (e) {
    throw new Error(`Intercom monitor: ${String(e)}. Pane ${state?.pane ?? 'unknown'} may remain; no automatic cleanup.`);
  } finally { await unlink(lock).catch(() => {}); }
}
