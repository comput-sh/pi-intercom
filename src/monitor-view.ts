import { stripVTControlCharacters } from 'node:util';
import { truncateToWidth, visibleWidth } from 'pi-intercom-tui';
import type { ObservationSnapshot } from './snapshot.js';
import { workerObservation } from './worker-status.js';

const safe = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, ' ');
const clip = (value: string, width: number) => stripVTControlCharacters(truncateToWidth(safe(value), Math.max(0, width)));
const cell = (value: string, width: number) => {
  const text = clip(value, width);
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
};
const ageLabel = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

const reportLabels: Record<string, string> = {
  blocked: 'Blocked', needs_decision: 'Needs decision', ready_for_review: 'Ready for review',
};
// Wrap only sanitized grapheme clusters, bounded by the terminal's remaining rows.
function wrapSummary(value: string, width: number, rows: number): string[] {
  if (width <= 0 || rows <= 0) return [];
  const result: string[] = [];
  let current = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(safe(value))) {
    if (visibleWidth(current + segment) > width) {
      if (current) result.push(current);
      current = '';
      if (result.length >= rows) break;
    }
    current += visibleWidth(segment) <= width ? segment : clip(segment, width);
  }
  if (current && result.length < rows) result.push(current);
  return result;
}

/** Presentation only. All user-controlled text is sanitized before trusted ANSI styling. */
export function renderMonitor(snapshot: ObservationSnapshot | undefined, width: number, height: number,
  now = Date.now(), color = false, options: { selectedIndex?: number; details?: boolean } = {}): string[] {
  width = Math.max(0, Math.min(1000, Math.floor(width)));
  height = Math.max(0, Math.min(1000, Math.floor(height)));
  if (!width || !height) return [];
  const paint = (code: string, text: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const dim = (text: string) => paint('90', text);
  const line = (text: string) => clip(text, width);
  const lines: string[] = [];
  if (!snapshot?.config) {
    lines.push(paint('33', line('  Status unavailable — waiting for local observations')));
  } else {
    const workers = snapshot.config.agents.filter(agent => !agent.coordinator);
    // Report remains distinct from observed status; last activity gives way first.
    const wide = width >= 100;
    const nameWidth = wide ? Math.min(22, Math.max(10, width - 88)) : 10;
    const activityWidth = wide ? 12 : 8, ageWidth = 16, reportWidth = 16;
    const table = (name: string, activity: string, age: string, detail: string, report = '—', tone = '90', selected = false) => {
      const prefix = `${selected ? '› ' : '  '}${cell(name, nameWidth)}  ${cell(age, ageWidth)}  `;
      const status = cell(activity, activityWidth);
      const tail = `  ${cell(report, reportWidth)}${wide ? `  ${detail}` : ''}`;
      // Clip as plain text first; no untrusted escape sequences enter the output.
      if (!color) return line(prefix + status + tail);
      const namePart = clip(prefix, width);
      const statusRoom = Math.max(0, width - visibleWidth(namePart));
      const statusPart = clip(status, statusRoom);
      const tailRoom = Math.max(0, statusRoom - visibleWidth(statusPart));
      return (selected ? paint('1;36', namePart) : namePart) + paint(tone, statusPart) + dim(clip(tail, tailRoom));
    };
    lines.push(paint('1', table('Worker', 'Status', 'Seen', 'Last activity', 'Report')));
    lines.push(dim(line('  ' + '─'.repeat(Math.max(0, width - 2)))));
    const selectedIndex = Math.min(workers.length - 1, Math.max(-1, options.selectedIndex ?? -1));
    const showDetails = Boolean(options.details && selectedIndex >= 0 && height >= 8);
    const selectedReport = snapshot.reports?.find(report => report.sessionId === workers[selectedIndex]?.sessionId && reportLabels[report.status]);
    const detailBudget = showDetails ? Math.min(selectedReport ? 12 : 5, height - 5) : 0;
    const available = Math.max(0, height - lines.length - 2 - detailBudget);
    const needsOverflow = workers.length > available;
    const count = Math.min(workers.length, Math.max(0, available - (needsOverflow && available > 1 ? 1 : 0)));
    const start = Math.max(0, Math.min(Math.max(0, workers.length - count), selectedIndex - count + 1));
    let selectedDetail: string[] = [];
    for (const [offset, worker] of workers.slice(start, start + count).entries()) {
      const observation = workerObservation(snapshot, worker.sessionId, now);
      const activity = observation.observedStatus, evidence = observation.lastActivity;
      const age = observation.observationAgeSeconds === null ? '—' : ageLabel(observation.observationAgeSeconds * 1000) + (observation.stale ? ' (old)' : '');
      const tone = observation.stale ? '90' : activity === 'thinking' ? '35' : activity === 'working' ? '36' : activity === 'idle' ? '32' : '90';
      const selected = start + offset === selectedIndex;
      const report = snapshot.reports?.find(report => report.sessionId === worker.sessionId && reportLabels[report.status]);
      lines.push(table(worker.name, activity, age, evidence, report ? reportLabels[report.status] : '—', tone, selected));
      if (selected && showDetails && report) {
        const elapsed = now - Date.parse(report.updatedAt);
        const reportAge = !Number.isFinite(elapsed) || elapsed < 0 ? 'clock uncertain' : ageLabel(elapsed) + (elapsed > snapshot.staleAfterMs ? ' (old)' : '');
        const contextRows = detailBudget >= 5 ? [
          ...(detailBudget >= 6 ? [paint('1', line(`  ${worker.name}`))] : []),
          line(`  Responsibility: ${worker.description || 'Not specified'}`),
          line(`  Observed status: ${activity} · ${age}`),
        ] : [];
        selectedDetail = [
          ...contextRows,
          line(`  Report: ${reportLabels[report.status]} · ${reportAge}`),
          line('  Self-reported, pending review'),
          ...wrapSummary(`Summary: ${report.summary}`, Math.max(0, width - 2), Math.max(0, detailBudget - 2 - contextRows.length)).map(text => line(`  ${text}`)),
        ];
      } else if (selected && showDetails) selectedDetail = [
        dim(line('  ' + '─'.repeat(Math.max(0, width - 2)))),
        paint('1', line(`  ${worker.name}`)),
        line(`  Responsibility: ${worker.description || 'Not specified'}`),
        line(`  Observed status: ${activity} · ${age}`),
        line(`  Last activity: ${evidence}`),
      ];
    }
    if (workers.length > count && available > count) lines.push(dim(line(`  ${workers.length - count} more · rows ${count ? start + 1 : 0}–${start + count} of ${workers.length} · ↑↓ to browse`)));
    lines.push(...(selectedReport ? selectedDetail.slice(0, detailBudget) : selectedDetail.slice(-detailBudget || selectedDetail.length)));
    if (!workers.length && available) lines.push(dim(line('  No workers configured yet')));
  }
  // Anchor the hint at the bottom; do not fill the pane with decorative boxes.
  const partial = snapshot && (snapshot.truncated || snapshot.errors.length);
  const controls = options.details ? 'q quit · Esc back · ↑↓ select' : 'q quit · ↑↓ select · Enter details';
  const hasReports = snapshot?.reports?.some(report => reportLabels[report.status] && snapshot.config?.agents.some(agent => !agent.coordinator && agent.sessionId === report.sessionId));
  const footer = width < 18 ? 'q quit' : `  ${controls}${partial ? ' · Partial observations' : ''}${hasReports ? ' · Reports: self-reported, pending review' : ''}`;
  while (lines.length < height - 1) lines.push('');
  lines.push(dim(line(footer)));
  return lines.slice(0, height);
}
