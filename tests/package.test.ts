import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fixture, PASSWORD } from './helpers.js';
import { isRecord } from '../shared/protocol.js';

const execFile = promisify(execFileCallback);

test('standalone sources build and the globally installed tarball runs a real authenticated PTY outside the hub tree', { timeout: 240000 }, async (t) => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run this test through npm run test:package so the npm CLI path is available.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent hub package-'));
  const source = path.join(directory, 'source');
  const prefix = path.join(directory, 'installation');
  const hub = await fixture(t);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    NODE_PATH: '',
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const npm = (args: string[], cwd = source) => execFile(process.execPath, [npmCli, ...args], {
    cwd, env, timeout: 120000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });

  await cp(path.resolve('agent'), source, {
    recursive: true,
    filter: (entry) => !['node_modules', 'dist'].includes(path.basename(entry)) && !entry.endsWith('.tgz'),
  });
  await npm(['ci', '--no-audit', '--no-fund']);
  await npm(['run', 'typecheck']);
  await npm(['pack', '--pack-destination', directory, '--loglevel=error']);
  const archive = path.join(directory, 'agent-hub-agent-1.0.0.tgz');
  await npm([
    'install', '--global', '--prefix', prefix, '--omit=dev', '--allow-scripts=node-pty',
    '--no-audit', '--no-fund', archive,
  ], directory);
  const { stdout: root } = await npm(['root', '--global', '--prefix', prefix], directory);
  const installed = path.join(root.trim(), 'agent-hub-agent');
  const manifest: unknown = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.ok(isRecord(manifest) && isRecord(manifest.dependencies));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['node-pty', 'ws']);
  assert.deepEqual((await readdir(installed)).sort(), ['README.md', 'dist', 'node_modules', 'package.json']);
  assert.deepEqual((await readdir(path.join(installed, 'dist'))).sort(), ['index.js', 'prompt.js', 'protocol.js', 'token.js']);
  const runtimeModules = await readdir(path.join(installed, 'node_modules'));
  for (const unwanted of ['typescript', 'react', 'express', 'vite', 'playwright']) {
    assert.ok(!runtimeModules.includes(unwanted), `Portable install must not include ${unwanted}.`);
  }

  const bin = process.platform === 'win32' ? path.join(prefix, 'agent-hub.cmd') : path.join(prefix, 'bin', 'agent-hub');
  const help = process.platform === 'win32'
    ? await execFile(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${bin}" --help"`], {
      cwd: directory, env, windowsVerbatimArguments: true,
    })
    : await execFile(bin, ['--help'], { cwd: directory, env });
  assert.match(help.stdout, /agent-hub --user/);

  const { cookie } = await hub.login('browser');
  const viewer = await hub.socket('browser', cookie);
  await viewer.next('sessions');
  const script = `
    const readline = require('node:readline');
    console.log('ISOLATED_PTY=' + (process.stdin.isTTY === true && process.stdout.isTTY === true));
    console.log('PASSWORD_IN_CHILD=' + (process.env.AGENT_HUB_PASSWORD === undefined ? 'absent' : 'LEAKED'));
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    input.on('line', (line) => {
      if (line === 'exit') { console.log('PACKAGED_GOODBYE'); process.exit(7); }
      if (line === 'size') console.log('PACKAGED_SIZE=' + process.stdout.columns + 'x' + process.stdout.rows);
      else console.log('PACKAGED_REPLY:' + line.toUpperCase());
    });
  `;
  const child = spawn(process.execPath, [
    path.join(installed, 'dist', 'index.js'), '--server', hub.origin, '--user', 'alice',
    '--name', 'Portable package', '--no-local-input', '--', process.execPath, '-e', script,
  ], {
    cwd: directory, env: { ...env, AGENT_HUB_PASSWORD: PASSWORD },
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
  const sessions = await viewer.next('sessions', (message) => Array.isArray(message.sessions) && message.sessions.length === 1, 20000);
  assert.ok(Array.isArray(sessions.sessions) && isRecord(sessions.sessions[0]));
  viewer.send({ type: 'watch', sessionId: sessions.sessions[0].id });
  const snapshot = await viewer.next('snapshot');
  let history = typeof snapshot.history === 'string' ? snapshot.history : '';
  const untilOutput = async (text: string) => {
    while (!history.includes(text)) history += String((await viewer.next('output')).data);
  };
  await untilOutput('ISOLATED_PTY=true');
  await untilOutput('PASSWORD_IN_CHILD=absent');
  viewer.send({ type: 'input', data: 'portable-input\r' });
  await untilOutput('PACKAGED_REPLY:PORTABLE-INPUT');
  viewer.send({ type: 'resize', cols: 90, rows: 28 });
  await viewer.next('state', (message) => isRecord(message.session) && message.session.cols === 90 && message.session.rows === 28);
  viewer.send({ type: 'input', data: 'size\r' });
  await untilOutput('PACKAGED_SIZE=90x28');
  viewer.send({ type: 'input', data: 'exit\r' });
  await untilOutput('PACKAGED_GOODBYE');
  await viewer.next('state', (message) => isRecord(message.session) && message.session.status === 'exited' && message.session.exitCode === 7);
  if (child.exitCode === null) await once(child, 'exit');
  assert.equal(child.exitCode, 7, `${stdout}\n${stderr}`);
  assert.ok(!stdout.includes('LEAKED'));
});
