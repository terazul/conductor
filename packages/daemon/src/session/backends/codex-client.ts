/** Local Codex App Server transport. Codex owns subscription authentication. */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';

export type Json = Record<string, unknown>;
export const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const string = (value: unknown): string => typeof value === 'string' ? value : '';

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function codexExecutable(): string {
  const override = process.env.CODEX_BIN;
  if (override) return override;
  const bundled = '/usr/lib/chatgpt/resources/codex';
  if ((process.env.PATH ?? '').split(delimiter).some((dir) => isExecutable(join(dir, 'codex')))) return 'codex';
  return process.platform === 'linux' && isExecutable(bundled) ? bundled : 'codex';
}

type Handler = (message: Json) => void;
type Pending = { resolve: (result: Json) => void; reject: (error: Error) => void };

export class CodexClient {
  readonly #process: ReturnType<typeof spawn>;
  readonly #pending = new Map<number, Pending>();
  readonly #threads = new Map<string, Handler>();
  #nextId = 0;
  failure: Error | null = null;

  constructor() {
    const env = { ...process.env };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
    const child = spawn(codexExecutable(), [
      'app-server', '--listen', 'stdio://', '-c', 'forced_login_method="chatgpt"',
      '-c', 'shell_environment_policy.inherit="core"',
    ], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.#process = child;
    child.once('error', (err) => this.close(new Error(
      'code' in err && err.code === 'ENOENT'
        ? 'Install the Codex CLI or set CODEX_BIN to its executable.'
        : err.message,
    )));
    child.once('exit', (code, signal) => this.close(new Error(`Codex App Server exited (${signal ?? code}).`)));
    child.stdin.on('error', (err) => this.close(err));
    child.stdout.on('error', (err) => this.close(err));
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: Json;
      try {
        message = object(JSON.parse(line));
      } catch {
        this.close(new Error('Codex App Server returned invalid JSON.'));
        return;
      }
      this.#receive(message);
    });
  }

  async initialize(): Promise<this> {
    try {
      await this.call('initialize', {
        clientInfo: { name: 'conductor', title: 'Conductor', version: '0.0.0' },
      });
      this.#write({ method: 'initialized' });
      return this;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  #write(message: Json): void {
    if (this.failure) throw this.failure;
    this.#process.stdin?.write(JSON.stringify(message) + '\n');
  }

  #receive(message: Json): void {
    const { id, method } = message;
    if (typeof method === 'string') {
      const handler = this.#threads.get(string(object(message.params).threadId));
      if (handler) handler(message);
      else if (typeof id === 'number' || typeof id === 'string') this.rejectRequest(id);
      return;
    }
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (message.error) pending.reject(new Error(string(object(message.error).message) || 'Codex request failed.'));
    else pending.resolve(object(message.result));
  }

  call(method: string, params: Json, timeoutMs = 15_000): Promise<Json> {
    const id = ++this.#nextId;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex did not answer ${method}.`));
      }, timeoutMs);
      const pending: Pending = {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      this.#pending.set(id, pending);
      try {
        this.#write({ id, method, params });
      } catch (err) {
        this.#pending.delete(id);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  watch(threadId: string, handler: Handler): () => void {
    if (this.failure) throw this.failure;
    if (this.#threads.has(threadId)) throw new Error('This Codex thread already has an active run.');
    this.#threads.set(threadId, handler);
    return () => { this.#threads.delete(threadId); };
  }

  reply(id: string | number, result: Json): void {
    if (!this.failure) this.#write({ id, result });
  }

  rejectRequest(id: string | number): void {
    if (!this.failure) this.#write({ id, error: { code: -32601, message: 'Request unavailable in Conductor.' } });
  }

  close(error = new Error('Codex App Server stopped.')): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const handler of this.#threads.values()) handler({ method: 'closed', params: { message: error.message } });
    this.#threads.clear();
    this.#process.kill();
  }
}

let current: CodexClient | null = null;
let starting: Promise<CodexClient> | null = null;

export type CodexConnection = Pick<CodexClient, 'call' | 'watch' | 'reply' | 'rejectRequest' | 'close'>;

export const codexRuntime = {
  client(): Promise<CodexConnection> {
    if (starting) return starting;
    if (current && !current.failure) return Promise.resolve(current);
    current = new CodexClient();
    starting = current.initialize().finally(() => { starting = null; });
    return starting;
  },
};

export function stopCodex(): void {
  current?.close();
}
