import * as pty from 'node-pty';

const env = { ...process.env };
delete env.AGENT_HUB_PASSWORD;
const terminal = pty.spawn(process.execPath, process.argv.slice(2), {
  name: 'xterm-256color', cols: 120, rows: 35, cwd: process.cwd(), env,
});
terminal.onData((data) => process.stdout.write(data));
process.stdin.on('data', (data) => terminal.write(data));
terminal.onExit(({ exitCode, signal }) => {
  process.stdin.pause();
  process.stdout.write('', () => process.exit(signal ? 128 + signal : exitCode));
});
process.on('SIGTERM', () => {
  terminal.kill();
  setTimeout(() => process.exit(130), 1500);
});
