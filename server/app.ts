import http, { type IncomingMessage } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { Auth, AuthBusyError, cookieToken, validUsername } from './auth.js';
import type { HubConfig } from './config.js';
import { Hub } from './hub.js';
import { isRecord } from '../shared/protocol.js';

export async function createHub(config: HubConfig) {
  const auth = new Auth(config.dataDir, config.sessionTtlMs);
  await auth.initialize();
  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);

  const allowOrigin = (request: IncomingMessage): boolean => {
    const origin = request.headers.origin;
    if (!origin) return false;
    if (config.publicUrl) return origin === config.publicUrl;
    if (config.devOrigin && origin === config.devOrigin) return true;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` || origin === `http://[::1]:${port}`;
  };
  const hub = new Hub(server, auth, config, allowOrigin);
  const secure = config.publicUrl?.startsWith('https:') ? '; Secure' : '';
  const sessionCookie = (token: string, maxAge: number) =>
    `hub_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;

  app.use((_request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    next();
  });
  app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '8kb', strict: true }));
  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));

  for (const role of ['browser', 'agent'] as const) {
    app.post(role === 'browser' ? '/api/login' : '/api/agent/login', async (request, response) => {
      if ((role === 'browser' || request.headers.origin) && !allowOrigin(request)) {
        response.status(403).json({ error: 'Untrusted origin.' }); return;
      }
      const ip = request.socket.remoteAddress ?? 'unknown';
      if (auth.limited(ip)) {
        response.set('Retry-After', '900').status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' }); return;
      }
      const body: unknown = request.body;
      if (!isRecord(body) || !validUsername(body.username) || typeof body.password !== 'string'
        || !await auth.verify(body.username, body.password)) {
        auth.failed(ip);
        response.status(401).json({ error: 'Invalid username or password.' }); return;
      }
      const { token, identity } = auth.issue(body.username, role);
      if (role === 'browser') {
        const old = cookieToken(request);
        if (old) { auth.revoke(old); hub.revoke(old); }
        response.set('Set-Cookie', sessionCookie(token, Math.floor(config.sessionTtlMs / 1000)));
        response.json({ username: identity.username, expiresAt: identity.expiresAt });
      } else response.json({ token, expiresAt: identity.expiresAt, username: identity.username });
    });
  }

  app.post('/api/logout', (request, response) => {
    if (!allowOrigin(request)) { response.status(403).json({ error: 'Untrusted origin.' }); return; }
    const token = cookieToken(request);
    if (token) { auth.revoke(token); hub.revoke(token); }
    response.set('Set-Cookie', sessionCookie('', 0)).json({ ok: true });
  });

  app.use('/api', (request, response, next) => {
    const identity = auth.get(cookieToken(request), 'browser');
    if (!identity) { response.status(401).json({ error: 'Sign in required.' }); return; }
    response.locals.username = identity.username;
    next();
  });
  app.get('/api/me', (_request, response) => response.json({ username: response.locals.username as string }));
  app.get('/api/sessions', (_request, response) => response.json({ sessions: hub.list(response.locals.username as string) }));
  app.use('/api', (_request, response) => response.status(404).json({ error: 'API endpoint not found.' }));

  if (existsSync(path.join(config.webDir, 'index.html'))) {
    app.use(express.static(config.webDir, { index: 'index.html' }));
    app.get('/', (_request, response) => response.sendFile(path.join(config.webDir, 'index.html')));
  } else {
    app.get('/', (_request, response) => response.status(503).type('text').send('Web UI not built. Run npm run build or use the Vite development server.'));
  }
  app.use((_request, response) => response.status(404).json({ error: 'Not found.' }));
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof AuthBusyError) {
      response.set('Retry-After', '1').status(503).json({ error: error.message });
      return;
    }
    if (isRecord(error) && (error.type === 'entity.too.large' || error instanceof SyntaxError)) {
      response.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid JSON request body.' });
      return;
    }
    console.error('Request failed:', error instanceof Error ? error.message : String(error));
    response.status(500).json({ error: 'Internal server error.' });
  };
  app.use(errorHandler);

  return {
    app, server, auth, hub,
    listen: () => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Could not determine server port.')); return; }
        resolve(address.port);
      });
    }),
    close: async () => {
      await hub.close();
      if (server.listening) {
        const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeIdleConnections();
        await closed;
      }
    },
  };
}
