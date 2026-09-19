import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../dist/index.js';

test('single extension registers all agreed tools without starting resources in factory', async () => {
  const tools = new Map(), events = new Map();
  extension({ registerTool: t => tools.set(t.name, t), on: (name, handler) => events.set(name, handler) });
  assert.equal(tools.size, 12);
  assert.deepEqual([...events.keys()], ['session_start', 'session_shutdown', 'before_agent_start']);
  const configure = tools.get('intercom_configure_worker');
  assert.deepEqual([...configure.parameters.required].sort(), ['description', 'name', 'port', 'projectDirectory', 'sessionId']);
  assert.match(tools.get('intercom_stop_worker').description, /disabled/);
  assert.match(tools.get('intercom_reload_worker').description, /NOT Pi extension reload/);
  await assert.rejects(tools.get('intercom_list').execute('test', {}, undefined, undefined, {}), /not initialized/);
  await events.get('session_shutdown')();
  await events.get('session_shutdown')();
});
