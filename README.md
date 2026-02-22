# Secure Wrapper Service (TypeScript + Hono)

Production-focused restricted Gmail + Google Calendar wrapper for agent callers.

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

## Tests

```bash
npm test
```
