import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Auth, AuthBusyError, saveUser } from '../server/auth.js';
import { PASSWORD } from './helpers.js';

test('passwords use independent scrypt salts; updates require explicit reset', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveUser(dir, 'alice', PASSWORD);
  await saveUser(dir, 'bob', PASSWORD);
  const text = await readFile(path.join(dir, 'users.json'), 'utf8');
  assert.ok(!text.includes(PASSWORD));
  const file = JSON.parse(text) as { users: Record<string, { salt: string; hash: string }> };
  assert.notEqual(file.users.alice!.salt, file.users.bob!.salt);
  assert.notEqual(file.users.alice!.hash, file.users.bob!.hash);
  const auth = new Auth(dir, 10000);
  await auth.initialize();
  assert.equal(await auth.verify('alice', PASSWORD), true);
  assert.equal(await auth.verify('alice', 'wrong-password'), false);
  assert.equal(await auth.verify('missing', PASSWORD), false);
  assert.equal(await auth.verify('constructor', PASSWORD), false);
  await assert.rejects(saveUser(dir, 'alice', PASSWORD), /already exists/);
  await assert.rejects(saveUser(dir, 'unknown', PASSWORD, true), /does not exist/);
  await assert.rejects(saveUser(dir, 'bad user', PASSWORD), /Username/);
  await assert.rejects(saveUser(dir, 'short', 'short'), /Password/);
  await saveUser(dir, 'alice', 'replacement-password-for-test', true);
  assert.equal(await auth.verify('alice', PASSWORD), false);
  assert.equal(await auth.verify('alice', 'replacement-password-for-test'), true);
});

test('auth tokens are role scoped, revocable, and expire; malformed user data fails closed', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = new Auth(dir, 50);
  const browser = auth.issue('alice', 'browser');
  const agent = auth.issue('alice', 'agent');
  assert.notEqual(browser.token, agent.token);
  assert.equal(auth.get(browser.token, 'browser')?.username, 'alice');
  assert.equal(auth.get(browser.token, 'agent'), undefined);
  assert.equal(auth.get(agent.token, 'browser'), undefined);
  auth.revoke(browser.token);
  assert.equal(auth.get(browser.token), undefined);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(auth.get(agent.token), undefined);
  await writeFile(path.join(dir, 'users.json'), '{"version":1,"users":{"alice":{"hash":"plaintext"}}}');
  await assert.rejects(auth.initialize(), /Invalid password record/);
});

test('concurrent scrypt verification is bounded and capacity is released afterward', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-busy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveUser(dir, 'alice', PASSWORD);
  const auth = new Auth(dir, 10000);
  const pending = Array.from({ length: 4 }, () => auth.verify('alice', PASSWORD));
  await assert.rejects(auth.verify('alice', PASSWORD), AuthBusyError);
  assert.deepEqual(await Promise.all(pending), [true, true, true, true]);
  assert.equal(await auth.verify('alice', PASSWORD), true);
});
