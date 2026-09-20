'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const ui = Object.fromEntries(['roster', 'events', 'notice', 'connection-state', 'snapshot-time', 'roster-count', 'event-count', 'event-window', 'worker-filter', 'type-filter', 'errors-filter'].map(id => [id, byId(id)]));
  const refreshMs = 3000;
  let snapshot = null;
  let connected = false;
  let eventSignature = '';
  const safeText = (value, max = 4096) => typeof value === 'string' ? value.slice(0, max) : '';
  const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
  const node = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = String(text);
    if (className) result.className = className;
    return result;
  };
  const formatDate = value => Number.isFinite(timestamp(value)) ? new Date(value).toLocaleString() : 'Unknown time';
  const age = value => {
    const milliseconds = Date.now() - timestamp(value);
    if (!Number.isFinite(milliseconds)) return 'Age unknown';
    if (milliseconds < -5000) return 'Clock ahead; age uncertain';
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  };
  const isError = event => Boolean(event.errorCode) || ['error', 'failed', 'failure', 'rejected', 'handler_failed'].includes(event.outcome) || /(?:^|\.)(?:error|failed|failure|rejected)$/.test(event.event);
  const agents = () => Array.isArray(snapshot?.config?.agents) ? snapshot.config.agents : [];
  const events = () => Array.isArray(snapshot?.events) ? snapshot.events : [];
  const agentName = id => safeText(agents().find(agent => agent.sessionId === id)?.name, 128) || safeText(id, 256) || 'Unknown agent';

  function renderRoster() {
    const observed = new Map();
    for (const event of events()) {
      if (!['runtime.ready', 'host.activity'].includes(event.event) || typeof event.busy !== 'boolean' || !Number.isFinite(timestamp(event.timestamp))) continue;
      const previous = observed.get(event.sessionId);
      if (!previous || timestamp(event.timestamp) >= timestamp(previous.timestamp)) observed.set(event.sessionId, event);
    }
    ui['roster-count'].textContent = String(agents().length);
    const fragment = document.createDocumentFragment();
    for (const agent of agents()) {
      const article = node('article', undefined, 'agent');
      article.append(node('h3', safeText(agent.name, 128) || 'Unnamed agent'));
      article.append(node('span', agent.coordinator ? 'Coordinator' : 'Worker', 'agent-role'));
      article.append(node('p', safeText(agent.description) || 'No responsibility recorded.', 'responsibility'));
      const port = Number.isInteger(agent.port) && agent.port > 0 && agent.port <= 65535 ? `127.0.0.1:${agent.port}` : 'Unknown endpoint';
      article.append(node('p', `Saved endpoint · ${port}`, 'endpoint'));
      article.append(node('p', `Pi session · ${safeText(agent.sessionId, 256)}`, 'identity'));
      const observation = observed.get(agent.sessionId);
      const badges = node('div', undefined, 'observation');
      if (!observation) {
        badges.append(node('span', 'Status unknown', 'badge'));
        article.append(badges, node('p', 'No busy/idle observation in the retained event window.', 'observed-time'));
      } else {
        const elapsed = Date.now() - timestamp(observation.timestamp);
        const stale = elapsed > snapshot.staleAfterMs;
        const uncertain = elapsed < -5000;
        badges.append(node('span', observation.busy ? 'Observed busy' : 'Observed idle', 'badge badge-observed'));
        badges.append(node('span', uncertain ? 'Clock uncertain' : stale ? 'Stale evidence' : 'Recent evidence', `badge${stale || uncertain ? ' badge-stale' : ''}`));
        article.append(badges, node('p', `${formatDate(observation.timestamp)} · ${age(observation.timestamp)}${!connected ? ' · Dashboard disconnected' : ''}`, 'observed-time'));
      }
      fragment.append(article);
    }
    if (!agents().length) fragment.append(node('p', snapshot?.config ? 'No agents in this snapshot.' : 'Saved configuration is unavailable. No roster can be inferred from events.', 'empty'));
    ui.roster.replaceChildren(fragment);
  }

  function syncOptions(select, values, allLabel) {
    const signature = JSON.stringify(values);
    if (select.dataset.options === signature) return;
    const selected = select.value;
    select.replaceChildren(new Option(allLabel, ''));
    for (const [value, label] of values) select.append(new Option(label, value));
    if (values.some(([value]) => value === selected)) select.value = selected;
    select.dataset.options = signature;
  }

  function syncFilters() {
    const ids = new Set(agents().map(agent => agent.sessionId));
    for (const event of events()) {
      if (event.sessionId) ids.add(event.sessionId);
      if (event.peerSessionId) ids.add(event.peerSessionId);
    }
    syncOptions(ui['worker-filter'], [...ids].sort().map(id => [id, agentName(id)]), 'All agents');
    syncOptions(ui['type-filter'], [...new Set(events().map(event => event.event))].sort().map(type => [type, type]), 'All types');
  }

  function renderEvents() {
    const worker = ui['worker-filter'].value;
    const type = ui['type-filter'].value;
    const onlyErrors = ui['errors-filter'].checked;
    const filtered = events().filter(event => (!worker || event.sessionId === worker || event.peerSessionId === worker) && (!type || event.event === type) && (!onlyErrors || isError(event))).slice().reverse();
    ui['event-count'].textContent = `${filtered.length} / ${events().length}`;
    ui['event-window'].textContent = `${snapshot?.truncated ? 'Bounded window: earlier or excess records omitted. ' : 'Retained event window. '}Newest first. Status evidence older than ${Math.round((snapshot?.staleAfterMs || 60000) / 1000)} seconds is marked stale, not offline.`;
    const signature = JSON.stringify([filtered, agents().map(agent => [agent.sessionId, agent.name])]);
    if (signature === eventSignature) return;
    eventSignature = signature;
    const opened = new Set([...ui.events.querySelectorAll('details[open]')].map(item => item.dataset.key));
    const focusedKey = document.activeElement?.closest('details')?.dataset.key;
    const fragment = document.createDocumentFragment();
    const metadata = [
      ['timestamp', 'Timestamp'], ['sessionId', 'Pi session'], ['peerSessionId', 'Peer session'],
      ['peerName', 'Peer label'], ['writerId', 'Telemetry writer'], ['correlationId', 'Correlation ID'],
      ['kind', 'Wire kind'], ['operation', 'Operation'], ['role', 'Observed role'],
      ['outcome', 'Outcome'], ['errorCode', 'Error code'], ['busy', 'Busy snapshot'], ['port', 'Observed port'],
    ];
    const occurrences = new Map();
    filtered.forEach(event => {
      const details = node('details', undefined, 'event');
      const identity = JSON.stringify(event);
      const occurrence = occurrences.get(identity) || 0;
      occurrences.set(identity, occurrence + 1);
      const key = `${identity}:${occurrence}`;
      details.dataset.key = key;
      details.open = opened.has(key);
      const summary = node('summary');
      const time = node('time', Number.isFinite(timestamp(event.timestamp)) ? new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Unknown', 'event-time');
      if (Number.isFinite(timestamp(event.timestamp))) time.dateTime = event.timestamp;
      time.title = formatDate(event.timestamp);
      const label = node('span');
      label.append(node('span', safeText(event.event, 128), 'event-name'));
      label.append(node('span', `${agentName(event.sessionId)}${event.peerSessionId ? ` · peer ${agentName(event.peerSessionId)}` : ''}`, 'event-route'));
      if (isError(event)) label.append(node('span', 'Error recorded', 'badge badge-error'));
      summary.append(time, label);
      details.append(summary);
      const list = node('dl');
      for (const [field, title] of metadata) {
        const value = event[field];
        if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
        list.append(node('dt', title), node('dd', typeof value === 'string' ? safeText(value) : String(value)));
      }
      details.append(list);
      fragment.append(details);
    });
    if (!filtered.length) fragment.append(node('p', events().length ? 'No events match these filters. Choose another agent or event type.' : 'No readable events in this window. This does not indicate that agents are idle or work is complete.', 'empty'));
    ui.events.replaceChildren(fragment);
    if (focusedKey) [...ui.events.querySelectorAll('details')].find(item => item.dataset.key === focusedKey)?.querySelector('summary')?.focus({ preventScroll: true });
  }

  const errorLabels = {
    config_unavailable: 'Shared configuration could not be read.',
    logs_unavailable: 'Event logs are unavailable.',
    log_read_failed: 'Some event logs could not be read.',
  };
  function renderNotice(failed = false) {
    const messages = failed ? ['Dashboard disconnected or snapshot unavailable. Last received data is retained below; it is not current process status. Refresh attempts continue automatically.'] : [];
    for (const code of snapshot?.errors || []) messages.push(errorLabels[code] || 'Part of this snapshot is unavailable.');
    ui.notice.textContent = [...new Set(messages)].join(' ');
    ui.notice.hidden = !messages.length;
  }

  async function refresh() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/snapshot', { cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('snapshot_unavailable');
      const value = await response.json();
      if (value?.version !== 1 || !Array.isArray(value.events) || !Array.isArray(value.errors) || !Number.isFinite(timestamp(value.generatedAt))) throw new Error('snapshot_invalid');
      snapshot = { ...value, events: value.events.filter(event => event && typeof event.event === 'string').slice(-500), staleAfterMs: Number.isFinite(value.staleAfterMs) && value.staleAfterMs > 0 ? value.staleAfterMs : 60000 };
      connected = true;
      ui['connection-state'].textContent = 'Local dashboard connected';
      ui['snapshot-time'].textContent = `Snapshot ${formatDate(snapshot.generatedAt)}`;
      renderNotice();
      syncFilters();
      renderRoster();
      renderEvents();
    } catch {
      connected = false;
      ui['connection-state'].textContent = 'Dashboard disconnected';
      renderNotice(true);
      if (snapshot) renderRoster();
    } finally {
      clearTimeout(timeout);
      setTimeout(refresh, refreshMs);
    }
  }
  document.querySelector('.filters').addEventListener('submit', event => event.preventDefault());
  for (const id of ['worker-filter', 'type-filter', 'errors-filter']) ui[id].addEventListener('change', renderEvents);
  void refresh();
})();
