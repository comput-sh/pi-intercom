import path from 'node:path';
import { ConfigStore, coordinator, directory, fail, named, requireCoordinator, type Agent, type Config } from './config.js';
import { listen, send, type Endpoint, type Envelope, type Kind } from './transport.js';

export const UNSUPPORTED_CANCELLATION = 'Unsupported Pi host: stop_worker and close_worker are disabled. Pi 0.84.4 extension abort does not cancel retry backoff/continuations; graceful shutdown cannot guarantee no queued work restarts. No cancellation or shutdown was performed. See references/implementation-blocker.md. A verified supported host API is required (no version-only override).';
export interface Host {
  sessionId(): string;
  cwd: string;
  busy(): boolean;
  deliver(text: string, busy: boolean): void;
  setName(name: string): Promise<void>;
  notify(text: string): void;
}
export interface LaunchRequest { multiplexer: 'herdr' | 'none'; cwd: string; sessionId?: string }
export interface RuntimeOptions {
  launch(request: LaunchRequest): Promise<unknown>;
  listen?: typeof listen;
  send?: typeof send;
  store?: (root: string) => ConfigStore;
}
export class Intercom {
  store!: ConfigStore;
  endpoint?: Endpoint;
  private active = false;
  private generation = 0;
  private initialId = '';
  responsibility?: Agent;
  constructor(readonly host: Host, readonly options: RuntimeOptions) {}
  private id(): string {
    const id = this.host.sessionId();
    if (!this.active || id !== this.initialId) fail('session is inactive or replaced');
    return id;
  }
  private validity(): () => void {
    const generation = this.generation;
    this.id();
    return () => {
      this.id();
      if (generation !== this.generation) fail('runtime lifecycle replaced');
    };
  }
  async start(): Promise<void> {
    if (this.active) fail('runtime already active');
    this.initialId = this.host.sessionId(); this.active = true;
    const generation = ++this.generation, assertValid = this.validity();
    try {
      const discovered = await ConfigStore.discover(this.host.cwd);
      assertValid();
      this.store = this.options.store?.(discovered?.root ?? this.host.cwd) ?? discovered ?? new ConfigStore(this.host.cwd);
      const previous = discovered ? await this.store.read() : undefined;
      assertValid();
      const own = previous?.agents.find(a => a.sessionId === this.id());
      const endpoint = await (this.options.listen ?? listen)(own?.port, m => { assertValid(); return this.receive(m); });
      try { assertValid(); } catch (error) { await endpoint.close(); throw error; }
      this.endpoint = endpoint;
      if (!previous) await this.store.initialize(this.id(), this.endpoint.port, assertValid);
      const config = await this.store.read();
      assertValid();
      const me = config.agents.find(a => a.sessionId === this.id());
      if (me?.coordinator) {
        await this.store.update(this.id(), c => { requireCoordinator(c, this.id()).port = this.endpoint!.port; }, assertValid);
        assertValid();
        try { await this.reload(); } catch (e) { assertValid(); this.host.notify(`Name/responsibility synchronization failed: ${String(e)}`); }
        assertValid();
        this.host.notify(`Intercom Coordinator ready at 127.0.0.1:${this.endpoint.port}; waiting for user input.`);
      } else {
        if (me) { try { await this.reload(); } catch (e) { assertValid(); this.host.notify(`Name/responsibility synchronization failed: ${String(e)}`); } }
        assertValid();
        try {
          if (me) await this.report();
          else {
            const projectDirectory = await directory(this.store.root, this.host.cwd);
            assertValid();
            await this.transmit(coordinator(config).name, 'registration', { port: this.endpoint.port, projectDirectory });
          }
        } catch (e) { assertValid(); this.host.notify(`Coordinator unreachable/registration failed; worker remains reachable: ${String(e)}. No retry. Anonymous registration repeat is an unresolved contract; use explicit Pi /reload to restart this extension, not report_status.`); }
        assertValid();
        this.host.notify(`Intercom worker ready at 127.0.0.1:${this.endpoint.port}; waiting for explicit work.`);
      }
    } catch (e) { if (generation === this.generation) await this.close(); throw e; }
  }
  async close(): Promise<void> {
    this.active = false; this.generation++;
    const endpoint = this.endpoint; this.endpoint = undefined;
    this.responsibility = undefined;
    if (endpoint) await endpoint.close();
  }
  async state(): Promise<{ id: string; config: Config; me?: Agent }> {
    const assertValid = this.validity();
    const id = this.id(), config = await this.store.read();
    assertValid();
    return { id, config, me: config.agents.find(a => a.sessionId === id) };
  }
  async reload(): Promise<void> {
    const assertValid = this.validity();
    const { me } = await this.state();
    assertValid();
    if (!me) fail('worker not configured; configure_worker must run before reload_worker');
    this.responsibility = { ...me };
    await this.host.setName(me.name);
    assertValid();
    this.host.notify(`Intercom responsibility loaded for ${me.name}; no work turn started.`);
  }
  async transmit(to: string, kind: Kind, payload: Record<string, unknown> = {}): Promise<void> {
    const assertValid = this.validity();
    const { id, config } = await this.state();
    assertValid();
    const target = named(config, to);
    await (this.options.send ?? send)(target.port, { version: 1, from: id, to: target.sessionId, kind, payload });
  }
  async report(): Promise<void> {
    const assertValid = this.validity();
    const { config, me } = await this.state();
    assertValid();
    if (me?.coordinator) fail('report_status is worker-only');
    if (!this.endpoint) fail('endpoint unavailable');
    await this.transmit(coordinator(config).name, 'status', { port: this.endpoint.port, busy: this.host.busy() });
  }
  async receive(message: Envelope): Promise<void> {
    const assertValid = this.validity();
    const { id, config, me } = await this.state();
    assertValid();
    if (message.to !== id) fail('recipient session ID mismatch (stale endpoint)');
    const sender = config.agents.find(a => a.sessionId === message.from);
    const busy = this.host.busy();
    const notify = (purpose: string, content: string) => {
      assertValid();
      this.host.deliver(`[Intercom ${purpose} from ${sender?.name ?? 'unconfigured worker'} (${message.from})]\n${content}`, busy);
    };
    if (message.kind === 'registration' || message.kind === 'status') {
      requireCoordinator(config, id);
      if (sender?.coordinator) fail('coordinator cannot report as worker');
      if (message.kind === 'registration') {
        const projectDirectory = await directory(this.store.root, message.payload.projectDirectory as string);
        // No pending map, placeholder or configuration mutation.
        notify('registration', JSON.stringify({ sessionId: message.from, port: message.payload.port, projectDirectory }) + '\nThis is connection information, not a work assignment. Configure explicitly, then reload separately.');
      } else {
        if (sender) await this.store.update(id, c => {
          const entry = c.agents.find(a => a.sessionId === message.from && !a.coordinator);
          if (entry) entry.port = message.payload.port as number;
        }, assertValid);
        notify('status', JSON.stringify({ sessionId: message.from, port: message.payload.port, busy: message.payload.busy, configured: !!sender }));
      }
      return;
    }
    if (message.kind === 'message') {
      if (!sender || !me) fail('agent messaging requires configured sender and recipient; anonymous permissions TODO');
      if (!this.responsibility) fail('worker must load responsibility before receiving work');
      notify('agent message', message.payload.message as string); return;
    }
    if (!sender?.coordinator) fail('control requires current coordinator sender session ID');
    if (me?.coordinator) fail('worker control cannot target coordinator');
    if (message.kind === 'stop' || message.kind === 'close') fail(UNSUPPORTED_CANCELLATION);
    if (message.kind === 'reload') { await this.reload(); return; }
    if (message.kind === 'request_status') {
      // Independent one-way report, never a synchronous status in the HTTP response.
      setImmediate(() => {
        try { assertValid(); } catch { return; } // Closed/replaced requests cannot report for a new lifecycle.
        void this.report().catch(e => {
          try { assertValid(); } catch { return; }
          this.host.notify(`Status report failed: ${String(e)}`);
        });
      });
      return;
    }
    fail('unsupported control');
  }
  async tool(operation: string, args: Record<string, unknown>): Promise<unknown> {
    const assertValid = this.validity();
    const { id, config, me } = await this.state();
    assertValid();
    if (operation === 'list') {
      if (!me) fail('anonymous intercom_list permissions unresolved (TODO); no coordinator privileges');
      return config;
    }
    if (operation === 'report_status') { await this.report(); return { accepted: true }; }
    if (operation === 'send') {
      if (!me || !this.responsibility) fail('anonymous/unloaded worker cannot send agent messages (permissions TODO)');
      await this.transmit(args.to as string, 'message', { message: args.message }); return { accepted: true, completion: 'not awaited' };
    }
    requireCoordinator(config, id);
    if (operation === 'stop_worker' || operation === 'close_worker') fail(UNSUPPORTED_CANCELLATION);
    if (operation === 'configure_worker') {
      await this.store.configure(id, args as unknown as Omit<Agent, 'coordinator'>, assertValid);
      return { written: true, reloaded: false };
    }
    if (operation === 'set_multiplexer') {
      await this.store.update(id, c => { c.multiplexer = args.multiplexer as Config['multiplexer']; }, assertValid); return { written: true };
    }
    if (operation === 'create_worker') {
      const relative = await directory(this.store.root, (args.projectDirectory as string | undefined) ?? '.');
      assertValid();
      return this.options.launch({ multiplexer: config.multiplexer, cwd: path.resolve(this.store.root, relative) });
    }
    const target = named(config, args.to as string);
    if (target.coordinator) fail('operation requires a worker target');
    if (operation === 'reload_worker' || operation === 'request_status') {
      await this.transmit(target.name, operation === 'reload_worker' ? 'reload' : 'request_status');
      return { accepted: true, completion: 'not awaited' };
    }
    if (operation === 'resume_worker') {
      const relative = await directory(this.store.root, target.projectDirectory);
      assertValid();
      return this.options.launch({ multiplexer: config.multiplexer, cwd: path.resolve(this.store.root, relative), sessionId: target.sessionId });
    }
    if (operation === 'remove_worker') {
      // No live process claim: the caller must explicitly ensure closure first.
      await this.store.update(id, c => { c.agents = c.agents.filter(a => a.sessionId !== target.sessionId); }, assertValid);
      return { removed: true, processStopped: false, sessionDeleted: false };
    }
    fail(`unknown operation ${operation}`);
  }
}
