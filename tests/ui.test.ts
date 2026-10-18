import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixture, PASSWORD, register } from './helpers.js';

test('browser dimensions follow agent state, refit after agent reconnect, and obey protocol limits', { timeout: 60000 }, async (t) => {
  const hub = await fixture(t, { webDir: path.resolve('dist/web') });
  const browser = await chromium.launch({
    ...(process.env.HUB_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.HUB_TEST_BROWSER_EXECUTABLE }
      : { channel: process.env.HUB_TEST_BROWSER_CHANNEL ?? 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  let allowConnection = true;
  let disconnect: () => void = () => { assert.fail('Browser WebSocket has not connected.'); };
  await page.routeWebSocket('**/ws/browser', (route) => {
    if (!allowConnection) { route.close(); return; }
    const server = route.connectToServer();
    disconnect = () => {
      allowConnection = false;
      route.close({ code: 1001, reason: 'Test network interruption' });
      server.close();
    };
  });
  await page.goto(hub.origin);
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Agent terminals' }).waitFor();
  assert.match(await page.locator('.empty-state pre').innerText(), /^agent-hub --server http:\/\/127\.0\.0\.1:\d+ --user alice -- your-agent-command$/);
  const { token } = await hub.login('agent');
  const agent = await hub.socket('agent', token);
  register(agent);
  const registration = await agent.next('registered');
  const initial = await agent.next('resize');
  agent.send({ type: 'resized', cols: initial.cols, rows: initial.rows });
  await page.getByText('You have control', { exact: true }).waitFor();

  agent.send({ type: 'resized', cols: 73, rows: 19 });
  await page.waitForFunction(() => document.querySelectorAll('.xterm-rows > div').length === 19);
  const observer = await context.newPage();
  await observer.goto(hub.origin);
  await observer.getByText('Read only', { exact: true }).waitFor();
  await observer.waitForFunction(() => document.querySelectorAll('.xterm-rows > div').length === 19);
  agent.ws.close();
  await page.getByText('Agent offline', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1000, height: 700 });
  const resumed = await hub.socket('agent', token);
  register(resumed, { sessionId: registration.sessionId, resumeToken: registration.resumeToken, cols: 73, rows: 19 });
  await resumed.next('registered');
  const refit = await resumed.next('resize');
  assert.ok(refit.cols !== 73 || refit.rows !== 19, 'Reconnect must refit the current browser viewport.');
  resumed.send({ type: 'resized', cols: refit.cols, rows: refit.rows });
  await page.getByText('You have control', { exact: true }).waitFor();

  await page.setViewportSize({ width: 5200, height: 5200 });
  const maximum = await resumed.next('resize', (message) => message.cols === 500 && message.rows === 200);
  assert.equal(await page.locator('.xterm-rows > div').count(), refit.rows, 'Do not resize the display before the agent applies the request.');
  resumed.send({ type: 'resized', cols: maximum.cols, rows: maximum.rows });
  await page.waitForFunction(() => document.querySelectorAll('.xterm-rows > div').length === 200);
  await observer.waitForFunction(() => document.querySelectorAll('.xterm-rows > div').length === 200);
  resumed.send({ type: 'output', seq: 1, data: `\x1b[2J\x1b[H${'x'.repeat(500)}Y` });
  await page.waitForFunction(() => document.querySelectorAll('.xterm-rows > div')[1]?.textContent?.trimEnd() === 'Y');
  assert.equal(await page.locator('.xterm-rows > div').first().textContent(), 'x'.repeat(500));
  await page.setViewportSize({ width: 180, height: 480 });
  const minimum = await resumed.next('resize', (message) => message.cols === 20);
  assert.equal(minimum.rows, 5);
  resumed.send({ type: 'resized', cols: minimum.cols, rows: minimum.rows });
  await page.waitForFunction((rows) => document.querySelectorAll('.xterm-rows > div').length === rows, minimum.rows);
  resumed.send({ type: 'output', seq: 2, data: `\x1b[2J\x1b[H${'x'.repeat(20)}Y` });
  await page.waitForFunction(() => document.querySelectorAll('.xterm-rows > div')[1]?.textContent?.trimEnd() === 'Y');
  assert.equal(await page.locator('.xterm-rows > div').first().textContent(), 'x'.repeat(20));

  disconnect();
  await page.getByText('Reconnecting', { exact: true }).waitFor();
  await page.getByText('Status unknown', { exact: true }).waitFor();
  assert.match(await page.locator('.session-button small').innerText(), /status unknown/);
  assert.equal(await page.locator('.online-count .status-dot.online').count(), 0);
  allowConnection = true;
  await page.getByText('You have control', { exact: true }).waitFor();
  await page.getByText('1 online', { exact: true }).waitFor();
});

test('empty-state commands use the standalone agent and require insecure HTTP only for remote HTTP', { timeout: 30000 }, async (t) => {
  const hub = await fixture(t, { webDir: path.resolve('dist/web') });
  const browser = await chromium.launch({
    ...(process.env.HUB_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.HUB_TEST_BROWSER_EXECUTABLE }
      : { channel: process.env.HUB_TEST_BROWSER_CHANNEL ?? 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/me') {
      await route.fulfill({ json: { username: 'alice' } });
    } else {
      await route.fulfill({ response: await page.request.get(`${hub.origin}${url.pathname}${url.search}`) });
    }
  });
  await page.routeWebSocket('**/ws/browser', (route) => { route.close(); });
  for (const origin of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000', 'http://192.0.2.1:3080', 'https://hub.example.test']) {
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Your next terminal starts here.' }).waitFor();
    const insecure = origin === 'http://192.0.2.1:3080';
    assert.equal(await page.locator('.empty-state pre').innerText(),
      `agent-hub --server ${origin}${insecure ? ' --allow-insecure-http' : ''} --user alice -- your-agent-command`);
    assert.equal(await page.getByText(/HTTP sends passwords and terminal traffic without encryption/).count(), insecure ? 1 : 0);
    assert.match(await page.locator('.empty-state').innerText(), /on Windows use agent-hub\.cmd/);
  }
});
