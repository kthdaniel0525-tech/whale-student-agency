/** IANA zone IDs plus UTC; numeric offsets are not portable timezone preferences. */
export function isValidTimezone(value: string): boolean {
  if (!/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; }
  catch { return false; }
}
