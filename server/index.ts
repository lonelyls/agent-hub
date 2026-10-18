import { createHub } from './app.js';
import { readConfig } from './config.js';

try {
  const config = readConfig();
  if (process.argv.includes('--dev')) config.devOrigin = 'http://127.0.0.1:5173';
  const hub = await createHub(config);
  const port = await hub.listen();
  console.log(`Agent Hub listening at ${config.publicUrl ?? `http://${config.host}:${port}`}`);
  if (config.publicUrl?.startsWith('http:') && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    console.warn('WARNING: Plain HTTP exposes passwords and terminal traffic. Use HTTPS via a reverse proxy outside a trusted local network.');
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('Stopping Agent Hub...');
    const timeout = setTimeout(() => process.exit(1), 5000);
    timeout.unref();
    void hub.close().then(() => { clearTimeout(timeout); }).catch((error: unknown) => {
      console.error('Shutdown failed:', error);
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
