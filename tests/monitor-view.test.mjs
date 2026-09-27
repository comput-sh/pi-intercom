import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from 'pi-intercom-tui';
import { renderMonitor } from '../dist/monitor-view.js';
const now = Date.parse('2026-09-26T12:00:00.000Z');
const snapshot = () => ({ config: { agents: [
  { sessionId: 'a', name: 'Builder', coordinator: false },
  { sessionId: 'b', name: 'Reviewer', coordinator: false },
] }, events: [
  { sessionId: 'a', event: 'host.activity', busy: true, timestamp: new Date(now - 3000).toISOString() },
  { sessionId: 'b', event: 'host.activity', busy: false, timestamp: new Date(now - 120000).toISOString() },
], staleAfterMs: 60000, errors: [], truncated: false });

test('table-first layout separates activity from freshness and removes banners/count summaries', () => {
  const lines = renderMonitor(snapshot(), 100, 12, now);
  assert.match(lines[0], /Worker\s+Seen\s+Status\s+Report\s+Last activity/);
  assert.match(lines.join('\n'), /Reviewer\s+2m ago \(old\)\s+idle/);
  assert.doesNotMatch(lines.join('\n'), /Read-only|INTERCOM|1 busy|1 idle/);
  assert.equal(lines.length, 12);
  assert.match(lines.at(-1), /q quit/);
});
test('narrow layout retains old-observation warning; taller panes display more than five workers', () => {
  const s = snapshot();
  assert.match(renderMonitor(s, 60, 10, now).join('\n'), /2m ago \(old\)/);
  s.config.agents = Array.from({length: 12}, (_, i) => ({ sessionId: `w${i}`, name: `Worker-${i}` }));
  assert.match(renderMonitor(s, 100, 20, now).join('\n'), /Worker-11/);
  assert.match(renderMonitor(s, 100, 8, now).join('\n'), /more/);
});
test('thinking uses explicit phase and settled status retains historical activity', () => {
  const s = snapshot();
  s.events[0].phase = 'thinking'; s.events[0].detail = 'thinking';
  assert.match(renderMonitor(s, 110, 12, now).join('\n'), /Builder\s+3s ago\s+thinking\s+—\s+Thinking/);
  s.events.push({ ...s.events[0], timestamp: new Date(now - 1000).toISOString(), phase: 'idle', detail: 'settled', busy: false });
  assert.match(renderMonitor(s, 110, 12, now).join('\n'), /Builder\s+1s ago\s+idle\s+—\s+Thinking/);
});
test('selection scrolls into view and details remain bounded and terminal-safe', () => {
  const s = snapshot();
  s.config.agents = Array.from({ length: 20 }, (_, i) => ({ sessionId: `w${i}`, name: `Worker-${i}`, description: '\x1b]52;c;SECRET\x07Review only\nnever modify' }));
  for (const height of [8, 10, 14]) {
    const lines = renderMonitor(s, 100, height, now, false, { selectedIndex: 19, details: true });
    assert.ok(lines.length <= height);
    assert.match(lines.join('\n'), /Worker-19/);
    assert.match(lines.join('\n'), /Responsibility: Review only never modify/);
    assert.doesNotMatch(lines.join(''), /SECRET|\x1b/);
    assert.ok(lines.every(line => visibleWidth(line) <= 100));
  }
});
test('styled output only introduces trusted SGR, with bounded Unicode widths and heights', () => {
  const s = snapshot();
  s.config.agents[0].name = '\x1b]52;c;c2VjcmV0\x07\u202e\x85界👩‍💻é';
  for (const width of [0, 1, 2, 3, 20, 60, 100]) for (const height of [0, 1, 3, 8, 30]) {
    const lines = renderMonitor(s, width, height, now, true);
    assert.ok(lines.length <= height);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width);
      assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x1f\x7f-\x9f\u202e]/);
      assert.doesNotMatch(stripVTControlCharacters(line), /c2VjcmV0/);
    }
  }
});
const report = (status, summary = 'Please review this public result', elapsed = 3000) => ({
  version: 1, sessionId: 'a', status, summary, updatedAt: new Date(now - elapsed).toISOString(),
});
test('public reports are distinct from observed activity and explicitly pending review', () => {
  for (const [status, label] of [['blocked', 'Blocked'], ['needs_decision', 'Needs decision'], ['ready_for_review', 'Ready for review']]) {
    const s = snapshot(); s.reports = [report(status)];
    const lines = renderMonitor(s, 140, 16, now, false, { selectedIndex: 0, details: true });
    assert.match(lines[0], /Status\s+Report\s+Last activity/);
    assert.match(lines[2], new RegExp(`Builder\\s+3s ago\\s+working\\s+${label}`));
    assert.match(lines.join('\n'), /self-reported, pending review/);
    assert.match(lines.join('\n'), /Summary: Please review this public result/);
    assert.doesNotMatch(lines.join('\n'), /approved|accepted|completed/i);
    const narrow = renderMonitor(s, 60, 12, now);
    assert.match(narrow[0], /Report/); assert.doesNotMatch(narrow[0], /Last activity/);
    assert.ok(narrow.some(line => line.includes(label)));
  }
});
test('clear tombstones and orphan reports are hidden, with independent stale report age', () => {
  const s = snapshot();
  s.reports = [report('clear', 'HIDDEN'), { ...report('blocked', 'ORPHAN'), sessionId: 'missing' }];
  const cleared = renderMonitor(s, 140, 16, now, false, { selectedIndex: 0, details: true }).join('\n');
  assert.doesNotMatch(cleared, /HIDDEN|ORPHAN|Blocked|pending review/);
  s.reports = [report('blocked', 'Old blocker', 172800000)];
  const old = renderMonitor(s, 140, 16, now, false, { selectedIndex: 0, details: true }).join('\n');
  assert.match(old, /Report: Blocked · 2d ago \(old\)/);
  assert.match(old, /Observed status: working · 3s ago/);
  s.reports = [report('needs_decision', 'Future clock', -1000)];
  assert.match(renderMonitor(s, 140, 16, now, false, { selectedIndex: 0, details: true }).join('\n'), /clock uncertain/);
});
test('short report panes prioritize summary and usable footer controls', () => {
  const s = snapshot(); s.reports = [report('blocked', 'Awaiting owner decision')];
  const lines = renderMonitor(s, 60, 8, now, false, { selectedIndex: 0, details: true });
  assert.equal(lines.length, 8);
  assert.match(lines.join('\n'), /Report: Blocked/);
  assert.match(lines.join('\n'), /Self-reported, pending review/);
  assert.match(lines.join('\n'), /Summary: Awaiting owner decision/);
  assert.match(lines.at(-1), /q quit.*Esc back.*↑↓ select/);
  for (const width of [10, 20, 40, 60]) {
    const narrow = renderMonitor(s, width, 8, now, false, { selectedIndex: 0, details: true });
    assert.match(narrow.at(-1), /q quit/);
    assert.ok(narrow.every(line => visibleWidth(line) <= width));
  }
  s.truncated = true;
  assert.match(renderMonitor(s, 40, 8, now).at(-1), /q quit.*Enter details/);
});

test('report summaries wrap safely within selection and detail geometry', () => {
  const s = snapshot();
  s.reports = [report('ready_for_review', '\x1b]52;c;SECRET\x07\u202e\x85界👩‍💻é\n' + 'Public summary '.repeat(70))];
  for (const color of [false, true]) for (const width of [0, 1, 2, 3, 20, 60, 99, 100, 140]) for (const height of [0, 1, 3, 8, 12, 25]) {
    const lines = renderMonitor(s, width, height, now, color, { selectedIndex: 0, details: true });
    assert.ok(lines.length <= height);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width);
      assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x1f\x7f-\x9f\u202e]/);
      assert.doesNotMatch(line, /SECRET/);
    }
  }
  const wrapped = renderMonitor(s, 60, 25, now, false, { selectedIndex: 0, details: true });
  assert.ok(wrapped.filter(line => line.includes('Public summary')).length > 1);
  assert.match(wrapped.join('\n'), /Builder/);
});

test('equal-time contradictory observations remain unknown', () => {
  const s = snapshot(); s.events.push({...s.events[0], busy: false});
  assert.match(renderMonitor(s, 100, 10, now).join('\n'), /Builder\s+3s ago\s+unknown.*conflicting records/);
});
