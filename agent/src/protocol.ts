export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_INPUT_BYTES = 16 * 1024;
export const HISTORY_BYTES = 1024 * 1024;
export const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export type TerminalStatus = 'online' | 'disconnected' | 'exited';

export interface TerminalInfo {
  id: string;
  name: string;
  hostname: string;
  command: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  createdAt: string;
  exitCode?: number;
}

export type AgentMessage =
  | {
      type: 'register';
      name: string;
      hostname: string;
      command: string;
      cols: number;
      rows: number;
      sessionId?: string;
      resumeToken?: string;
    }
  | { type: 'output'; seq: number; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'resized'; cols: number; rows: number }
  | { type: 'reauthenticate'; token: string };

export type AgentServerMessage =
  | { type: 'registered'; sessionId: string; resumeToken: string; lastSeq: number }
  | { type: 'authenticated'; expiresAt: number }
  | { type: 'ack'; seq: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'error'; code: string; message: string };

export type ViewerMessage =
  | { type: 'watch'; sessionId: string }
  | { type: 'unwatch' }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'control' };

export type ViewerServerMessage =
  | { type: 'sessions'; sessions: TerminalInfo[] }
  | { type: 'snapshot'; session: TerminalInfo; history: string; controlling: boolean }
  | { type: 'output'; sessionId: string; data: string }
  | { type: 'state'; session: TerminalInfo; controlling: boolean }
  | { type: 'error'; code: string; message: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validSize(cols: unknown, rows: unknown): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows)
    && typeof cols === 'number' && cols >= 20 && cols <= 500
    && typeof rows === 'number' && rows >= 5 && rows <= 200;
}

function isTerminalInfo(value: unknown): value is TerminalInfo {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.name === 'string'
    && typeof value.hostname === 'string' && typeof value.command === 'string'
    && typeof value.createdAt === 'string' && validSize(value.cols, value.rows)
    && typeof value.status === 'string' && ['online', 'disconnected', 'exited'].includes(value.status)
    && (value.exitCode === undefined || Number.isInteger(value.exitCode));
}

export function isAgentServerMessage(value: unknown): value is AgentServerMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'authenticated': return typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0;
    case 'registered':
      return typeof value.sessionId === 'string' && typeof value.resumeToken === 'string'
        && Number.isSafeInteger(value.lastSeq) && typeof value.lastSeq === 'number' && value.lastSeq >= 0;
    case 'ack': return Number.isSafeInteger(value.seq) && typeof value.seq === 'number' && value.seq >= 0;
    case 'input': return typeof value.data === 'string';
    case 'resize': return validSize(value.cols, value.rows);
    case 'error': return typeof value.code === 'string' && typeof value.message === 'string';
    default: return false;
  }
}

export function isViewerServerMessage(value: unknown): value is ViewerServerMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'sessions': return Array.isArray(value.sessions) && value.sessions.every(isTerminalInfo);
    case 'snapshot': return isTerminalInfo(value.session) && typeof value.history === 'string' && typeof value.controlling === 'boolean';
    case 'output': return typeof value.sessionId === 'string' && typeof value.data === 'string';
    case 'state': return isTerminalInfo(value.session) && typeof value.controlling === 'boolean';
    case 'error': return typeof value.code === 'string' && typeof value.message === 'string';
    default: return false;
  }
}
