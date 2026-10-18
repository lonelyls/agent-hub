import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isAgentServerMessage, validSize } from '../dist/protocol.js';
import { renewalDelay } from '../dist/token.js';

test('agent accepts supported hub messages and rejects malformed responses', () => {
  assert.ok(isAgentServerMessage({ type: 'registered', sessionId: 'terminal', resumeToken: 'secret', lastSeq: 0 }));
  assert.ok(isAgentServerMessage({ type: 'ack', seq: 1 }));
  assert.ok(isAgentServerMessage({ type: 'authenticated', expiresAt: 1000 }));
  assert.equal(isAgentServerMessage({ type: 'authenticated', expiresAt: -1 }), false);
  assert.ok(isAgentServerMessage({ type: 'input', data: '\u0003' }));
  assert.ok(isAgentServerMessage({ type: 'resize', cols: 80, rows: 24 }));
  assert.ok(isAgentServerMessage({ type: 'error', code: 'offline', message: 'Offline.' }));
  for (const value of [null, [], {}, { type: 'ack', seq: -1 }, { type: 'input', data: 1 }, { type: 'resize', cols: 501, rows: 24 }]) {
    assert.equal(isAgentServerMessage(value), false);
  }
  assert.equal(validSize(20, 5), true);
  assert.equal(validSize(500, 200), true);
  assert.equal(validSize(19, 24), false);
});

test('renewal starts one minute before normal expiry and at 80 percent of short token lifetimes', () => {
  assert.equal(renewalDelay(12 * 60 * 60 * 1000, 0), 12 * 60 * 60 * 1000 - 60000);
  assert.equal(renewalDelay(5000, 0), 4000);
  assert.equal(renewalDelay(100, 100), 0);
  assert.equal(renewalDelay(50, 100), 0);
});

test('standalone executable exposes its installed command and options without credentials', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url)), '--help']);
  assert.match(stdout, /agent-hub --user/);
  assert.match(stdout, /--server/);
  assert.match(stdout, /--no-local-input/);
});
