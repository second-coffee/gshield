import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WrapperConfig } from './types.ts';

type Claims = { sub: string; iat: number; exp: number; jti: string; aud: string };

const replayState = { lastSweepMs: 0 };

function replayDir(): string {
  return process.env.SECURE_WRAPPER_REPLAY_DIR || path.join(process.cwd(), 'logs', 'token-replay');
}

function b64url(input: Buffer | string): string { return Buffer.from(input).toString('base64url'); }

function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isSafeJti(jti: string): boolean {
  // Accept UUID-like JTIs only (prevents path tricks and unbounded filename abuse).
  return /^[a-f0-9-]{16,64}$/i.test(jti);
}

function verify(token: string, key: string): Claims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const expected = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
    if (!safeEqualText(s, expected)) return null;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Claims;
    const now = Math.floor(Date.now() / 1000);
    if (!claims.exp || claims.exp < now) return null;
    if (!claims.iat || claims.iat > now + 10) return null;
    if (!claims.jti || claims.aud !== 'secure-wrapper') return null;
    if (!claims.sub || typeof claims.sub !== 'string') return null;
    if (!isSafeJti(claims.jti)) return null;
    return claims;
  } catch {
    return null;
  }
}

function replayMarker(jti: string): string {
  return path.join(replayDir(), `${jti}.json`);
}

function ensureReplayDir() {
  fs.mkdirSync(replayDir(), { recursive: true });
}

function sweepExpiredReplayMarkers(nowSec: number) {
  const nowMs = Date.now();
  if (nowMs - replayState.lastSweepMs < 60_000) return;
  replayState.lastSweepMs = nowMs;

  const dir = replayDir();
  if (!fs.existsSync(dir)) return;
  const names = fs.readdirSync(dir);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { exp?: number };
      if (!parsed.exp || parsed.exp < nowSec) fs.rmSync(file, { force: true });
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
}

function checkAndMarkReplay(jti: string, exp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return false;
  ensureReplayDir();
  sweepExpiredReplayMarkers(now);
  const marker = replayMarker(jti);
  try {
    const fd = fs.openSync(marker, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ exp }));
    fs.closeSync(fd);
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

export function sweepReplayNow(): void {
  ensureReplayDir();
  sweepExpiredReplayMarkers(Math.floor(Date.now() / 1000));
}

export function startReplaySweeper(intervalMs = 60_000): NodeJS.Timeout {
  return setInterval(() => {
    try { sweepReplayNow(); } catch {}
  }, intervalMs);
}

export function issueSignedToken(subject: string, cfg: WrapperConfig): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub: subject, iat: now, exp: now + cfg.auth.tokenTtlSeconds, jti: crypto.randomUUID(), aud: 'secure-wrapper' }));
  const sig = crypto.createHmac('sha256', cfg.auth.tokenSigningKey).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function authenticate(headers: Headers, cfg: WrapperConfig): { ok: boolean; principal?: string; reason?: string } {
  const apiKey = headers.get('x-api-key') || headers.get('x-agent-key');
  if (apiKey && safeEqualText(apiKey, cfg.auth.apiKey)) return { ok: true, principal: 'api-key' };
  const auth = headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return { ok: false, reason: 'missing_credentials' };
  const token = auth.slice('Bearer '.length);
  const keys = [cfg.auth.tokenSigningKey, cfg.auth.previousTokenSigningKey].filter(Boolean) as string[];
  let claims: Claims | null = null;
  for (const k of keys) { claims = verify(token, k); if (claims) break; }
  if (!claims) return { ok: false, reason: 'invalid_token' };
  if (!checkAndMarkReplay(claims.jti, claims.exp)) return { ok: false, reason: 'replay_detected' };
  return { ok: true, principal: claims.sub };
}
