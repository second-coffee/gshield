import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WrapperConfig } from './types.ts';

const REPLAY_FILE = process.env.SECURE_WRAPPER_REPLAY || path.join(process.cwd(), 'logs', 'token-replay.json');

type Claims = { sub: string; iat: number; exp: number; jti: string; aud: string };

function b64url(input: Buffer | string): string { return Buffer.from(input).toString('base64url'); }

function verify(token: string, key: string): Claims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Claims;
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp < now) return null;
  if (!claims.iat || claims.iat > now + 10) return null;
  if (!claims.jti || claims.aud !== 'secure-wrapper') return null;
  return claims;
}

function loadReplay(): Record<string, number> {
  if (!fs.existsSync(REPLAY_FILE)) return {};
  return JSON.parse(fs.readFileSync(REPLAY_FILE, 'utf8')) as Record<string, number>;
}
function saveReplay(state: Record<string, number>) {
  fs.mkdirSync(path.dirname(REPLAY_FILE), { recursive: true });
  fs.writeFileSync(REPLAY_FILE, JSON.stringify(state, null, 2));
}
function checkAndMarkReplay(jti: string, exp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const s = loadReplay();
  Object.entries(s).forEach(([k, v]) => { if (v < now) delete s[k]; });
  if (s[jti]) return false;
  s[jti] = exp;
  saveReplay(s);
  return true;
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
  if (apiKey && apiKey === cfg.auth.apiKey) return { ok: true, principal: 'api-key' };
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
