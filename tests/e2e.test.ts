import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import { chromium, type Page } from 'playwright';
import { fixture, PASSWORD } from './helpers.js';
import { isRecord } from '../shared/protocol.js';
import { AuthBusyError } from '../server/auth.js';

async function waitUntil(check: () => Promise<boolean> | boolean, description: () => string, timeout = 20000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out: ${description()}`);
}

async function signIn(page: Page, origin: string): Promise<void> {
  await page.goto(origin);
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Agent terminals' }).waitFor();
}

async function screenContains(page: Page, text: string): Promise<boolean> {
  const screen = page.locator('[data-testid="terminal"]');
  if (await screen.count() === 0) return false;
  return (await screen.textContent())?.includes(text) ?? false;
}

async function typeInTerminal(page: Page, value: string): Promise<void> {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
}

test('production UI + authenticated server + real CLI PTY work end to end, including server restart', { timeout: 120000 }, async (t) => {
  const hub = await fixture(t, { webDir: path.resolve('dist/web') });
  const browser = await chromium.launch({
    ...(process.env.HUB_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.HUB_TEST_BROWSER_EXECUTABLE }
      : { channel: process.env.HUB_TEST_BROWSER_CHANNEL ?? 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto(hub.origin);
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Invalid username or password.' }).waitFor();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Your next terminal starts here.' }).waitFor();
  t.diagnostic('Browser login and empty state complete.');

  const child = spawn(process.execPath, [
    path.resolve('agent/dist/index.js'), '--server', hub.origin, '--user', 'alice',
    '--name', 'E2E terminal', '--no-local-input', '--', process.execPath,
    path.resolve('tests/fixtures/interactive-child.mjs'),
  ], {
    env: { ...process.env, AGENT_HUB_PASSWORD: PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  let completed = false;
  t.after(() => { if (!completed) t.diagnostic(`CLI output: ${JSON.stringify(stdout)}\nCLI logs: ${stderr}`); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
  });
  await waitUntil(() => stdout.includes('PTY_READY stdin=true stdout=true') && stdout.includes('PASSWORD_IN_CHILD=') && stdout.includes('ANSI_COLOR_OK'), () => `PTY startup\n${stdout}\n${stderr}`);
  assert.ok(stdout.includes('PASSWORD_IN_CHILD=absent'), 'Password must not leak into the agent child environment.');
  assert.match(stdout, /\u001b\[(?:0;)?32m[\r\n]*ANSI_COLOR_OK/, `PTY must preserve ANSI color (ConPTY may normalize newlines and reset codes): ${JSON.stringify(stdout)}`);
  await waitUntil(() => screenContains(page, 'PTY_READY stdin=true stdout=true'), () => `Browser terminal output\n${stdout}\n${stderr}`);
  const color = await page.locator('.xterm-rows span').filter({ hasText: /^ANSI_COLOR_OK$/ }).first().evaluate((element) => getComputedStyle(element).color);
  assert.notEqual(color, 'rgb(217, 224, 238)', 'ANSI green should render differently from the default terminal foreground.');
  await waitUntil(async () => (await page.getByText('You have control', { exact: true }).count()) === 1, () => 'Initial browser controller');
  await typeInTerminal(page, 'hello-from-browser');
  await waitUntil(() => screenContains(page, 'REMOTE_REPLY:resworb-morf-olleh'), () => `Real browser input\n${stdout}\n${stderr}`);
  t.diagnostic('Real PTY output and browser input complete.');

  await page.setViewportSize({ width: 1100, height: 760 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await typeInTerminal(page, 'size');
  await waitUntil(async () => {
    const response = await page.request.get(`${hub.origin}/api/sessions`);
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.sessions) || !isRecord(body.sessions[0])) return false;
    const { cols, rows } = body.sessions[0];
    return cols !== 100 && stdout.includes(`SIZE=${String(cols)}x${String(rows)}`);
  }, () => `Remote resize reached PTY\n${stdout}\n${stderr}`);
  t.diagnostic('Remote resize complete.');

  const observerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  observerContext.setDefaultTimeout(10000);
  const observer = await observerContext.newPage();
  await signIn(observer, hub.origin);
  await observer.getByText('Read only', { exact: true }).waitFor();
  await waitUntil(() => screenContains(observer, 'REMOTE_REPLY:resworb-morf-olleh'), () => 'History replay in second browser');
  await observer.getByRole('button', { name: 'Take control' }).click();
  await observer.getByText('You have control', { exact: true }).waitFor();
  await page.getByText('Read only', { exact: true }).waitFor();
  await typeInTerminal(observer, 'second-browser');
  await waitUntil(() => screenContains(page, 'REMOTE_REPLY:resworb-dnoces'), () => 'Shared output after control transfer');
  await observer.getByRole('button', { name: 'Sign out' }).click();
  await observer.getByRole('heading', { name: 'Sign in to your hub' }).waitFor();
  await observerContext.close();
  await page.getByRole('button', { name: 'Take control' }).click();
  await page.getByText('You have control', { exact: true }).waitFor();
  t.diagnostic('Second browser, history, control transfer, and logout complete.');

  await hub.restart();
  t.diagnostic('Hub restart complete.');
  await page.getByRole('heading', { name: 'Sign in to your hub' }).waitFor({ timeout: 20000 });
  await signIn(page, hub.origin);
  await page.getByRole('heading', { name: 'E2E terminal', exact: true }).waitFor({ timeout: 30000 });
  await page.getByText('You have control', { exact: true }).waitFor();
  await typeInTerminal(page, 'after-restart');
  await waitUntil(() => screenContains(page, 'REMOTE_REPLY:tratser-retfa'), () => `CLI reconnect after server restart\n${stdout}\n${stderr}`, 30000);
  t.diagnostic('CLI reconnect and browser input after restart complete.');
  assert.ok(stderr.includes('Re-registering'), 'CLI must explain loss of server-side history after restart.');
  await typeInTerminal(page, 'exit');
  await page.getByText('Exited (0)', { exact: true }).waitFor();
  t.diagnostic('Browser received terminal exit.');
  await waitUntil(() => child.exitCode !== null, () => `CLI exit and native PTY resource cleanup\n${stderr}`, 10000);
  assert.equal(child.exitCode, 0, stderr);
  await waitUntil(() => screenContains(page, 'CHILD_GOODBYE'), () => 'Final PTY output before exit');
  assert.deepEqual(browserErrors, []);
  await page.reload();
  await page.getByText('Exited (0)', { exact: true }).waitFor();
  await waitUntil(() => screenContains(page, 'CHILD_GOODBYE'), () => 'History after browser refresh');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'E2E terminal', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile workspace should not overflow the page horizontally.');
  completed = true;
});

test('local wrapper supports a hidden interactive password, local keyboard input, cwd, and nonzero exit', { timeout: 45000 }, async (t) => {
  const hub = await fixture(t);
  const { cookie } = await hub.login('browser');
  const viewer = await hub.socket('browser', cookie);
  await viewer.next('sessions');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toUpperCase() !== 'AGENT_HUB_PASSWORD') env[key] = value;
  }
  const outer = spawn(process.execPath, [
    path.resolve('agent/tests/fixtures/local-terminal-driver.mjs'),
    path.resolve('agent/dist/index.js'), '--server', hub.origin, '--user', 'alice',
    '--name', 'Local keyboard terminal', '--cwd', hub.dataDir, '--', process.execPath,
    path.resolve('tests/fixtures/interactive-child.mjs'),
  ], { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let localOutput = '';
  let remoteOutput = '';
  outer.stdout.on('data', (data: Buffer) => { localOutput += data.toString(); });
  outer.stderr.on('data', (data: Buffer) => { localOutput += data.toString(); });
  t.after(async () => {
    if (outer.exitCode === null) {
      outer.kill('SIGTERM');
      await Promise.race([once(outer, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
  });
  viewer.ws.on('message', (data) => {
    const message: unknown = JSON.parse(data.toString());
    if (isRecord(message)) {
      if (typeof message.data === 'string') remoteOutput += message.data;
      if (typeof message.history === 'string') remoteOutput += message.history;
    }
  });
  await waitUntil(() => localOutput.includes('Password for alice:'), () => `Hidden password prompt\n${localOutput}`);
  outer.stdin.write(`${PASSWORD}\r`);
  const sessions = await viewer.next('sessions', (message) => Array.isArray(message.sessions) && message.sessions.length === 1);
  assert.ok(Array.isArray(sessions.sessions) && isRecord(sessions.sessions[0]));
  const id = sessions.sessions[0].id;
  viewer.send({ type: 'watch', sessionId: id });
  await viewer.next('snapshot');
  await waitUntil(() => localOutput.includes('PTY_READY stdin=true stdout=true') && localOutput.includes('agent>'), () => `Nested PTY startup\n${localOutput}`);
  assert.ok(!localOutput.includes(PASSWORD), 'Interactive password must not be echoed.');
  assert.ok(localOutput.includes(`CWD=${hub.dataDir}`), `--cwd must reach the child: ${JSON.stringify(localOutput)}`);
  outer.stdin.write('local-keyboard\r');
  await waitUntil(() => remoteOutput.includes('REMOTE_REPLY:draobyek-lacol'), () => `Local input relayed back to the server\n${localOutput}\n${remoteOutput}`);
  outer.stdin.write('exit7\r');
  await viewer.next('state', (message) => isRecord(message.session) && message.session.status === 'exited' && message.session.exitCode === 7);
  await waitUntil(() => outer.exitCode !== null, () => `Nonzero wrapper exit\n${localOutput}`, 15000);
  assert.equal(outer.exitCode, 7);
  assert.ok(!localOutput.includes('AttachConsole failed'), 'Natural PTY exit must not invoke a stale Windows process handle.');
});

test('built user-management and server entry points start a real service without default credentials', { timeout: 30000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-startup-'));
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUB_HOST: '127.0.0.1', HUB_PORT: String(port), HUB_DATA_DIR: dataDir,
    AGENT_HUB_PASSWORD: PASSWORD,
  };
  delete env.HUB_PUBLIC_URL;
  const execFile = promisify(execFileCallback);
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const added = await execFile(process.execPath, [path.resolve('dist/server/users-cli.js'), 'startup-user'], { env });
  assert.match(added.stdout, /created/);
  await assert.rejects(execFile(process.execPath, [path.resolve('dist/server/users-cli.js'), 'startup-user'], { env }), /already exists/);
  await execFile(process.execPath, [path.resolve('dist/server/users-cli.js'), 'startup-user', '--reset'], { env });
  delete env.AGENT_HUB_PASSWORD;
  const server = spawn(process.execPath, [path.resolve('dist/server/index.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  server.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  server.stderr.on('data', (data: Buffer) => { output += data.toString(); });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
  });
  await waitUntil(() => output.includes('Agent Hub listening at'), () => `Production server startup\n${output}`);
  assert.deepEqual(await (await fetch(`${origin}/api/health`)).json(), { status: 'ok' });
  assert.match(await (await fetch(origin)).text(), /<title>Agent Hub<\/title>/);
  assert.equal((await fetch(`${origin}/api/sessions`)).status, 401);
  const login = await fetch(`${origin}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'startup-user', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookies = login.headers.get('set-cookie');
  assert.ok(cookies);
  assert.ok(cookies.includes('HttpOnly') && cookies.includes('SameSite=Strict'));
  assert.deepEqual(await (await fetch(`${origin}/api/sessions`, { headers: { Cookie: cookies.split(';')[0]! } })).json(), { sessions: [] });
});

test('CLI proactively rotates short-lived tokens, retries a temporary login failure, and keeps its PTY and socket', { timeout: 35000 }, async (t) => {
    const hub = await fixture(t, { sessionTtlMs: 4000 });
    const browser = hub.auth.issue('alice', 'browser');
    browser.identity.expiresAt = Date.now() + 30000;
    const viewer = await hub.socket('browser', `hub_session=${browser.token}`);
    await viewer.next('sessions');
    let attempts = 0;
    const verify = hub.auth.verify.bind(hub.auth);
    hub.auth.verify = async (username, password) => {
      if (++attempts === 2) throw new AuthBusyError();
      return verify(username, password);
    };
    const issued: Array<{ token: string; expiresAt: number; issuedAt: number }> = [];
    const issue = hub.auth.issue.bind(hub.auth);
    hub.auth.issue = (username, role) => {
      const result = issue(username, role);
      if (role === 'agent') issued.push({ token: result.token, expiresAt: result.identity.expiresAt, issuedAt: Date.now() });
      return result;
    };
    let upgrades = 0;
    hub.server.on('upgrade', (request) => { if (request.url === '/ws/agent') upgrades++; });
    const statuses: string[] = [];
    viewer.ws.on('message', (data) => {
      const message: unknown = JSON.parse(data.toString());
      if (isRecord(message) && message.type === 'state' && isRecord(message.session)) statuses.push(String(message.session.status));
    });
    const child = spawn(process.execPath, [
      path.resolve('agent/dist/index.js'), '--server', hub.origin, '--user', 'alice',
      '--name', 'Renewal terminal', '--no-local-input', '--', process.execPath,
      path.resolve('tests/fixtures/interactive-child.mjs'),
    ], {
      env: { ...process.env, AGENT_HUB_PASSWORD: PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
      }
    });
    const sessions = await viewer.next('sessions', (message) => Array.isArray(message.sessions) && message.sessions.length === 1);
    assert.ok(Array.isArray(sessions.sessions) && isRecord(sessions.sessions[0]));
    const id = sessions.sessions[0].id;
    viewer.send({ type: 'watch', sessionId: id });
    await viewer.next('snapshot');
    await waitUntil(() => stdout.includes('agent>'), () => `PTY prompt\n${stdout}\n${stderr}`);
    viewer.send({ type: 'input', data: 'before-renewal\r' });
    await waitUntil(() => stdout.includes('REMOTE_REPLY:lawener-erofeb'), () => `Input before renewal\n${stderr}`);
    await waitUntil(() => (stderr.match(/Agent token renewed/g) ?? []).length >= 2, () => `Two proactive renewals\n${stderr}`, 20000);
    assert.match(stderr, /Token renewal failed: Login failed \(503\)/);
    assert.equal(upgrades, 1, 'Renewal must not reconnect the agent WebSocket.');
    assert.ok(!statuses.includes('disconnected'), 'Renewal must not mark the terminal offline.');
    assert.equal(hub.hub.list('alice')[0]?.id, id);
    for (let index = 1; index < issued.length; index++) {
      assert.ok(issued[index]!.issuedAt < issued[index - 1]!.expiresAt, 'Replacement must be acquired before the previous token expires.');
      assert.equal(hub.auth.get(issued[index - 1]!.token), undefined, 'Previous token must be revoked after replacement.');
    }
    viewer.send({ type: 'input', data: 'after-renewal\r' });
    await waitUntil(() => stdout.includes('REMOTE_REPLY:lawener-retfa'), () => `Input after original token expiration\n${stdout}\n${stderr}`);
    viewer.send({ type: 'input', data: 'exit\r' });
    await viewer.next('state', (message) => isRecord(message.session) && message.session.status === 'exited');
    await waitUntil(() => child.exitCode !== null, () => `PTY exit\n${stderr}`);
    assert.equal(child.exitCode, 0);
});
