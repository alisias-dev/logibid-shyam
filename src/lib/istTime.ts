// All auction times in FleexBid are entered and displayed in Indian Standard
// Time (IST, UTC+05:30). The database stores TIMESTAMPTZ (UTC), so every
// naive "YYYY-MM-DDTHH:mm" datetime-local string must be converted to the
// matching UTC instant BEFORE it is sent to the server — otherwise it gets
// stored literally as UTC and the countdown/closing time drifts by 5h30m.

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Parse a user-supplied closing time into a real UTC instant.
 * - Naive datetime-local strings ("2026-09-25T16:35") are interpreted as IST.
 * - Values that already carry an offset ("...T16:35+05:30" / "...Z") are
 *   passed through untouched.
 */
export function parseAsIst(input: string): Date {
  const s = (input || '').trim();
  if (!s) return new Date(NaN);
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    return new Date(s);
  }
  // Naive datetime-local value ("YYYY-MM-DDTHH:mm[:ss]") -> attach IST offset.
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? `${s}:00` : s;
  return new Date(`${withSeconds}+05:30`);
}

/**
 * ISO instant -> IST wall-clock string for <input type="datetime-local">.
 * ("2026-09-25T11:05:00.000Z" -> "2026-09-25T16:35")
 */
export function formatIstForInput(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/** ISO instant -> human-readable IST display string. */
export function formatIstLabel(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return '—';
  return new Date(d.getTime() + IST_OFFSET_MS)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16) + ' IST';
}
