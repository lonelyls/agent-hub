import { isRecord } from '../../shared/protocol';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    throw new ApiError(isRecord(data) && typeof data.error === 'string' ? data.error : 'Request failed.', response.status);
  }
  return data as T;
}
