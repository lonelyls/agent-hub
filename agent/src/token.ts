export function renewalDelay(expiresAt: number, now = Date.now()): number {
  const remaining = Math.max(0, expiresAt - now);
  return Math.max(0, Math.floor(remaining - Math.min(60000, remaining * 0.2)));
}
