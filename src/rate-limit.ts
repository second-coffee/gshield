import fs from 'node:fs';
import path from 'node:path';

const ensuredDirs = new Set<string>();

type Counter = { hourKey: string; dayKey: string; hourCount: number; dayCount: number };

function paths(kind: 'send' | 'calendar' = 'send') {
  const envKey = kind === 'calendar' ? 'SECURE_WRAPPER_CALENDAR_RATE' : 'SECURE_WRAPPER_RATE';
  const defaultFile = kind === 'calendar' ? 'calendar-counters.json' : 'send-counters.json';
  const file = process.env[envKey] || path.join(process.cwd(), 'logs', defaultFile);
  return { file, lock: `${file}.lock` };
}

function keys(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  return { hourKey: `${y}-${m}-${d}-${h}`, dayKey: `${y}-${m}-${d}` };
}

function ensureDir(file: string) {
  const dir = path.dirname(file);
  if (ensuredDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  ensuredDirs.add(dir);
}

function load(file: string): Counter {
  if (!fs.existsSync(file)) return { ...keys(), hourCount: 0, dayCount: 0 };
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Counter;
}

function save(file: string, c: Counter) {
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(c, null, 2));
}

function withLock<T>(kind: 'send' | 'calendar', fn: () => T): T {
  const p = paths(kind);
  ensureDir(p.file);
  for (let i = 0; i < 200; i += 1) {
    try {
      const fd = fs.openSync(p.lock, 'wx');
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        fs.unlinkSync(p.lock);
      }
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      const until = Date.now() + 5;
      while (Date.now() < until) { /* backoff */ }
    }
  }
  throw new Error('rate_limit_lock_timeout');
}

export function canSend(maxHour: number, maxDay: number): { ok: boolean; reason?: string } {
  const nowKeys = keys();
  const p = paths();
  const c = load(p.file);
  if (c.hourKey !== nowKeys.hourKey) { c.hourKey = nowKeys.hourKey; c.hourCount = 0; }
  if (c.dayKey !== nowKeys.dayKey) { c.dayKey = nowKeys.dayKey; c.dayCount = 0; }
  if (c.hourCount >= maxHour) return { ok: false, reason: 'hour_limit_exceeded' };
  if (c.dayCount >= maxDay) return { ok: false, reason: 'day_limit_exceeded' };
  return { ok: true };
}

export function recordSend(): void {
  const nowKeys = keys();
  const p = paths();
  const c = load(p.file);
  if (c.hourKey !== nowKeys.hourKey) { c.hourKey = nowKeys.hourKey; c.hourCount = 0; }
  if (c.dayKey !== nowKeys.dayKey) { c.dayKey = nowKeys.dayKey; c.dayCount = 0; }
  c.hourCount += 1;
  c.dayCount += 1;
  save(p.file, c);
}

export function consumeSendQuota(maxHour: number, maxDay: number): { ok: boolean; reason?: string } {
  return withLock('send', () => {
    const nowKeys = keys();
    const p = paths('send');
    const c = load(p.file);
    if (c.hourKey !== nowKeys.hourKey) { c.hourKey = nowKeys.hourKey; c.hourCount = 0; }
    if (c.dayKey !== nowKeys.dayKey) { c.dayKey = nowKeys.dayKey; c.dayCount = 0; }
    if (c.hourCount >= maxHour) return { ok: false, reason: 'hour_limit_exceeded' };
    if (c.dayCount >= maxDay) return { ok: false, reason: 'day_limit_exceeded' };
    c.hourCount += 1;
    c.dayCount += 1;
    save(p.file, c);
    return { ok: true };
  });
}

export function consumeCalendarQuota(maxHour: number, maxDay: number): { ok: boolean; reason?: string } {
  return withLock('calendar', () => {
    const nowKeys = keys();
    const p = paths('calendar');
    const c = load(p.file);
    if (c.hourKey !== nowKeys.hourKey) { c.hourKey = nowKeys.hourKey; c.hourCount = 0; }
    if (c.dayKey !== nowKeys.dayKey) { c.dayKey = nowKeys.dayKey; c.dayCount = 0; }
    if (c.hourCount >= maxHour) return { ok: false, reason: 'hour_limit_exceeded' };
    if (c.dayCount >= maxDay) return { ok: false, reason: 'day_limit_exceeded' };
    c.hourCount += 1;
    c.dayCount += 1;
    save(p.file, c);
    return { ok: true };
  });
}
