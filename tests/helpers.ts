import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import WebSocket from 'ws';
import { createHub } from '../server/app.js';
import { saveUser } from '../server/auth.js';
import { isRecord } from '../shared/protocol.js';
import type { HubConfig } from '../server/config.js';

export const PASSWORD = 'test-only-agent-password-2026';

export async function fixture(t: TestContext, options: { webDir?: string; sessionTtlMs?: number } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-test-'));
  await saveUser(dataDir, 'alice', PASSWORD);
  await saveUser(dataDir, 'bob', PASSWORD);
  const config: HubConfig = {
    host: '127.0.0.1', port: 0, dataDir,
    webDir: options.webDir ?? path.join(dataDir, 'no-web-build'),
    sessionTtlMs: options.sessionTtlMs ?? 60 * 60 * 1000,
    terminalTtlMs: 30 * 60 * 1000,
  };
  let hub = await createHub(config);
  const port = await hub.listen();
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => { await hub.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (route: string, body?: unknown, cookie?: string) => fetch(`${origin}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = async (role: 'browser' | 'agent', username = 'alice') => {
    const response = await request(role === 'browser' ? '/api/login' : '/api/agent/login', { username, password: PASSWORD });
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    assert.ok(isRecord(body));
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    return { cookie: cookie ?? '', token: typeof body.token === 'string' ? body.token : '', body };
  };
  const socket = async (role: 'browser' | 'agent', credential: string) => {
    const inbox = new Inbox(new WebSocket(`${origin.replace('http:', 'ws:')}/ws/${role}`, {
      headers: role === 'agent' ? { Authorization: `Bearer ${credential}` } : { Cookie: credential, Origin: origin },
    }));
    t.after(() => inbox.ws.terminate());
    await inbox.opened;
    return inbox;
  };
  const restart = async () => {
    await hub.close();
    hub = await createHub({ ...config, port });
    await hub.listen();
  };
  return { ...hub, origin, dataDir, request, login, socket, restart };
}

export type Message = Record<string, unknown>;

export class Inbox {
  readonly messages: Message[] = [];
  readonly opened: Promise<void>;
  private waiters: Array<{ predicate: (message: Message) => boolean; resolve: (message: Message) => void }> = [];

  constructor(readonly ws: WebSocket) {
    this.opened = new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('message', (raw) => {
      const message: unknown = JSON.parse(raw.toString());
      assert.ok(isRecord(message));
      const waiter = this.waiters.find((item) => item.predicate(message));
      if (waiter) {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve(message);
      } else this.messages.push(message);
    });
  }

  send(message: unknown): void { this.ws.send(JSON.stringify(message)); }

  next(type: string, predicate: (message: Message) => boolean = () => true, timeout = 8000): Promise<Message> {
    const match = (message: Message) => message.type === type && predicate(message);
    const index = this.messages.findIndex(match);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: match,
        resolve: (message: Message) => { clearTimeout(timer); resolve(message); },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error(`Timed out waiting for ${type}. Received: ${JSON.stringify(this.messages)}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }
}

export function register(inbox: Inbox, extra: Record<string, unknown> = {}): void {
  inbox.send({ type: 'register', name: 'Test terminal', hostname: 'test-node', command: 'test-shell', cols: 100, rows: 30, ...extra });
}

export function rejectedSocket(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 3000 });
    ws.on('error', () => {});
    ws.on('open', () => { ws.terminate(); reject(new Error('Socket unexpectedly accepted.')); });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode ?? 0);
    });
  });
}
