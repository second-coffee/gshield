import fs from 'node:fs';
import path from 'node:path';

const AUDIT = process.env.SECURE_WRAPPER_AUDIT || path.join(process.cwd(), 'logs', 'audit.jsonl');

export type AuditEvent = Record<string, unknown> & { action: string };

export function logAudit(entry: AuditEvent): void {
  fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
  fs.appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}
