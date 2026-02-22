import fs from 'node:fs';
import path from 'node:path';

const ensuredDirs = new Set<string>();

export type AuditEvent = Record<string, unknown> & { action: string };

function auditFile(): string {
  return process.env.SECURE_WRAPPER_AUDIT || path.join(process.cwd(), 'logs', 'audit.jsonl');
}

function ensureDir(file: string) {
  const dir = path.dirname(file);
  if (ensuredDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  ensuredDirs.add(dir);
}

export function logAudit(entry: AuditEvent): void {
  const file = auditFile();
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}
