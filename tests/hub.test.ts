import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture, PASSWORD, register, rejectedSocket } from './helpers.js';
import { HISTORY_BYTES, isRecord } from '../shared/protocol.js';

test('removing inactive terminals enforces authentication, origin, ownership, and online protection', async (t) => {
  const hub = await fixture(t);
  const { token } = await hub.login('agent');
  const { cookie } = await hub.login('browser');
  const bob = await hub.login('browser', 'bob');
  const agent = await hub.socket('agent', token);
  register(agent);
  const registered = await agent.next('registered');
  const route = `/api/sessions/${String(registered.sessionId)}/remove`;
  assert.equal((await hub.request(route, {})).status, 401);
  assert.equal((await hub.request(route, {}, bob.cookie)).status, 404);
  assert.equal((await hub.request(route, {}, cookie)).status, 409);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${hub.origin}${route}`, { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal((await fetch(`${hub.origin}${route}`, {
    method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body: '{}',
  })).status, 403);

  const viewer = await hub.socket('browser', cookie);
  const observer = await hub.socket('browser', cookie);
  for (const browser of [viewer, observer]) {
    await browser.next('sessions');
    browser.send({ type: 'watch', sessionId: registered.sessionId });
    await browser.next('snapshot');
  }
  agent.send({ type: 'output', seq: 1, data: 'retained history' });
  await agent.next('ack');
  agent.ws.close();
  await viewer.next('state', (message) => isRecord(message.session) && message.session.status === 'disconnected');
  assert.equal((await hub.request(route, {}, bob.cookie)).status, 404);
  assert.deepEqual(await (await hub.request(route, {}, cookie)).json(), { ok: true });
  for (const browser of [viewer, observer]) {
    await browser.next('sessions', (message) => Array.isArray(message.sessions) && message.sessions.length === 0);
    browser.send({ type: 'input', data: 'not delivered' });
    assert.equal((await browser.next('error')).code, 'not_watching');
    browser.send({ type: 'watch', sessionId: registered.sessionId });
    assert.equal((await browser.next('error')).code, 'not_found');
  }
  assert.deepEqual(hub.hub.list('alice'), []);
  assert.equal((await hub.request(route, {}, cookie)).status, 404);

  const resumed = await hub.socket('agent', token);
  register(resumed, { sessionId: registered.sessionId, resumeToken: registered.resumeToken });
  assert.equal((await resumed.next('error')).code, 'session_missing');
  register(resumed);
  const replacement = await resumed.next('registered');
  assert.notEqual(replacement.sessionId, registered.sessionId);
  viewer.send({ type: 'watch', sessionId: replacement.sessionId });
  assert.equal((await viewer.next('snapshot')).history, '');
  viewer.send({ type: 'input', data: 'still works\r' });
  assert.equal((await resumed.next('input')).data, 'still works\r');
  resumed.send({ type: 'exit', exitCode: 0 });
  await viewer.next('state', (message) => isRecord(message.session) && message.session.status === 'exited');
  assert.equal((await hub.request(`/api/sessions/${String(replacement.sessionId)}/remove`, {}, cookie)).status, 200);
  assert.deepEqual(hub.hub.list('alice'), []);
});

test('login, cookies, logout, origin checks, and role separation protect terminal access', async (t) => {
  const hub = await fixture(t);
  assert.equal((await hub.request('/api/sessions')).status, 401);
  assert.equal((await hub.request('/api/login', { username: 'alice', password: 'wrong' })).status, 401);
  assert.equal((await fetch(`${hub.origin}/api/login`, {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: PASSWORD }),
  })).status, 403);
  const browser = await hub.login('browser');
  const agent = await hub.login('agent');
  assert.equal(browser.body.token, undefined);
  assert.ok(browser.cookie);
  assert.equal((await hub.request('/api/me', undefined, browser.cookie)).status, 200);
  const wsOrigin = hub.origin.replace('http:', 'ws:');
  assert.equal(await rejectedSocket(`${wsOrigin}/ws/browser`), 401);
  assert.equal(await rejectedSocket(`${wsOrigin}/ws/browser`, { Cookie: browser.cookie, Origin: 'https://attacker.example' }), 401);
  assert.equal(await rejectedSocket(`${wsOrigin}/ws/agent`, { Authorization: `Bearer ${browser.cookie.split('=')[1]}` }), 401);
  assert.equal(await rejectedSocket(`${wsOrigin}/ws/browser`, { Cookie: `hub_session=${agent.token}`, Origin: hub.origin }), 401);
  const viewer = await hub.socket('browser', browser.cookie);
  await viewer.next('sessions');
  const closed = once(viewer.ws, 'close');
  assert.equal((await hub.request('/api/logout', {}, browser.cookie)).status, 200);
  const [code] = await closed;
  assert.equal(code, 4401);
  assert.equal((await hub.request('/api/me', undefined, browser.cookie)).status, 401);
});

test('PTY protocol supports history, deduplication, exclusive control, input, resize, and exit', async (t) => {
  const hub = await fixture(t);
  const { token } = await hub.login('agent');
  const { cookie } = await hub.login('browser');
  const agent = await hub.socket('agent', token);
  register(agent);
  const registration = await agent.next('registered');
  const id = registration.sessionId;
  assert.equal(typeof id, 'string');
  agent.send({ type: 'output', seq: 1, data: '\u001b[32mready\u001b[0m\r\n' });
  await agent.next('ack');
  agent.send({ type: 'output', seq: 1, data: 'duplicate that must be discarded' });
  await agent.next('ack');
  const browser = await hub.socket('browser', cookie);
  await browser.next('sessions');
  browser.send({ type: 'watch', sessionId: id });
  const snapshot = await browser.next('snapshot');
  assert.equal(snapshot.history, '\u001b[32mready\u001b[0m\r\n');
  assert.equal(snapshot.controlling, true);
  browser.send({ type: 'input', data: 'hello\r' });
  assert.equal((await agent.next('input')).data, 'hello\r');
  browser.send({ type: 'resize', cols: 120, rows: 40 });
  const size = await agent.next('resize');
  assert.equal(size.cols, 120);
  assert.equal(size.rows, 40);
  agent.send({ type: 'resized', cols: 120, rows: 40 });
  const state = await browser.next('state', (message) => isRecord(message.session) && message.session.cols === 120);
  assert.ok(isRecord(state.session));
  assert.equal(state.session.rows, 40);
  const observer = await hub.socket('browser', cookie);
  observer.send({ type: 'watch', sessionId: id });
  assert.equal((await observer.next('snapshot')).controlling, false);
  observer.send({ type: 'input', data: 'not allowed' });
  assert.equal((await observer.next('error')).code, 'read_only');
  observer.send({ type: 'control' });
  await observer.next('state', (message) => message.controlling === true);
  await browser.next('state', (message) => message.controlling === false);
  observer.send({ type: 'input', data: '\u0003' });
  assert.equal((await agent.next('input')).data, '\u0003');
  agent.send({ type: 'output', seq: 2, data: 'live output\r\n' });
  assert.equal((await browser.next('output')).data, 'live output\r\n');
  assert.equal((await observer.next('output')).data, 'live output\r\n');
  await agent.next('ack');
  agent.send({ type: 'exit', exitCode: 7 });
  const exit = await browser.next('state', (message) => isRecord(message.session) && message.session.status === 'exited');
  assert.ok(isRecord(exit.session));
  assert.equal(exit.session.exitCode, 7);
  observer.send({ type: 'input', data: 'after exit' });
  assert.equal((await observer.next('error')).code, 'offline');
});

test('different users cannot discover, watch, or resume each other terminals', async (t) => {
  const hub = await fixture(t);
  const alice = await hub.login('agent');
  const agent = await hub.socket('agent', alice.token);
  register(agent);
  const session = await agent.next('registered');
  const bobBrowser = await hub.login('browser', 'bob');
  const bobAgent = await hub.login('agent', 'bob');
  const viewer = await hub.socket('browser', bobBrowser.cookie);
  assert.deepEqual((await viewer.next('sessions')).sessions, []);
  viewer.send({ type: 'watch', sessionId: session.sessionId });
  assert.equal((await viewer.next('error')).code, 'not_found');
  const list = await hub.request('/api/sessions', undefined, bobBrowser.cookie);
  assert.deepEqual(await list.json(), { sessions: [] });
  const attacker = await hub.socket('agent', bobAgent.token);
  register(attacker, { sessionId: session.sessionId, resumeToken: session.resumeToken });
  assert.equal((await attacker.next('error')).code, 'resume_denied');
});

test('agents reconnect to the same session and replay unacknowledged output without duplication', async (t) => {
  const hub = await fixture(t);
  const { token } = await hub.login('agent');
  const { cookie } = await hub.login('browser');
  const agent = await hub.socket('agent', token);
  register(agent);
  const registration = await agent.next('registered');
  agent.send({ type: 'output', seq: 1, data: 'before disconnect\r\n' });
  await agent.next('ack');
  const viewer = await hub.socket('browser', cookie);
  viewer.send({ type: 'watch', sessionId: registration.sessionId });
  await viewer.next('snapshot');
  agent.ws.close();
  await viewer.next('state', (message) => isRecord(message.session) && message.session.status === 'disconnected');
  const resumed = await hub.socket('agent', token);
  register(resumed, { sessionId: registration.sessionId, resumeToken: registration.resumeToken });
  const ack = await resumed.next('registered');
  assert.equal(ack.sessionId, registration.sessionId);
  assert.equal(ack.lastSeq, 1);
  await viewer.next('state', (message) => isRecord(message.session) && message.session.status === 'online');
  resumed.send({ type: 'output', seq: 1, data: 'before disconnect\r\n' });
  await resumed.next('ack');
  resumed.send({ type: 'output', seq: 2, data: 'after reconnect\r\n' });
  assert.equal((await viewer.next('output')).data, 'after reconnect\r\n');
  viewer.send({ type: 'watch', sessionId: registration.sessionId });
  assert.equal((await viewer.next('snapshot')).history, 'before disconnect\r\nafter reconnect\r\n');
});

test('history is bounded and malformed or oversized protocol input is rejected', async (t) => {
  const hub = await fixture(t);
  const { token } = await hub.login('agent');
  const { cookie } = await hub.login('browser');
  const agent = await hub.socket('agent', token);
  register(agent);
  const registration = await agent.next('registered');
  for (let seq = 1; seq <= 20; seq++) {
    agent.send({ type: 'output', seq, data: `${seq}:` + 'x'.repeat(60 * 1024) });
    await agent.next('ack');
  }
  const viewer = await hub.socket('browser', cookie);
  viewer.send({ type: 'watch', sessionId: registration.sessionId });
  const snapshot = await viewer.next('snapshot');
  assert.equal(typeof snapshot.history, 'string');
  assert.ok(Buffer.byteLength(snapshot.history as string) <= HISTORY_BYTES);
  assert.ok((snapshot.history as string).includes('20:'));
  assert.ok(!(snapshot.history as string).startsWith('1:'));
  viewer.send({ type: 'resize', cols: 9999, rows: 24 });
  assert.equal((await viewer.next('error')).code, 'invalid_message');
  const brokenAgent = await hub.socket('agent', token);
  brokenAgent.ws.send('{not json');
  assert.equal((await brokenAgent.next('error')).code, 'invalid_message');
});

test('failed login attempts are throttled and expired tokens cannot reopen terminals', async (t) => {
  const hub = await fixture(t, { sessionTtlMs: 50 });
  const { token } = await hub.login('agent');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(await rejectedSocket(`${hub.origin.replace('http:', 'ws:')}/ws/agent`, { Authorization: `Bearer ${token}` }), 401);
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await hub.request('/api/agent/login', { username: 'alice', password: 'wrong' })).status, 401);
  }
  assert.equal((await hub.request('/api/agent/login', { username: 'alice', password: PASSWORD })).status, 429);
});

test('agent token replacement keeps the same socket and terminal while revoking the old token', async (t) => {
  const hub = await fixture(t);
  const original = await hub.login('agent');
  const agent = await hub.socket('agent', original.token);
  register(agent);
  const session = await agent.next('registered');
  const renewed = await hub.login('agent');
  agent.send({ type: 'reauthenticate', token: renewed.token });
  const authenticated = await agent.next('authenticated');
  assert.equal(authenticated.expiresAt, renewed.body.expiresAt);
  assert.equal(hub.auth.get(original.token), undefined);
  assert.ok(hub.auth.get(renewed.token, 'agent'));
  agent.send({ type: 'output', seq: 1, data: 'after renewal' });
  await agent.next('ack');
  assert.equal(hub.hub.list('alice')[0]?.id, session.sessionId);
  assert.equal(hub.hub.list('alice')[0]?.status, 'online');
  const expired = hub.auth.get(renewed.token);
  assert.ok(expired);
  expired.expiresAt = Date.now() - 1;
  const closed = once(agent.ws, 'close');
  agent.send({ type: 'output', seq: 2, data: 'expired input' });
  assert.equal((await closed)[0], 4401);
});

test('agent renewal refuses browser, other-user, expired, and invalid credentials', async (t) => {
  const hub = await fixture(t);
  const browser = await hub.login('browser');
  const bob = await hub.login('agent', 'bob');
  const expired = hub.auth.issue('alice', 'agent');
  expired.identity.expiresAt = Date.now() - 1;
  for (const replacement of [browser.cookie.slice('hub_session='.length), bob.token, expired.token, 'invalid']) {
    const original = await hub.login('agent');
    const agent = await hub.socket('agent', original.token);
    register(agent);
    await agent.next('registered');
    agent.send({ type: 'reauthenticate', token: replacement });
    assert.equal((await agent.next('error')).code, 'authentication_failed');
    assert.ok(hub.auth.get(original.token), 'A failed renewal must not revoke unrelated credentials.');
  }
});
