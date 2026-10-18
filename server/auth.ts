import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { isRecord } from '../shared/protocol.js';

interface PasswordRecord {
  salt: string;
  hash: string;
}

interface UserFile {
  version: 1;
  users: Record<string, PasswordRecord>;
}

export interface Identity {
  username: string;
  role: 'browser' | 'agent';
  expiresAt: number;
}

export class AuthBusyError extends Error {
  constructor() { super('Authentication is busy. Try again shortly.'); }
}

const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function validUsername(value: unknown): value is string {
  return typeof value === 'string' && USERNAME.test(value);
}

export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value) <= 1024;
}

async function loadUsers(dataDir: string): Promise<UserFile> {
  let text: string;
  try {
    text = await readFile(path.join(dataDir, 'users.json'), 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { version: 1, users: {} };
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.users)) {
    throw new Error('Invalid users.json format. Restore the user database before starting the hub.');
  }
  const users: Record<string, PasswordRecord> = Object.create(null) as Record<string, PasswordRecord>;
  for (const [username, record] of Object.entries(value.users)) {
    if (!validUsername(username) || !isRecord(record)
      || typeof record.salt !== 'string' || !/^[a-f0-9]{32}$/.test(record.salt)
      || typeof record.hash !== 'string' || !/^[a-f0-9]{128}$/.test(record.hash)) {
      throw new Error('Invalid password record in users.json.');
    }
    users[username] = { salt: record.salt, hash: record.hash };
  }
  return { version: 1, users };
}

export async function saveUser(dataDir: string, username: string, password: string, reset = false): Promise<void> {
  if (!validUsername(username)) throw new Error('Username must be 3-64 letters, numbers, dots, underscores or hyphens, starting with a letter or number.');
  if (!validPassword(password)) throw new Error('Password must be at least 12 characters and at most 1024 UTF-8 bytes.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(dataDir, 'users.lock');
  try {
    await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') {
      throw new Error('Another user-management operation is running (users.lock exists).');
    }
    throw error;
  }
  const temp = path.join(dataDir, `users-${randomBytes(8).toString('hex')}.tmp`);
  try {
    const file = await loadUsers(dataDir);
    const exists = Object.hasOwn(file.users, username);
    if (exists && !reset) throw new Error('User already exists. Use --reset to replace their password.');
    if (!exists && reset) throw new Error('Cannot reset a user that does not exist.');
    const salt = randomBytes(16).toString('hex');
    file.users[username] = { salt, hash: (await scrypt(password, salt)).toString('hex') };
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path.join(dataDir, 'users.json'));
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    });
    await unlink(lock);
  }
}

export class Auth {
  private readonly sessions = new Map<string, Identity>();
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private readonly dummySalt = randomBytes(16).toString('hex');
  private activeVerifications = 0;

  constructor(private readonly dataDir: string, private readonly ttlMs: number) {}

  async initialize(): Promise<void> {
    await loadUsers(this.dataDir);
  }

  async verify(username: unknown, password: unknown): Promise<boolean> {
    if (typeof username !== 'string' || typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false;
    if (this.activeVerifications >= 4) throw new AuthBusyError();
    this.activeVerifications++;
    try {
      const file = await loadUsers(this.dataDir);
      const user = Object.hasOwn(file.users, username) ? file.users[username] : undefined;
      const actual = await scrypt(password, user?.salt ?? this.dummySalt);
      const expected = user ? Buffer.from(user.hash, 'hex') : Buffer.alloc(64);
      return timingSafeEqual(actual, expected) && user !== undefined;
    } finally { this.activeVerifications--; }
  }

  limited(ip: string): boolean {
    const entry = this.failures.get(ip);
    return !!entry && entry.resetAt > Date.now() && entry.count >= 10;
  }

  failed(ip: string): void {
    this.prune();
    const previous = this.failures.get(ip);
    if (previous && previous.resetAt > Date.now()) previous.count++;
    else {
      if (this.failures.size >= 10000) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(ip, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
    }
  }

  issue(username: string, role: Identity['role']): { token: string; identity: Identity } {
    this.prune();
    if (this.sessions.size >= 10000) throw new Error('Authentication session capacity reached.');
    const token = randomBytes(32).toString('base64url');
    const identity: Identity = { username, role, expiresAt: Date.now() + this.ttlMs };
    this.sessions.set(this.digest(token), identity);
    return { token, identity };
  }

  get(token: string | undefined, role?: Identity['role']): Identity | undefined {
    if (!token) return;
    const key = this.digest(token);
    const identity = this.sessions.get(key);
    if (identity && identity.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return;
    }
    return identity && (!role || identity.role === role) ? identity : undefined;
  }

  revoke(token: string): void {
    this.sessions.delete(this.digest(token));
  }

  prune(): void {
    const now = Date.now();
    for (const [key, identity] of this.sessions) if (identity.expiresAt <= now) this.sessions.delete(key);
    for (const [key, entry] of this.failures) if (entry.resetAt <= now) this.failures.delete(key);
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

export function cookieToken(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('hub_session='));
  return cookie?.slice('hub_session='.length);
}

export function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}
