// One `phpantom_lsp --stdio` child for one composer root: starts it, answers the requests it makes of the client, turns its notifications into typed events, and reports when it goes away.
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import type { ServerState } from '../status.ts';
import { CLIENT_CAPABILITIES } from './capabilities.ts';
import { RpcConnection } from './jsonrpc.ts';

type RefreshKind = 'semanticTokens' | 'inlayHints' | 'codeLens' | 'diagnostics';

interface ServerEvents {
  diagnostics: (uri: string, diagnostics: unknown[]) => void;
  progress: (state: ServerState) => void;
  refresh: (kind: RefreshKind) => void;
  log: (message: string) => void;
  exit: (reason: string) => void;
}

interface PhpantomServerOptions {
  executable: string;
  root: string;
  events: ServerEvents;
  spawnImpl?: typeof spawn;
  initializeTimeoutMs?: number;
}

// Why 60 s: the first index of a large project can take that long before `initialize` is answered.
const INITIALIZE_TIMEOUT_MS = 60_000;
const STDERR_LINES_KEPT = 8;
const SHUTDOWN_WAIT_MS = 2000;
const KILL_WAIT_MS = 2000;
const CLOSE_WAIT_MS = 1000;

const REFRESH_KINDS: Record<string, RefreshKind> = {
  'workspace/codeLens/refresh': 'codeLens',
  'workspace/diagnostic/refresh': 'diagnostics',
  'workspace/inlayHint/refresh': 'inlayHints',
  'workspace/semanticTokens/refresh': 'semanticTokens',
};

interface ProgressValue {
  kind?: string;
  percentage?: number;
}

async function delay(ms: number): Promise<'timeout'> {
  return new Promise((resolve) =>
    setTimeout(() => {
      resolve('timeout');
    }, ms).unref()
  );
}

class PhpantomServer {
  public capabilities: Record<string, unknown> = {};
  private readonly options: PhpantomServerOptions;
  private readonly stderrTail: string[] = [];
  private readonly openTokens = new Set<string>();
  private child: ChildProcess | null = null;
  private rpc: RpcConnection | null = null;
  private started = false;
  private finished = false;
  private stopping = false;
  private exitInfo = 'stopped (code unknown)';
  private resolveExited: () => void = () => {};
  private exited: Promise<void> = Promise.resolve();

  public constructor(options: PhpantomServerOptions) {
    this.options = options;
  }

  public get alive(): boolean {
    return this.started && !this.finished;
  }

  public async start(): Promise<void> {
    const { executable, root, events } = this.options;
    const launch = this.options.spawnImpl ?? spawn;
    const child = launch(executable, ['--stdio'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    const { stdin } = child;
    const { stdout } = child;
    const { stderr } = child;
    if (!stdin || !stdout || !stderr) {
      child.kill();
      throw new Error('could not open the language server pipes');
    }
    const rpc = new RpcConnection((frame) => void stdin.write(frame), {
      onError: (message) => {
        events.log(`PHPantom sent something unexpected: ${message}`);
      },
      onNotification: (method, params) => {
        this.onNotification(method, params);
      },
      onRequest: (method, params) => this.onRequest(method, params),
    });
    this.rpc = rpc;
    stdout.on('data', (chunk: Buffer) => {
      rpc.feed(chunk);
    });
    stderr.on('data', (chunk: Buffer) => {
      this.stderrTail.push(...chunk.toString('utf8').split(/\r?\n/).filter(Boolean));
      this.stderrTail.splice(0, Math.max(0, this.stderrTail.length - STDERR_LINES_KEPT));
    });
    // Why: writing to a child that just died raises EPIPE here; that is the exit, not a second failure.
    stdin.on('error', () => {});
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    child.on('error', (error) => {
      this.finish(`could not start: ${error.message}`);
    });
    // Why 'close' and not 'exit': at 'exit' the pipes may still hold unread output, so the stderr tail could be empty or cut.
    child.on('exit', (code, signal) => {
      this.exitInfo = `stopped (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`})`;
      // Why a fallback: a grandchild holding the pipes can keep 'close' from ever coming.
      setTimeout(() => {
        this.destroyPipes();
        this.finish(this.exitInfo);
      }, CLOSE_WAIT_MS).unref();
    });
    child.on('close', () => {
      this.finish(this.exitInfo);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const rootUri = pathToFileURL(root).href;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('did not answer initialize in time'));
        }, this.options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS);
        timer.unref();
      });
      const result = (await Promise.race([
        // oxlint-disable-next-line eslint/sort-keys -- order matters because the initialize request goes to PHPantom as written
        rpc.request('initialize', {
          processId: process.pid,
          clientInfo: { name: 'orca-phpantom', version: '0.2.1' },
          rootUri,
          workspaceFolders: [
            // oxlint-disable-next-line eslint/sort-keys -- order matters because the initialize request goes to PHPantom as written
            { uri: rootUri, name: root.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace' },
          ],
          capabilities: CLIENT_CAPABILITIES,
        }),
        timeout,
      ])) as { capabilities?: Record<string, unknown> } | null;
      this.capabilities = result?.capabilities ?? {};
      rpc.notify('initialized', {});
      this.started = true;
      if (this.finished) {
        throw new Error('the language server exited during startup');
      }
      if (this.openTokens.size === 0) {
        events.progress({ phase: 'ready' });
      }
    } catch (error) {
      this.stopping = true;
      rpc.close('failed to start');
      await this.terminate();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  public notify(method: string, params: unknown): void {
    if (this.alive) {
      this.rpc?.notify(method, params);
    }
  }

  public async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.alive || !this.rpc) {
      throw new Error('the language server is not running');
    }
    return this.rpc.request(method, params, signal);
  }

  /** `shutdown` (2 s cap), `exit`, close stdin, kill if it is still there 2 s later. Does not report an exit event. */
  public async stop(): Promise<void> {
    const { child, rpc } = this;
    if (!child || !rpc) {
      return;
    }
    this.stopping = true;
    if (this.alive) {
      await Promise.race([rpc.request('shutdown', null).catch(() => {}), delay(SHUTDOWN_WAIT_MS)]);
      rpc.notify('exit', null);
    }
    await this.terminate();
    rpc.close('stopped');
  }

  /** Close stdin, give the child 2 s to leave, then SIGKILL; if even that is not seen, drop the pipes and give up on it. */
  private async terminate(): Promise<void> {
    const { child } = this;
    if (!child) {
      return;
    }
    child.stdin?.end();
    if ((await Promise.race([this.exited, delay(KILL_WAIT_MS)])) === 'timeout') {
      child.kill('SIGKILL');
      if ((await Promise.race([this.exited, delay(KILL_WAIT_MS)])) === 'timeout') {
        this.destroyPipes();
        this.finish('killed');
      }
    }
  }

  private destroyPipes(): void {
    this.child?.stdin?.destroy();
    this.child?.stdout?.destroy();
    this.child?.stderr?.destroy();
  }

  private finish(reason: string): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.resolveExited();
    this.rpc?.close(reason);
    if (this.started && !this.stopping) {
      const tail = this.stderrTail.length > 0 ? `: ${this.stderrTail.join(' | ')}` : '';
      this.options.events.exit(`${reason}${tail}`);
    }
  }

  private onRequest(method: string, params: unknown): unknown {
    switch (method) {
      case 'workspace/configuration': {
        const items = (params as { items?: unknown[] } | null)?.items;
        return Array.isArray(items) ? items.map(() => null) : [];
      }
      case 'workspace/applyEdit': {
        return { applied: false };
      }
      default: {
        const kind = REFRESH_KINDS[method];
        if (kind) {
          this.options.events.refresh(kind);
        }
        return null;
      }
    }
  }

  private onNotification(method: string, params: unknown): void {
    const { events } = this.options;
    if (method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = params as { uri: string; diagnostics: unknown[] };
      events.diagnostics(uri, diagnostics);
    } else if (method === '$/progress') {
      const { token, value } = params as { token: string | number; value: ProgressValue };
      this.onProgress(String(token), value);
    } else if (method === 'window/logMessage') {
      const { type, message } = params as { type: number; message: string };
      if (type === 1 || type === 2) {
        events.log(message);
      }
    }
  }

  private onProgress(token: string, value: ProgressValue | undefined): void {
    const { events } = this.options;
    if (value?.kind === 'begin' || value?.kind === 'report') {
      this.openTokens.add(token);
      events.progress(
        value.percentage === undefined
          ? { phase: 'indexing' }
          : { percent: value.percentage, phase: 'indexing' }
      );
    } else if (value?.kind === 'end') {
      this.openTokens.delete(token);
      if (this.openTokens.size === 0) {
        events.progress({ phase: 'ready' });
      }
    }
  }
}

export { PhpantomServer };
export type { RefreshKind, ServerEvents, PhpantomServerOptions };
