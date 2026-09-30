import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from 'pi-intercom-tui';
import { renderMonitor } from '../dist/monitor-view.js';
import { INTERCOM_VERSION } from '../dist/version.js';
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
  assert.match(lines[0], /Worker\s+Connection\s+Report\s+Activity\s+Seen\s+Last activity/);
  assert.match(lines.join('\n'), /Reviewer\s+unknown\s+—\s+idle\s+2m ago \(old\)/);
  assert.doesNotMatch(lines.join('\n'), /Read-only|INTERCOM|1 busy|1 idle/);
  assert.equal(lines.length, 12);
  assert.match(lines.at(-1), /q quit/);
});
test('narrow layout prioritizes connectivity; taller panes display more than five workers', () => {
  const s = snapshot();
  assert.match(renderMonitor(s, 60, 10, now).join('\n'), /Reviewer\s+unknown/);
  assert.match(renderMonitor(s, 80, 10, now).join('\n'), /2m ago \(old\)/);
  s.config.agents = Array.from({length: 12}, (_, i) => ({ sessionId: `w${i}`, name: `Worker-${i}` }));
  assert.match(renderMonitor(s, 100, 20, now).join('\n'), /Worker-11/);
  assert.match(renderMonitor(s, 100, 8, now).join('\n'), /more/);
});
test('thinking uses explicit phase and settled status retains historical activity', () => {
  const s = snapshot();
  s.events[0].phase = 'thinking'; s.events[0].detail = 'thinking';
  assert.match(renderMonitor(s, 110, 12, now).join('\n'), /Builder\s+unknown\s+—\s+thinking\s+3s ago\s+Thinking/);
  s.events.push({ ...s.events[0], timestamp: new Date(now - 1000).toISOString(), phase: 'idle', detail: 'settled', busy: false });
  assert.match(renderMonitor(s, 110, 12, now).join('\n'), /Builder\s+unknown\s+—\s+idle\s+1s ago\s+Thinking/);
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
    assert.match(lines[0], /Connection\s+Report\s+Activity\s+Seen\s+Last activity/);
    assert.match(lines[2], new RegExp(`Builder\\s+unknown\\s+${label}\\s+working\\s+3s ago`));
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
  const footer = renderMonitor(s, 40, 8, now).at(-1);
  assert.match(footer, /q quit.*Enter/);
  assert.ok(footer.endsWith(`v${INTERCOM_VERSION}`));
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
  assert.match(renderMonitor(s, 100, 10, now).join('\n'), /Builder\s+unknown\s+—\s+unknown\s+3s ago.*conflicting records/);
});

test('saved handoff and uncertain or failed close workflow are separate public details', () => {
  const s = snapshot();
  s.config.agents[0].handoff = { version: 1, jobId: 'previous-job', summary: 'Review the remaining tests before resuming', updatedAt: new Date(now - 120000).toISOString() };
  s.reports = [report('blocked', 'Awaiting a decision')];
  for (const [state, reason] of [['uncertain', 'close_unverified'], ['failed', 'close_failed']]) {
    s.config.agents[0].closeJob = { jobId: 'latest-job', state, reason, createdAt: new Date(now - 10000).toISOString(), updatedAt: new Date(now - 1000).toISOString(), deadlineAt: new Date(now + 10000).toISOString() };
    const text = renderMonitor(s, 140, 30, now, false, { selectedIndex: 0, details: true }).join('\n');
    assert.ok(text.includes(`Close workflow: ${state} · ${reason} · 1s ago`));
    assert.match(text, /Saved handoff \(public\): 2m ago \(old\)/);
    assert.match(text, /Handoff: Review the remaining tests before resuming/);
    assert.ok(text.includes(`Handoff saved: ${s.config.agents[0].handoff.updatedAt}`));
    assert.match(text, /Report: Blocked · 3s ago/);
    assert.match(text, /Observed status: working · 3s ago/);
    assert.match(text, /Connection: unknown/);
    assert.match(text, /Workflow state is not proof all child processes terminated/);
    assert.doesNotMatch(text, /approved|task completed/i);
  }
  delete s.config.agents[0].handoff;
  assert.match(renderMonitor(s, 100, 18, now, false, { selectedIndex: 0, details: true }).join('\n'), /Saved handoff: none/);
});
test('handoff summary is sanitized, wrapped and bounded without consuming footer', () => {
  const s = snapshot();
  s.config.agents[0].handoff = { version: 1, jobId: 'job-1', summary: '\x1b]52;c;SECRET\x07\u202e界👩‍💻\n' + 'Public context '.repeat(100), updatedAt: new Date(now + 1000).toISOString() };
  for (const color of [false, true]) for (const width of [1, 6, 20, 40, 60, 140]) for (const height of [1, 3, 8, 12, 30]) {
    const lines = renderMonitor(s, width, height, now, color, { selectedIndex: 0, details: true });
    assert.equal(lines.length, height);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const plain = lines.map(stripVTControlCharacters);
    assert.doesNotMatch(plain.join(''), /SECRET|[\x00-\x1f\x7f-\x9f\u202e]/);
    assert.ok(plain.at(-1).includes(width < 6 ? 'q' : 'q quit'));
  }
  const text = renderMonitor(s, 100, 30, now, false, { selectedIndex: 0, details: true }).join('\n');
  assert.match(text, /Saved handoff \(public\): clock uncertain/);
  assert.match(text, /Public context/);
});

test('footer reserves a right-aligned runtime version with safe tiny-pane quit hints', () => {
  const version = `v${INTERCOM_VERSION}`;
  for (const s of [undefined, snapshot(), { ...snapshot(), truncated: true, reports: [report('blocked')] }]) {
    for (const details of [false, true]) for (const width of [1, 3, 5, 6, 10, 14, 20, 30, 40, 60, 100, 140]) {
      for (const height of [1, 2, 3, 8, 20]) {
        const plain = renderMonitor(s, width, height, now, false, { selectedIndex: 0, details });
        const styled = renderMonitor(s, width, height, now, true, { selectedIndex: 0, details });
        assert.deepEqual(styled.map(stripVTControlCharacters), plain);
        assert.equal(plain.length, height);
        assert.ok(plain.every(line => visibleWidth(line) <= width));
        assert.doesNotMatch(plain.join(''), /[\x00-\x1f\x7f-\x9f]/);
        const footer = plain.at(-1);
        assert.ok(footer.includes(width < 6 ? 'q' : 'q quit'));
        if (width >= visibleWidth(version) + 8) {
          assert.ok(footer.endsWith(version));
          assert.equal(visibleWidth(footer), width);
        }
        if (width >= 60) assert.ok(footer.endsWith(`Intercom ${version}`));
        if (width <= 40) assert.ok(!footer.includes('Intercom'));
      }
    }
  }
  assert.deepEqual(renderMonitor(undefined, 0, 1, now), []);
  assert.deepEqual(renderMonitor(undefined, 40, 0, now), []);
});

test('disconnected workers stay visible at bottom with active reports and independent activity', () => {
  const s = snapshot();
  s.connections = [
    { sessionId: 'a', state: 'disconnected', reason: 'refused', checkedAt: new Date(now - 2000).toISOString() },
    { sessionId: 'b', state: 'unknown', reason: 'legacy', checkedAt: new Date(now - 1000).toISOString() },
  ];
  s.reports = [report('blocked', 'Still awaiting owner')];
  const lines = renderMonitor(s, 140, 22, now, false, { selectedIndex: 1, details: true });
  assert.match(lines[2], /Reviewer\s+unknown/);
  assert.match(lines[3], /› Builder\s+disconnected\s+Blocked\s+working/);
  assert.match(lines.join('\n'), /Connection: disconnected · refused/);
  assert.match(lines.join('\n'), /Checked: 2026-09-26T11:59:58.000Z · 2s ago/);
  assert.match(lines.join('\n'), /Observed status: working · 3s ago/);
  assert.match(lines.join('\n'), /Report: Blocked · 3s ago/);
  assert.match(lines.join('\n'), /Summary: Still awaiting owner/);
  assert.doesNotMatch(lines.join('\n'), /stopped|completed|approved/i);
  for (const width of [27, 30, 40, 60]) {
    const narrow = renderMonitor(s, width, 10, now);
    assert.match(narrow[3], /disconnected/);
    assert.match(narrow.at(-1), /q quit/);
    assert.ok(narrow.every(line => visibleWidth(line) <= width));
  }
  const stale = renderMonitor(s, 140, 12, now + 31000);
  assert.match(stale[2], /Builder\s+unknown/);
  assert.doesNotMatch(stale.join('\n'), /disconnected/);
});
