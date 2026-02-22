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
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as WrapperConfig;
  if (!raw.auth?.apiKey || !raw.auth?.tokenSigningKey) throw new Error('auth config incomplete');
  return raw;
}

export function writeConfig(config: WrapperConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export const randomKey = (len = 32) => crypto.randomBytes(len).toString('hex');
