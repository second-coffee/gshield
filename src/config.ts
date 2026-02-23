import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WrapperConfig } from './types.ts';

export const ROOT = process.cwd();
export const CONFIG_PATH = process.env.SECURE_WRAPPER_CONFIG || path.join(ROOT, 'config', 'wrapper-config.json');

export function loadConfig(): WrapperConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config at ${CONFIG_PATH}. Run setup.`);
  }
  const rawAny = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as any;

  // Backward-compatible migration for older configs.
  const calendarIds = Array.isArray(rawAny?.calendar?.ids)
    ? rawAny.calendar.ids
    : (rawAny?.calendar?.id ? [rawAny.calendar.id] : ['primary']);

  const cfg: WrapperConfig = {
    ...rawAny,
    calendar: { ids: calendarIds },
    policy: {
      ...rawAny.policy,
      email: {
        ...rawAny?.policy?.email,
        authHandlingMode: rawAny?.policy?.email?.authHandlingMode || (rawAny?.policy?.email?.returnSensitiveAuth ? 'warn' : 'block'),
        threadContextMode: rawAny?.policy?.email?.threadContextMode || 'full_thread'
      },
      calendar: {
        ...rawAny?.policy?.calendar,
        allowAttendeeEmails: rawAny?.policy?.calendar?.allowAttendeeEmails ?? true,
        allowLocation: rawAny?.policy?.calendar?.allowLocation ?? false,
        allowMeetingUrls: rawAny?.policy?.calendar?.allowMeetingUrls ?? false,
      }
    }
  };

  if (!cfg.auth?.apiKey || !cfg.auth?.tokenSigningKey) throw new Error('auth config incomplete');
  return cfg;
}

export function writeConfig(config: WrapperConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export const randomKey = (len = 32) => crypto.randomBytes(len).toString('hex');
