import { parseArgs } from 'node:util';
import { saveUser } from './auth.js';
import { readConfig } from './config.js';
import { promptPassword } from '../agent/src/prompt.js';

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { reset: { type: 'boolean', default: false } },
  });
  const username = positionals[0];
  if (!username || positionals.length !== 1) throw new Error('Usage: npm run user:add -- <username> [--reset]');
  const password = process.env.AGENT_HUB_PASSWORD ?? await promptPassword('New password (12+ characters): ');
  if (!process.env.AGENT_HUB_PASSWORD && password !== await promptPassword('Confirm password: ')) {
    throw new Error('Passwords do not match.');
  }
  await saveUser(readConfig().dataDir, username, password, values.reset);
  console.log(`User "${username}" ${values.reset ? 'updated' : 'created'}. Restart the server after password resets to revoke existing sessions.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
