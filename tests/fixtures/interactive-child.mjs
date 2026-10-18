import readline from 'node:readline';

console.log(`PTY_READY stdin=${process.stdin.isTTY === true} stdout=${process.stdout.isTTY === true}`);
console.log(`PASSWORD_IN_CHILD=${process.env.AGENT_HUB_PASSWORD === undefined ? 'absent' : 'LEAKED'}`);
console.log(`CWD=${process.cwd()}`);
console.log('\u001b[32mANSI_COLOR_OK\u001b[0m');
const size = () => console.log(`SIZE=${process.stdout.columns}x${process.stdout.rows}`);
size();
process.stdout.on('resize', size);
const reader = readline.createInterface({ input: process.stdin, output: process.stdout });
reader.setPrompt('agent> ');
reader.prompt();
reader.on('line', (line) => {
  if (line === 'exit' || line === 'exit7') {
    console.log('CHILD_GOODBYE');
    process.exit(line === 'exit7' ? 7 : 0);
  }
  if (line === 'size') size();
  else console.log(`REMOTE_REPLY:${line.split('').reverse().join('')}`);
  reader.prompt();
});
