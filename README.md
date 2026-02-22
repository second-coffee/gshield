# gshield — Shield Google Agent Wrapper

Production-focused restricted Gmail + Google Calendar wrapper for agent callers.

Built for least-privilege agent access: agents can call approved functions without direct access to Google credentials or broad account data.

## Security controls implemented

- **Deny-by-default** routing (`404` for unknown routes)
- **AuthN/AuthZ**
  - API key (`x-api-key` / `x-agent-key`)
  - Short-lived HMAC signed bearer tokens (`/v1/auth/token`)
  - Replay protection (`jti` one-time use persisted in `logs/token-replay.json`)
- **Unread Gmail bound**: max 2 days by policy clamp
- **Security-email filtering/redaction**: OTP/reset/login/2FA patterns redacted and optionally excluded
- **Calendar bounds**: clamped to configured past/future windows (defaults to this week)
- **Outbound controls**
  - reply-only default
  - recipient/domain allowlists
  - send caps per hour/day
- **Payload limit**: request body size capped (`server.maxPayloadBytes`)
- **Rate limits**: per-principal request cap per minute
- **Audit log**: append-only JSONL at `logs/audit.jsonl`

## One-time setup

```bash
cd /home/moltbot/work/secure-wrapper-service
npm install
npm run setup -- --gmail-account iamsidekickcaleb@gmail.com --calendar-id primary --port 8787 --bind 127.0.0.1
```

Creates `config/wrapper-config.json` with default locked policy.

## Run

```bash
npm start
```

## API

### `GET /healthz`
Liveness check.

### `POST /v1/auth/token`
Mint short-lived bearer token using API key.

Headers:
- `x-api-key: <apiKey>`

Body:
```json
{"sub":"agent-name"}
```

### `GET /v1/email/unread?days=2`
- `days` clamped by `policy.email.maxRecentDays` (default 2)
- Sensitive auth/security emails redacted and filtered by policy

### `GET /v1/calendar/events?start=<iso>&end=<iso>`
- Range clamped to policy bounds
- Defaults to this week when omitted

### `POST /v1/email/reply`
Allowed by default subject to allowlist + send caps.

### `POST /v1/email/send`
Blocked when `policy.outbound.replyOnlyDefault=true`.

### Feature toggles
- If `features.emailEnabled=false`, email endpoints return `403 email_disabled`
- If `features.calendarEnabled=false`, calendar endpoint returns `403 calendar_disabled`

## Config highlights

- `auth.apiKey`: static secret for low-friction auth
- `auth.tokenSigningKey`: local-only signing secret
- `auth.tokenTtlSeconds`: short token lifetime (default 120)
- `policy.outbound.recipientAllowlist` + `domainAllowlist`

## Non-root Linux/macOS deployment

### Principle
Run wrapper under a **dedicated local user** separate from the agent account so credentials remain isolated.

### Linux (systemd user service)
1. Create dedicated user (`wrappersvc`) and install config/secrets under that user home.
2. Log in as `wrappersvc`, run `gog` auth for Gmail/Calendar once.
3. Create `~/.config/systemd/user/secure-wrapper.service`:

```ini
[Unit]
Description=Secure Wrapper Service
After=network-online.target

[Service]
WorkingDirectory=/home/wrappersvc/secure-wrapper-service
ExecStart=/usr/bin/npm start
Environment=NODE_ENV=production
Restart=on-failure

[Install]
WantedBy=default.target
```

4. Enable:
```bash
systemctl --user daemon-reload
systemctl --user enable --now secure-wrapper.service
```

### macOS (launchd)
Create `~/Library/LaunchAgents/com.local.secure-wrapper.plist` under dedicated user and run `npm start` in repo directory.

## Credential isolation guidance

- Keep `config/wrapper-config.json` mode `0600`.
- Keep Google OAuth context only in wrapper service user profile.
- Never expose OAuth tokens or raw credential files in API responses.
- Agent only receives API key and short-lived tokens.

## OpenClaw deployment (recommended)

### Goal
Run gshield as a local sidecar service that agents can call, while Google credentials remain inaccessible to agent processes.

### 1) Install as dedicated service user
Use a separate OS account (example: `wrappersvc`) from the account running OpenClaw agents.

```bash
# as wrappersvc
cd /home/wrappersvc/gshield
npm install
npm run setup -- --gmail-account you@domain.com --calendar-id primary --enable-email true --enable-calendar true --port 8787 --bind 127.0.0.1
```

This generates `config/wrapper-config.json` with API/auth/policy defaults.

### 2) Lock down permissions

```bash
chmod 700 config logs
chmod 600 config/wrapper-config.json
```

Only the wrapper service user should be able to read this file.

### 3) Run as background service

Linux (`systemd --user` under wrappersvc):

```ini
[Unit]
Description=gshield service
After=network-online.target

[Service]
WorkingDirectory=/home/wrappersvc/gshield
ExecStart=/usr/bin/npm start
Environment=NODE_ENV=production
Restart=on-failure

[Install]
WantedBy=default.target
```

macOS (`launchd`): run `npm start` from a LaunchAgent under the dedicated wrapper user.

### 4) Keep network scope local
- Bind only to `127.0.0.1`
- Do not expose gshield port publicly
- Prefer host firewall deny-by-default for inbound

### 5) Connect OpenClaw safely
- Give agent/tooling only gshield API credentials (not Google OAuth tokens)
- Restrict agent tool access to gshield endpoints only
- Keep OpenClaw agent process as non-root user

### 6) Policy knobs to set before production
In `config/wrapper-config.json`:
- `features.emailEnabled` / `features.calendarEnabled` (turn either surface on/off)
- `policy.email.maxRecentDays` (default 2)
- `policy.email.returnSensitiveAuth` (keep `false`)
- `policy.calendar.defaultThisWeek`, `maxPastDays`, `maxFutureDays`
- `policy.outbound.replyOnlyDefault` (recommended `true`)
- `policy.outbound.recipientAllowlist` / `domainAllowlist`
- `policy.outbound.maxSendsPerHour` / `maxSendsPerDay`

### 7) State files (database question)
gshield currently uses local state files (no external DB required):
- `config/wrapper-config.json` (policy + auth config)
- `logs/audit.jsonl` (append-only audit events)
- `logs/token-replay.json` (token replay protection)
- `logs/send-counters.json` (outbound quota counters)

For multi-host/high-availability setups, you can replace replay/quota local files with Redis/Postgres later.

## Tests

```bash
npm test
```
