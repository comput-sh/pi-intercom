// Compatibility probe, not a PiIntercom implementation or a live Pi session.
// Executes selected installed methods against mocks: no models, credentials,
// HTTP listeners, Herdr mutations, or child processes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.env.PI_INTERCOM_PI_ROOT;
if (!root) throw new Error('Set PI_INTERCOM_PI_ROOT to the installed pi-coding-agent package directory.');
const sessionSource = await readFile(path.join(root, 'dist/core/agent-session.js'), 'utf8');
const tuiSource = await readFile(path.join(root, 'dist/modes/interactive/interactive-mode.js'), 'utf8');
const agentSource = await readFile(path.join(root, 'node_modules/@earendil-works/pi-agent-core/dist/agent.js'), 'utf8');

// Delimit by exact method boundaries instead of importing a complete Pi runtime.
function method(source, start, end, globals = {}) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Installed source layout changed: ${start}`);
  return vm.runInNewContext(`({${source.slice(a, b)}})`, globals);
}
const restore = method(tuiSource, '    restoreQueuedMessagesToEditor(options) {', '    queueCompactionMessage(').restoreQueuedMessagesToEditor;
const clear = method(tuiSource, '    clearAllQueues() {', '    updatePendingMessagesDisplay() {').clearAllQueues;
const abort = method(agentSource, '    abort() {', '    /**\n     * Resolve when').abort;

function host() {
  let editor = '';
  const session = {
    clearQueue: () => ({ steering: ['queued assignment'], followUp: ['queued follow-up'] }),
  };
  return {
    session,
    agent: { abort, activeRun: undefined },
    compactionQueuedMessages: [{ mode: 'steer', text: 'compaction assignment' }],
    clearAllQueues: clear,
    editor: { getText: () => editor, setText: value => { editor = value; } },
    updatePendingMessagesDisplay() {},
    restoreQueuedMessagesToEditor: restore,
  };
}

test('installed TUI extension abort binding delegates to queue restore, not session.abort', () => {
  const begin = tuiSource.indexOf('await this.session.bindExtensions({');
  assert.ok(begin >= 0);
  const binding = tuiSource.slice(begin, tuiSource.indexOf('commandContextActions:', begin));
  assert.match(binding, /abortHandler: \(\) => \{\s*this\.restoreQueuedMessagesToEditor\(\{ abort: true \}\);\s*\}/);
});

test('installed queue restore clears queued work into editor and aborts an active low-level run', () => {
  const tui = host();
  tui.agent.activeRun = { abortController: new AbortController() };
  assert.equal(tui.restoreQueuedMessagesToEditor({ abort: true }), 3);
  assert.equal(tui.agent.activeRun.abortController.signal.aborted, true);
  assert.equal(tui.compactionQueuedMessages.length, 0);
  assert.match(tui.editor.getText(), /queued assignment/);
  assert.match(tui.editor.getText(), /compaction assignment/);
});

test('blocker reproduced: TUI extension abort leaves retry alive and _prepareRetry returns true', async () => {
  let releaseSleep;
  let retrySignal;
  const sleep = (_ms, signal) => new Promise((resolve, reject) => {
    retrySignal = signal;
    releaseSleep = resolve;
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const prepareRetry = method(sessionSource, '    async _prepareRetry(message) {', '    /**\n     * Cancel in-progress retry.', { AbortController, sleep })._prepareRetry;
  const tui = host();
  Object.assign(tui.session, {
    settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 1 }) },
    _retryAttempt: 0,
    _emit() {},
    agent: { state: { messages: [{ role: 'assistant' }] } },
  });
  const retry = prepareRetry.call(tui.session, { errorMessage: 'simulated transient error' });
  assert.ok(retrySignal);
  tui.restoreQueuedMessagesToEditor({ abort: true });
  assert.equal(retrySignal.aborted, false, 'Retry survives the installed extension abort path');
  releaseSleep();
  assert.equal(await retry, true, 'Post-run loop is instructed to continue the agent');
  assert.match(sessionSource, /while \(await this\._handlePostAgentRun\(\)\) \{\s*await this\.agent\.continue\(\);/);
  assert.match(sessionSource, /this\._isRetryableError\(msg\) && \(await this\._prepareRetry\(msg\)\)\) \{\s*return true;/);
});
