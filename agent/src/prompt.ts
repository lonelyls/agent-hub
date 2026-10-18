import { StringDecoder } from 'node:string_decoder';

export async function promptPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('An interactive terminal is required. For automation, set AGENT_HUB_PASSWORD.');
  }
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  process.stderr.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const decoder = new StringDecoder('utf8');
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (data: Buffer) => {
      for (const character of decoder.write(data)) {
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u0003' || character === '\u0004') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}
