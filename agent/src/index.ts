#!/usr/bin/env node
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import * as pty from 'node-pty';
import { isRecord, isAgentServerMessage, MAX_INPUT_BYTES, type AgentMessage, type AgentServerMessage } from './protocol.js';
import { promptPassword } from './prompt.js';
import { renewalDelay } from './token.js';

interface Output {
  seq: number;
  data: string;
  bytes: number;
  sentOn: number;
}

class LoginError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const HELP = `Agent Hub - share a real terminal with your authenticated web UI

Usage:
  agent-hub --user <username> [options] -- <command> [arguments...]
  npm start -- --user <username> [options] -- <command> [arguments...]

Options:
  --server <url>         Hub origin (default: AGENT_HUB_SERVER or http://127.0.0.1:3000)
  --user <username>      Hub username (or AGENT_HUB_USER)
  --name <name>          Terminal name (default: hostname + command)
  --cwd <directory>      Child working directory (default: current directory)
  --no-local-input      Disable typing in this local terminal
  --allow-insecure-http Allow unencrypted HTTP to a non-loopback hub (trusted LAN only)
  --help                Show this help

Password is prompted without echo. For automation, set AGENT_HUB_PASSWORD.
If no command is supplied, your platform's default shell is used.
Local and remote input share the same terminal; closing the browser does not stop it.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: 'string' },
      user: { type: 'string' },
      name: { type: 'string' },
      cwd: { type: 'string' },
      'no-local-input': { type: 'boolean', default: false },
      'allow-insecure-http': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) { console.log(HELP); return; }
  const serverUrl = new URL(values.server ?? process.env.AGENT_HUB_SERVER ?? 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(serverUrl.protocol) || serverUrl.username || serverUrl.password
    || serverUrl.pathname !== '/' || serverUrl.search || serverUrl.hash) {
    throw new Error('--server must be an HTTP(S) origin, with no path, credentials, query, or fragment.');
  }
  if (serverUrl.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(serverUrl.hostname)) {
    if (!values['allow-insecure-http']) throw new Error('Remote hubs require HTTPS. For a trusted LAN only, explicitly use --allow-insecure-http.');
    console.error('[hub] WARNING: Password and terminal traffic will be sent without encryption.');
  }
  const username = values.user ?? process.env.AGENT_HUB_USER;
  if (!username) throw new Error('Provide --user <username> or set AGENT_HUB_USER.');
  const password = process.env.AGENT_HUB_PASSWORD ?? await promptPassword(`Password for ${username}: `);
  delete process.env.AGENT_HUB_PASSWORD;
  const command = positionals[0] ?? (process.platform === 'win32' ? process.env.COMSPEC ?? 'cmd.exe' : process.env.SHELL ?? '/bin/sh');
  const args = positionals.slice(1);
  const name = values.name ?? `${os.hostname()} / ${path.basename(command)}`;
  if (!name.length || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('--name must be 1-100 printable characters.');
  let cols = Math.max(20, Math.min(500, process.stdout.columns || 100));
  let rows = Math.max(5, Math.min(200, process.stdout.rows || 30));
  let terminal: pty.IPty | undefined;
  let terminalDisposed = false;
  let ws: WebSocket | undefined;
  let token: { value: string; expiresAt: number } | undefined;
  let registration: { sessionId: string; resumeToken: string } | undefined;
  let registered = false;
  let connection = 0;
  let seq = 0;
  let outputs: Output[] = [];
  let queuedBytes = 0;
  let childExit: number | undefined;
  let exitSent = false;
  let stopping = false;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let renewalTimer: NodeJS.Timeout | undefined;
  let renewalTimeout: NodeJS.Timeout | undefined;
  let renewalRetries = 0;
  let retries = 0;
  let lastSeen = Date.now();
  let paused = false;
  let stdoutBlocked = false;
  const started = Date.now();
  const rawBefore = process.stdin.isRaw;

  const log = (message: string) => process.stderr.write(`\r\n[hub] ${message}\r\n`);
  const send = (message: AgentMessage): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  };
  const flowControl = () => {
    const shouldPause = stdoutBlocked || queuedBytes >= (paused ? 256 : 512) * 1024;
    if (!terminal || shouldPause === paused) return;
    paused = shouldPause;
    if (paused) terminal.pause();
    else terminal.resume();
  };
  const cleanUp = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(pumpTimer);
    clearInterval(healthTimer);
    clearTimeout(reconnectTimer);
    clearTimeout(renewalTimer);
    clearTimeout(renewalTimeout);
    process.stdin.off('data', onInput);
    process.stdout.off('resize', onResize);
    process.stdout.off('drain', onDrain);
    if (process.stdin.isTTY) process.stdin.setRawMode(rawBefore ?? false);
    process.stdin.pause();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (terminal && childExit === undefined && !terminalDisposed) {
      terminalDisposed = true;
      terminal.kill();
    }
    if (ws?.readyState === WebSocket.OPEN) ws.close(1000, 'CLI finished');
    else ws?.terminate();
  };
  const fail = (message: string) => {
    log(message);
    process.exitCode = 1;
    cleanUp();
  };
  const pump = () => {
    if (!registered || !ws || ws.readyState !== WebSocket.OPEN) return;
    for (const item of outputs) {
      if (ws.bufferedAmount > 256 * 1024) break;
      if (item.sentOn !== connection) {
        if (send({ type: 'output', seq: item.seq, data: item.data })) item.sentOn = connection;
      }
    }
    if (childExit !== undefined && outputs.length === 0 && !exitSent) {
      exitSent = true;
      send({ type: 'exit', exitCode: childExit });
    }
  };
  const onDrain = () => { stdoutBlocked = false; flowControl(); };
  const onInput = (data: Buffer) => { if (terminal && childExit === undefined) terminal.write(data.toString('utf8')); };
  const onResize = () => {
    cols = Math.max(20, Math.min(500, process.stdout.columns || cols));
    rows = Math.max(5, Math.min(200, process.stdout.rows || rows));
    if (resizeTerminal(cols, rows) && registered) send({ type: 'resized', cols, rows });
  };
  const resizeTerminal = (nextCols: number, nextRows: number): boolean => {
    if (!terminal || childExit !== undefined) return false;
    try {
      terminal.resize(nextCols, nextRows);
      return true;
    } catch (error) {
      log(`PTY resize failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const onSignal = () => {
    process.exitCode = 130;
    cleanUp();
  };
  const spawnTerminal = () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key.toUpperCase() !== 'AGENT_HUB_PASSWORD') env[key] = value;
    }
    env.TERM = 'xterm-256color';
    try {
      terminal = pty.spawn(command, args, {
        name: 'xterm-256color', cols, rows, cwd: values.cwd ?? process.cwd(), env,
      });
    } catch (error) {
      send({ type: 'exit', exitCode: 1 });
      fail(`Could not start ${command}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    terminal.onData((data) => {
      if (stopping) return;
      if (!process.stdout.write(data)) stdoutBlocked = true;
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(offset + 8192, data.length);
        const last = data.charCodeAt(end - 1);
        if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
        const chunk = data.slice(offset, end);
        const bytes = Buffer.byteLength(chunk);
        outputs.push({ seq: ++seq, data: chunk, bytes, sentOn: 0 });
        queuedBytes += bytes;
        offset = end;
      }
      if (queuedBytes > 4 * 1024 * 1024) { fail('Output buffer exceeded 4 MiB while disconnected. Child stopped rather than silently losing output.'); return; }
      flowControl();
      pump();
    });
    terminal.onExit(({ exitCode, signal }) => {
      if (stopping) return;
      childExit = signal ? 128 + signal : exitCode;
      process.stdin.pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(rawBefore ?? false);
      pump();
    });
    process.stdout.on('drain', onDrain);
    process.stdout.on('resize', onResize);
    if (!values['no-local-input']) {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.on('data', onInput);
      process.stdin.resume();
    }
  };
  const register = () => send({
    type: 'register', name, hostname: os.hostname(), command: command.slice(0, 1024), cols, rows,
    ...registration,
  });
  const acknowledge = (lastSeq: number) => {
    outputs = outputs.filter((item) => {
      if (item.seq > lastSeq) return true;
      queuedBytes -= item.bytes;
      return false;
    });
    flowControl();
  };
  const onMessage = (raw: string) => {
    let message: AgentServerMessage;
    try {
      const decoded: unknown = JSON.parse(raw);
      if (!isAgentServerMessage(decoded)) throw new Error('Invalid message shape.');
      message = decoded;
    } catch { fail('Hub sent an invalid protocol message.'); return; }
    lastSeen = Date.now();
    switch (message.type) {
      case 'registered':
        registered = true;
        retries = 0;
        registration = { sessionId: message.sessionId, resumeToken: message.resumeToken };
        acknowledge(message.lastSeq);
        log(`Registered "${name}" (${message.sessionId}) at ${serverUrl.origin}`);
        if (!terminal) spawnTerminal();
        scheduleRenewal();
        pump();
        break;
      case 'authenticated':
        clearTimeout(renewalTimeout);
        if (!token || message.expiresAt !== token.expiresAt) {
          fail('Hub confirmed an unexpected authentication expiration.'); return;
        }
        renewalRetries = 0;
        log('Agent token renewed without interrupting the terminal.');
        scheduleRenewal();
        break;
      case 'ack': acknowledge(message.seq); pump(); break;
      case 'input':
        if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > MAX_INPUT_BYTES) {
          fail('Hub sent invalid terminal input.'); return;
        }
        if (childExit === undefined) terminal?.write(message.data);
        break;
      case 'resize':
        if (childExit === undefined) {
          cols = message.cols;
          rows = message.rows;
          if (resizeTerminal(cols, rows)) send({ type: 'resized', cols, rows });
        }
        break;
      case 'error':
        if (message.code === 'session_missing') {
          log('Hub no longer has this terminal. Re-registering; acknowledged history was not retained by the server.');
          registration = undefined;
          register();
        } else if (message.code === 'resume_denied') {
          log('Previous connection has not been released yet. Retrying.');
          ws?.close();
        } else fail(`Hub rejected the connection: ${message.message}`);
        break;
      default: fail('Hub sent an unknown protocol message.');
    }
  };
  const scheduleReconnect = () => {
    if (stopping) return;
    if (!terminal && Date.now() - started > 30000) { fail('Could not register within 30 seconds. Check the hub address and credentials.'); return; }
    const delay = Math.min(1000 * 2 ** Math.min(retries++, 4), 15000);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { void connect(); }, delay);
  };
  const login = async (): Promise<{ value: string; expiresAt: number }> => {
    const response = await fetch(new URL('/api/agent/login', serverUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(10000),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const detail = isRecord(body) && typeof body.error === 'string' ? body.error : response.statusText;
      throw new LoginError(response.status, `Login failed (${response.status}): ${detail}`);
    }
    if (!isRecord(body) || typeof body.token !== 'string' || body.token.length === 0
      || typeof body.expiresAt !== 'number' || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= Date.now()) {
      throw new Error('Invalid login response from hub.');
    }
    return { value: body.token, expiresAt: body.expiresAt };
  };
  const scheduleRenewal = () => {
    clearTimeout(renewalTimer);
    if (stopping || !registered || !token || childExit !== undefined) return;
    renewalTimer = setTimeout(() => { void renew(); }, renewalDelay(token.expiresAt));
  };
  const renew = async () => {
    const socket = ws;
    if (stopping || !registered || !socket || socket.readyState !== WebSocket.OPEN || !token) return;
    const previous = token;
    try {
      const renewed = await login();
      if (stopping || ws !== socket || socket.readyState !== WebSocket.OPEN || !registered) return;
      token = renewed;
      send({ type: 'reauthenticate', token: renewed.value });
      renewalTimeout = setTimeout(() => {
        if (!stopping && ws === socket) {
          log('Token renewal confirmation timed out. Reconnecting with the renewed token.');
          socket.terminate();
        }
      }, Math.min(10000, Math.max(1, previous.expiresAt - Date.now())));
    } catch (error) {
      if (stopping || ws !== socket || socket.readyState !== WebSocket.OPEN || !registered) return;
      log(`Token renewal failed: ${error instanceof Error ? error.message : String(error)}`);
      const remaining = previous.expiresAt - Date.now();
      if (remaining <= 0) {
        log('Agent token expired before renewal succeeded. Reconnecting to authenticate again.');
        socket.terminate();
        return;
      }
      const delay = Math.min(1000 * 2 ** Math.min(renewalRetries++, 4), 15000, Math.max(1, remaining / 2));
      renewalTimer = setTimeout(() => { void renew(); }, delay);
    }
  };
  const connect = async () => {
    if (stopping) return;
    registered = false;
    exitSent = false;
    try {
      if (!token || token.expiresAt < Date.now() + 30000) {
        token = await login();
      }
      if (stopping) return;
      const socketUrl = new URL('/ws/agent', serverUrl);
      socketUrl.protocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(socketUrl, {
        headers: { Authorization: `Bearer ${token.value}` }, handshakeTimeout: 10000,
        maxPayload: 128 * 1024, perMessageDeflate: false,
      });
      const socket = ws;
      connection++;
      lastSeen = Date.now();
      socket.on('open', () => { register(); });
      socket.on('ping', () => { lastSeen = Date.now(); });
      socket.on('message', (data) => onMessage(data.toString()));
      socket.on('error', (error) => {
        if (stopping) return;
        if (error.message.includes('401')) token = undefined;
        log(`Connection error: ${error.message}`);
      });
      socket.on('close', (code) => {
        if (socket !== ws || stopping) return;
        clearTimeout(renewalTimer);
        clearTimeout(renewalTimeout);
        registered = false;
        if (exitSent && childExit !== undefined && code === 1000) {
          process.exitCode = childExit;
          cleanUp();
          // Native PTY workers can outlive the child on Windows. Exit only after
          // the hub acknowledged all output and both local output streams drained.
          process.stdout.write('', () => process.stderr.write('', () => process.exit(childExit)));
          return;
        }
        if (code === 4401) token = undefined;
        log('Disconnected. Reconnecting; terminal output is buffered and the child pauses if the buffer fills.');
        scheduleReconnect();
      });
    } catch (error) {
      if (stopping) return;
      if (error instanceof LoginError && error.status >= 400 && error.status < 500) {
        fail(error.message);
        return;
      }
      log(`Cannot connect: ${error instanceof Error ? error.message : String(error)}`);
      scheduleReconnect();
    }
  };

  const pumpTimer = setInterval(pump, 50);
  const healthTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN && Date.now() - lastSeen > 45000) ws.terminate();
  }, 10000);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  await connect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
