const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Cheap shape check only: the server stays the source of truth. */
export function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= 254 && EMAIL_PATTERN.test(trimmed);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
