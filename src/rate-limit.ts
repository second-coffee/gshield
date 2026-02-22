import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.SECURE_WRAPPER_RATE || path.join(process.cwd(), 'logs', 'send-counters.json');

type Counter = { hourKey: string; dayKey: string; hourCount: number; dayCount: number };

function keys(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  return { hourKey: `${y}-${m}-${d}-${h}`, dayKey: `${y}-${m}-${d}` };
}

function load(): Counter {
  if (!fs.existsSync(FILE)) return { ...keys(), hourCount: 0, dayCount: 0 };
  return JSON.parse(fs.readFileSync(FILE, 'utf8')) as Counter;
}

function save(c: Counter) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(c, null, 2));
}

export function canSend(maxHour: number, maxDay: number): { ok: boolean; reason?: string } {
  const nowKeys = keys();
  const c = load();
  if (c.hourKey !== nowKeys.hourKey) { c.hourKey = nowKeys.hourKey; c.hourCount = 0; }
  if (c.dayKey !== nowKeys.dayKey) { c.dayKey = nowKeys.dayKey; c.dayCount = 0; }
  if (c.hourCount >= maxHour) return { ok: false, reason: 'hour_limit_exceeded' };
  if (c.dayCount >= maxDay) return { ok: false, reason: 'day_limit_exceeded' };
  return { ok: true };
}

export function recordSend(): void {
  const nowKeys = keys();
  const c = load();
  if (c.hourKey !== nowKeys.hourKey) { c.hourKey = nowKeys.hourKey; c.hourCount = 0; }
  if (c.dayKey !== nowKeys.dayKey) { c.dayKey = nowKeys.dayKey; c.dayCount = 0; }
  c.hourCount += 1;
  c.dayCount += 1;
  save(c);
}
