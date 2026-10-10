export const EXPIRATION_LOCK_SECONDS = 60;
export const EXPIRATION_RETRY_INITIAL_SECONDS = 30;
export const EXPIRATION_RETRY_MAX_SECONDS = 3_600;

export function expirationRetryDelaySeconds(attempt: number): number {
  const normalized = Math.max(1, Math.floor(attempt));
  return Math.min(EXPIRATION_RETRY_MAX_SECONDS, EXPIRATION_RETRY_INITIAL_SECONDS * 2 ** (normalized - 1));
}

export function expirationRetryAt(attempt: number, now = Date.now()): Date {
  return new Date(now + expirationRetryDelaySeconds(attempt) * 1_000);
}
