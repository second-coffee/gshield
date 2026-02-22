import { randomKey, writeConfig } from './config.ts';
import type { WrapperConfig } from './types.ts';

function arg(name: string, fallback: string | null = null): string | null {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

const gmailAccount = arg('--gmail-account');
const calendarId = arg('--calendar-id', 'primary')!;
const port = Number(arg('--port', '8787'));
const bind = arg('--bind', '127.0.0.1')!;
const enableEmail = (arg('--enable-email', 'true') || 'true').toLowerCase() !== 'false';
const enableCalendar = (arg('--enable-calendar', 'true') || 'true').toLowerCase() !== 'false';

if ((enableEmail || enableCalendar) && !gmailAccount) {
  console.error('Usage: npm run setup -- --gmail-account <account> [--calendar-id primary] [--enable-email true|false] [--enable-calendar true|false] [--port 8787] [--bind 127.0.0.1]');
  process.exit(1);
}

const cfg: WrapperConfig = {
  server: {
    port,
    bind,
    maxPayloadBytes: 32 * 1024,
    rateLimitPerMinute: 60
  },
  auth: {
    apiKey: randomKey(24),
    tokenSigningKey: randomKey(32),
    previousTokenSigningKey: '',
    tokenTtlSeconds: 120
  },
  features: {
    emailEnabled: enableEmail,
    calendarEnabled: enableCalendar
  },
  gmail: { account: gmailAccount || '' },
  calendar: { id: calendarId },
  policy: {
    email: {
      maxRecentDays: 2,
      returnSensitiveAuth: false
    },
    calendar: {
      defaultThisWeek: true,
      maxPastDays: 0,
      maxFutureDays: 7
    },
    outbound: {
      replyOnlyDefault: true,
      recipientAllowlist: [],
      domainAllowlist: [],
      maxSendsPerHour: 5,
      maxSendsPerDay: 25
    }
  }
};

writeConfig(cfg);
console.log('✅ Setup complete: config/wrapper-config.json');
console.log('API key (store in secret manager):', cfg.auth.apiKey);
console.log('Token signing key stored only in local config file with 0600 perms.');
