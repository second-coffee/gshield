export function weekBounds(now = new Date()) {
  const d = new Date(now);
  const day = d.getUTCDay();
  const diffToMon = (day + 6) % 7;
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon, 0, 0, 0));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6, 23, 59, 59));
  return { start, end };
}

export function clampEmailDays(requested: string | null, maxRecentDays: number) {
  const req = Number.isFinite(Number(requested)) ? Number(requested) : maxRecentDays;
  return Math.max(1, Math.min(req, maxRecentDays));
}

export function clampCalendarRange(input: {
  start?: string | null;
  end?: string | null;
  now?: Date;
  maxPastDays: number;
  maxFutureDays: number;
  defaultThisWeek: boolean;
}) {
  const now = input.now || new Date();
  const min = new Date(now);
  min.setUTCDate(min.getUTCDate() - input.maxPastDays);
  min.setUTCHours(0, 0, 0, 0);
  const max = new Date(now);
  max.setUTCDate(max.getUTCDate() + input.maxFutureDays);
  max.setUTCHours(23, 59, 59, 999);

  let start = input.start ? new Date(input.start) : null;
  let end = input.end ? new Date(input.end) : null;

  if (!start || !end) {
    if (input.defaultThisWeek) {
      const w = weekBounds(now);
      start = w.start;
      end = w.end;
    } else {
      start = min;
      end = max;
    }
  }

  if (start < min) start = min;
  if (end > max) end = max;
  if (end < start) end = start;

  return { start, end, min, max };
}

function normalizeAddress(input: string): string | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized.includes(' ')) return null;
  const parts = normalized.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!/^[a-z0-9._%+-]+$/.test(parts[0])) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(parts[1])) return null;
  return normalized;
}

export function allowedRecipient(
  to: string,
  allowEmails: string[],
  allowDomains: string[],
  allowAll = false
): boolean {
  const normalized = normalizeAddress(to);
  if (!normalized) return false;
  if (allowAll) return true;
  const domain = normalized.split('@')[1];

  // Security default: fail closed when no allowlist configured.
  if (allowEmails.length === 0 && allowDomains.length === 0) return false;

  if (allowEmails.map((x) => x.toLowerCase().trim()).includes(normalized)) return true;
  if (allowDomains.map((x) => x.toLowerCase().trim()).includes(domain)) return true;
  return false;
}
