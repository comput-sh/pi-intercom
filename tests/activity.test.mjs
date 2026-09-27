import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityTracker } from '../dist/activity.js';

function fixture() {
  const states = [];
  return { states, tracker: createActivityTracker((phase, detail) => states.push([phase, detail])) };
}

test('stream events emit public phases and deduplicate equal states, not tokens', () => {
  const { states, tracker } = fixture();
  tracker.start(); tracker.start();
  tracker.message('thinking_start');
  for (let i = 0; i < 100; i++) tracker.message('thinking_delta');
  tracker.message('thinking_end'); tracker.message('thinking_end');
  tracker.message('text_start');
  for (let i = 0; i < 100; i++) tracker.message('text_delta');
  tracker.message('text_end'); tracker.message('unknown');
  tracker.settled(); tracker.settled();
  assert.deepEqual(states, [
    ['working', 'processing'], ['thinking', 'thinking'], ['working', 'processing'],
    ['responding', 'responding'], ['idle', 'settled'],
  ]);
});

test('delta-only streams are classified without examining their content', () => {
  const { states, tracker } = fixture();
  tracker.message('thinking_delta');
  tracker.message('text_delta');
  assert.deepEqual(states, [['thinking', 'thinking'], ['responding', 'responding']]);
});

test('built-in tool names map to fixed categories and custom names are never emitted', () => {
  for (const [name, detail] of [
    ['read', 'reading_files'], ['edit', 'editing_files'], ['write', 'editing_files'],
    ['bash', 'running_command'], ['powershell', 'running_command'],
    ['private-custom-tool-name', 'using_tool'], ['', 'using_tool'],
  ]) {
    const { states, tracker } = fixture();
    tracker.toolStart('opaque-id', name);
    tracker.toolEnd('opaque-id');
    assert.deepEqual(states, [['tool', detail], ['working', 'processing']]);
  }
});

test('concurrent tools dominate streaming and preserve remaining tool category', () => {
  const { states, tracker } = fixture();
  tracker.start();
  tracker.toolStart('a', 'read'); tracker.toolStart('a', 'read');
  tracker.message('thinking_start'); tracker.message('thinking_delta'); tracker.message('thinking_end');
  tracker.toolStart('b', 'write'); tracker.toolStart('c', 'bash');
  tracker.message('text_start'); tracker.message('text_delta');
  tracker.toolEnd('unknown'); tracker.toolEnd('a'); tracker.toolEnd('c');
  tracker.toolEnd('b'); tracker.toolEnd('b');
  assert.deepEqual(states, [
    ['working', 'processing'], ['tool', 'reading_files'], ['tool', 'multiple_tools'],
    ['tool', 'editing_files'], ['working', 'processing'],
  ]);
});

test('settled discards active tools, emits idle once, and ignores obsolete tool ends', () => {
  const { states, tracker } = fixture();
  tracker.toolStart('a', 'read'); tracker.toolStart('b', 'edit');
  tracker.settled(); tracker.settled();
  tracker.toolEnd('a'); tracker.toolEnd('b');
  tracker.start(); tracker.message('text_delta');
  assert.deepEqual(states, [
    ['tool', 'reading_files'], ['tool', 'multiple_tools'], ['idle', 'settled'],
    ['working', 'processing'], ['responding', 'responding'],
  ]);
});

test('reset emits nothing and clears both tool tracking and state deduplication', () => {
  const { states, tracker } = fixture();
  tracker.start(); tracker.reset();
  assert.deepEqual(states, [['working', 'processing']]);
  tracker.start();
  tracker.toolStart('old', 'read'); tracker.reset(); tracker.reset();
  tracker.toolEnd('old');
  tracker.message('thinking_delta');
  assert.deepEqual(states, [
    ['working', 'processing'], ['working', 'processing'], ['tool', 'reading_files'],
    ['thinking', 'thinking'],
  ]);
});

test('new start clears abandoned tools before reporting fresh processing', () => {
  const { states, tracker } = fixture();
  tracker.toolStart('old', 'bash'); tracker.start(); tracker.toolEnd('old');
  tracker.message('text_start');
  assert.deepEqual(states, [['tool', 'running_command'], ['working', 'processing'], ['responding', 'responding']]);
});
