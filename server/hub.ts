import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import {
  HISTORY_BYTES, MAX_BUFFERED_BYTES, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES,
  isRecord, validSize,
  type AgentServerMessage, type ViewerServerMessage, type TerminalInfo,
} from '../shared/protocol.js';
import { Auth, bearerToken, cookieToken, type Identity } from './auth.js';
import type { HubConfig } from './config.js';

interface Peer {
  ws: WebSocket;
  identity: Identity;
  token: string;
  alive: boolean;
  watching?: string;
  terminalId?: string;
  rate: { count: number; since: number };
}

interface Terminal {
  info: TerminalInfo;
  owner: string;
  resumeToken: string;
  agent?: Peer;
  controller?: Peer;
  history: string[];
  historyBytes: number;
  lastSeq: number;
  inactiveAt?: number;
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Hub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  private readonly peers = new Set<Peer>();
  private readonly terminals = new Map<string, Terminal>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly server: Server,
    private readonly auth: Auth,
    private readonly config: HubConfig,
    private readonly allowOrigin: (request: IncomingMessage) => boolean,
  ) {
    server.on('upgrade', this.upgrade);
    this.timer = setInterval(() => this.sweep(), 15000);
    this.timer.unref();
  }

  list(username: string): TerminalInfo[] {
    return [...this.terminals.values()].filter((item) => item.owner === username).map((item) => ({ ...item.info }));
  }

  revoke(token: string): void {
    for (const peer of this.peers) if (peer.token === token) peer.ws.close(4401, 'Signed out');
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.server.off('upgrade', this.upgrade);
    for (const peer of this.peers) peer.ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = request.url?.split('?')[0];
    const role = pathname === '/ws/agent' ? 'agent' : pathname === '/ws/browser' ? 'browser' : undefined;
    const token = role === 'agent' ? bearerToken(request) : cookieToken(request);
    const identity = this.auth.get(token, role);
    if (!role || !identity || !token || (role === 'browser' && !this.allowOrigin(request))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const userPeers = [...this.peers].filter((peer) => peer.identity.username === identity.username).length;
    if (this.peers.size >= 512 || userPeers >= 64) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      const peer: Peer = { ws, identity, token, alive: true, rate: { count: 0, since: Date.now() } };
      this.peers.add(peer);
      ws.on('pong', () => { peer.alive = true; });
      ws.on('message', (data, binary) => {
        if (!this.auth.get(peer.token, role)) {
          ws.close(4401, 'Authentication expired');
          return;
        }
        if (binary) { this.invalid(peer); return; }
        let message: unknown;
        try { message = JSON.parse(data.toString()); }
        catch { this.invalid(peer); return; }
        if (!isRecord(message) || typeof message.type !== 'string') { this.invalid(peer); return; }
        if (role === 'browser') {
          if (Date.now() - peer.rate.since >= 1000) peer.rate = { count: 0, since: Date.now() };
          if (++peer.rate.count > 250) { ws.close(4429, 'Input rate exceeded'); return; }
          this.viewerMessage(peer, message);
        } else this.agentMessage(peer, message);
      });
      ws.on('error', (error) => console.error(`WebSocket error (${identity.role}): ${error.message}`));
      ws.on('close', () => this.disconnected(peer));
      if (role === 'browser') this.send(peer, { type: 'sessions', sessions: this.list(identity.username) });
      else {
        const registrationTimer = setTimeout(() => {
          if (!peer.terminalId) ws.close(4400, 'Registration timeout');
        }, 10000);
        registrationTimer.unref();
        ws.once('close', () => clearTimeout(registrationTimer));
      }
    });
  };

  private send(peer: Peer, message: AgentServerMessage | ViewerServerMessage): boolean {
    if (peer.ws.readyState !== WebSocket.OPEN) return false;
    if (peer.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      peer.ws.close(1013, 'Slow connection; reconnect to resume');
      return false;
    }
    peer.ws.send(JSON.stringify(message));
    return true;
  }

  private invalid(peer: Peer): void {
    this.send(peer, { type: 'error', code: 'invalid_message', message: 'Invalid terminal protocol message.' });
    peer.ws.close(4400, 'Invalid message');
  }

  private error(peer: Peer, code: string, message: string): void {
    this.send(peer, { type: 'error', code, message });
  }

  private agentMessage(peer: Peer, message: Record<string, unknown>): void {
    if (message.type === 'reauthenticate') {
      const renewedToken = message.token;
      const identity = typeof renewedToken === 'string' ? this.auth.get(renewedToken, 'agent') : undefined;
      if (typeof renewedToken !== 'string' || !identity || identity.username !== peer.identity.username) {
        this.error(peer, 'authentication_failed', 'Renewed agent token is invalid, expired, or belongs to another user.');
        peer.ws.close(4401, 'Authentication renewal failed');
        return;
      }
      const previousToken = peer.token;
      peer.token = renewedToken;
      peer.identity = identity;
      if (previousToken !== peer.token) this.auth.revoke(previousToken);
      this.send(peer, { type: 'authenticated', expiresAt: identity.expiresAt });
      return;
    }
    if (message.type === 'register') {
      if (peer.terminalId || !text(message.name, 100) || !text(message.hostname, 255)
        || !text(message.command, 1024) || !validSize(message.cols, message.rows)) {
        this.invalid(peer); return;
      }
      let terminal: Terminal | undefined;
      if (message.sessionId !== undefined) {
        if (typeof message.sessionId !== 'string' || typeof message.resumeToken !== 'string') {
          this.invalid(peer); return;
        }
        terminal = this.terminals.get(message.sessionId);
        if (!terminal) {
          this.error(peer, 'session_missing', 'Previous terminal no longer exists. Register a new terminal.');
          return;
        }
        if (terminal.owner !== peer.identity.username || !sameSecret(terminal.resumeToken, message.resumeToken)
          || terminal.info.status === 'exited' || terminal.agent) {
          this.error(peer, 'resume_denied', 'Terminal cannot be resumed.');
          peer.ws.close(4403, 'Resume denied');
          return;
        }
      } else {
        if (this.terminals.size >= 256 || this.list(peer.identity.username).length >= 32) {
          this.error(peer, 'capacity', 'Terminal capacity reached. Inactive terminals expire after 30 minutes.');
          peer.ws.close(4429, 'Terminal capacity reached');
          return;
        }
        terminal = {
          info: {
            id: randomUUID(), name: message.name, hostname: message.hostname, command: message.command,
            cols: message.cols as number, rows: message.rows as number,
            status: 'online', createdAt: new Date().toISOString(),
          },
          owner: peer.identity.username, resumeToken: randomBytes(32).toString('base64url'),
          history: [], historyBytes: 0, lastSeq: 0,
        };
        this.terminals.set(terminal.info.id, terminal);
      }
      terminal.agent = peer;
      terminal.info.status = 'online';
      terminal.inactiveAt = undefined;
      terminal.info.cols = message.cols as number;
      terminal.info.rows = message.rows as number;
      peer.terminalId = terminal.info.id;
      this.send(peer, {
        type: 'registered', sessionId: terminal.info.id,
        resumeToken: terminal.resumeToken, lastSeq: terminal.lastSeq,
      });
      this.broadcastState(terminal);
      this.broadcastList(terminal.owner);
      return;
    }
    const terminal = peer.terminalId ? this.terminals.get(peer.terminalId) : undefined;
    if (!terminal || terminal.agent !== peer || terminal.info.status !== 'online') { this.invalid(peer); return; }
    switch (message.type) {
      case 'output': {
        if (!Number.isSafeInteger(message.seq) || (message.seq as number) < 1
          || typeof message.data !== 'string' || message.data.length === 0 || Buffer.byteLength(message.data) > MAX_OUTPUT_BYTES) {
          this.invalid(peer); return;
        }
        const seq = message.seq as number;
        if (seq <= terminal.lastSeq) { this.send(peer, { type: 'ack', seq: terminal.lastSeq }); return; }
        // A server restart can discard acknowledged history. The CLI may resume at a later sequence.
        terminal.lastSeq = seq;
        const tail = terminal.history.length - 1;
        if (tail >= 0 && terminal.history[tail]!.length < 8192) terminal.history[tail] += message.data;
        else terminal.history.push(message.data);
        terminal.historyBytes += Buffer.byteLength(message.data);
        while (terminal.historyBytes > HISTORY_BYTES && terminal.history.length > 1) {
          terminal.historyBytes -= Buffer.byteLength(terminal.history.shift()!);
        }
        for (const viewer of this.peers) {
          if (viewer.watching === terminal.info.id) this.send(viewer, { type: 'output', sessionId: terminal.info.id, data: message.data });
        }
        this.send(peer, { type: 'ack', seq });
        break;
      }
      case 'resized':
        if (!validSize(message.cols, message.rows)) { this.invalid(peer); return; }
        terminal.info.cols = message.cols as number;
        terminal.info.rows = message.rows as number;
        this.broadcastState(terminal);
        break;
      case 'exit':
        if (!Number.isInteger(message.exitCode)) { this.invalid(peer); return; }
        terminal.info.status = 'exited';
        terminal.info.exitCode = message.exitCode as number;
        terminal.inactiveAt = Date.now();
        this.broadcastState(terminal);
        this.broadcastList(terminal.owner);
        peer.ws.close(1000, 'Terminal exited');
        break;
      default: this.invalid(peer);
    }
  }

  private viewerMessage(peer: Peer, message: Record<string, unknown>): void {
    if (message.type === 'unwatch') {
      this.unwatch(peer);
      return;
    }
    if (message.type === 'watch') {
      const terminal = typeof message.sessionId === 'string' ? this.terminals.get(message.sessionId) : undefined;
      if (!terminal || terminal.owner !== peer.identity.username) {
        this.error(peer, 'not_found', 'Terminal not found.'); return;
      }
      this.unwatch(peer);
      peer.watching = terminal.info.id;
      if (!terminal.controller) terminal.controller = peer;
      this.send(peer, {
        type: 'snapshot', session: terminal.info, history: terminal.history.join(''),
        controlling: terminal.controller === peer,
      });
      this.broadcastState(terminal);
      return;
    }
    const terminal = peer.watching ? this.terminals.get(peer.watching) : undefined;
    if (!terminal || terminal.owner !== peer.identity.username) {
      this.error(peer, 'not_watching', 'Select a terminal first.'); return;
    }
    if (message.type === 'control') {
      terminal.controller = peer;
      this.broadcastState(terminal);
      return;
    }
    if (terminal.controller !== peer) {
      this.error(peer, 'read_only', 'Another browser controls this terminal. Take control before typing.'); return;
    }
    if (terminal.info.status !== 'online' || !terminal.agent) {
      this.error(peer, 'offline', 'Terminal is not connected.'); return;
    }
    if (message.type === 'input') {
      if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > MAX_INPUT_BYTES) {
        this.invalid(peer); return;
      }
      if (!this.send(terminal.agent, { type: 'input', data: message.data })) {
        this.error(peer, 'offline', 'Input was not delivered. Wait for the agent to reconnect.');
      }
    } else if (message.type === 'resize') {
      if (!validSize(message.cols, message.rows)) { this.invalid(peer); return; }
      if (!this.send(terminal.agent, { type: 'resize', cols: message.cols as number, rows: message.rows as number })) {
        this.error(peer, 'offline', 'Resize was not delivered. Wait for the agent to reconnect.');
      }
    } else this.invalid(peer);
  }

  private unwatch(peer: Peer): void {
    const terminal = peer.watching ? this.terminals.get(peer.watching) : undefined;
    peer.watching = undefined;
    if (terminal?.controller === peer) {
      terminal.controller = undefined;
      this.broadcastState(terminal);
    }
  }

  private disconnected(peer: Peer): void {
    this.peers.delete(peer);
    this.unwatch(peer);
    const terminal = peer.terminalId ? this.terminals.get(peer.terminalId) : undefined;
    if (terminal?.agent === peer) {
      terminal.agent = undefined;
      if (terminal.info.status !== 'exited') terminal.info.status = 'disconnected';
      terminal.inactiveAt = Date.now();
      this.broadcastState(terminal);
      this.broadcastList(terminal.owner);
    }
  }

  private broadcastState(terminal: Terminal): void {
    for (const peer of this.peers) {
      if (peer.watching === terminal.info.id) {
        this.send(peer, { type: 'state', session: terminal.info, controlling: terminal.controller === peer });
      }
    }
  }

  private broadcastList(username: string): void {
    const sessions = this.list(username);
    for (const peer of this.peers) {
      if (peer.identity.role === 'browser' && peer.identity.username === username) {
        this.send(peer, { type: 'sessions', sessions });
      }
    }
  }

  private sweep(): void {
    this.auth.prune();
    for (const peer of this.peers) {
      if (!this.auth.get(peer.token, peer.identity.role)) peer.ws.close(4401, 'Authentication expired');
      else if (!peer.alive) peer.ws.terminate();
      else { peer.alive = false; peer.ws.ping(); }
    }
    for (const [id, terminal] of this.terminals) {
      if (terminal.inactiveAt && Date.now() - terminal.inactiveAt > this.config.terminalTtlMs) {
        for (const peer of this.peers) {
          if (peer.watching === id) {
            peer.watching = undefined;
            this.error(peer, 'expired', 'Terminal history expired.');
          }
        }
        this.terminals.delete(id);
        this.broadcastList(terminal.owner);
      }
    }
  }
}
