import path from 'node:path';

export interface HubConfig {
  host: string;
  port: number;
  dataDir: string;
  publicUrl?: string;
  webDir: string;
  sessionTtlMs: number;
  terminalTtlMs: number;
  devOrigin?: string;
}

export function readConfig(): HubConfig {
  const port = Number(process.env.HUB_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('HUB_PORT must be an integer between 1 and 65535.');
  }
  const publicUrl = process.env.HUB_PUBLIC_URL;
  const host = process.env.HUB_HOST ?? '127.0.0.1';
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== publicUrl) {
      throw new Error('HUB_PUBLIC_URL must be an HTTP(S) origin without a trailing slash.');
    }
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !publicUrl) {
    throw new Error('Set HUB_PUBLIC_URL when listening on a non-loopback interface.');
  }
  return {
    host,
    port,
    dataDir: path.resolve(process.env.HUB_DATA_DIR ?? 'data'),
    publicUrl,
    webDir: path.resolve('dist/web'),
    sessionTtlMs: 12 * 60 * 60 * 1000,
    terminalTtlMs: 30 * 60 * 1000,
  };
}
