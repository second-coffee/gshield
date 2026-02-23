# gshield

gshield is a security proxy that sits between an AI agent and your Google account. Instead of giving the agent direct OAuth access to Gmail and Calendar, the agent talks to gshield — and gshield enforces exactly what it can read, what it can send, and who it can contact.

## Why this exists

Giving an AI agent raw OAuth access to your Gmail is like handing it a master key. It can read everything, send to anyone, and you have no visibility into what it did. gshield solves this by acting as a controlled gateway:

- The agent never touches Google credentials directly
- Every request is logged with who made it and what they got
- Security-sensitive emails (OTPs, 2FA codes, password resets) are blocked before the agent ever sees them
- Outbound email requires recipients to be on an allowlist
- All time ranges, rate limits, and payload sizes are hard-capped by config

## What gshield can access

gshield uses a Google account authorized via [`gog`](https://github.com/openclaw/gog), which handles OAuth. The permissions required depend on which surfaces you enable:

| Surface | Google permission needed |
|---------|--------------------------|
| Read unread email | `gmail.readonly` |
| Send replies | `gmail.send` |
| Read calendar events | `calendar.readonly` |

**The agent never sees these credentials.** It only receives a short-lived signed token (default 2 minutes) issued by gshield in exchange for an API key.

## What agents can and can't do

### Email
- **Can read**: unread messages within the configured lookback window (default: 2 days)
- **Cannot read**: emails containing OTP codes, login links, 2FA prompts, or password reset flows — these are blocked entirely by default
- **Can send**: replies and new messages to addresses on the recipient or domain allowlist
- **Cannot send**: to anyone not on the allowlist; cannot exceed hourly or daily send caps

### Calendar
- **Can read**: events within the configured time window (default: this week)
- **Location, attendee emails, and meeting URLs** are each off by default — you opt in per field in config

### Everything else
- All other routes return `404`. There is no route an agent can discover that isn't explicitly defined.

## How a request flows

```
Agent
  │  API key or short-lived bearer token
  ▼
gshield
  ├─ authenticates the caller
  ├─ checks rate limit
  ├─ clamps time ranges to policy bounds
  ├─ calls Google via gog
  ├─ filters/redacts response per policy
  ├─ writes audit log entry
  └─ returns sanitized JSON
```

All audit entries are appended to `logs/audit.jsonl` and include the principal, action, parameters, and result count.

## Security controls implemented

- **Deny-by-default** routing (`404` for unknown routes)
- **AuthN/AuthZ**
  - API key (`x-api-key` / `x-agent-key`)
  - Short-lived HMAC signed bearer tokens (`/v1/auth/token`)
  - Replay protection (`jti` one-time use persisted in `logs/token-replay.json`)
- **Unread Gmail bound**: max 2 days by policy clamp
- **Security-email filtering**: OTP/reset/login/2FA patterns can hard-block entire emails (`block`) or pass with warnings (`warn`)
- **Calendar bounds**: clamped to configured past/future windows (defaults to this week)
- **Outbound controls**
  - reply-only default
  - recipient/domain allowlists
  - send caps per hour/day
- **Payload limit**: request body size capped (`server.maxPayloadBytes`)
- **Rate limits**: per-principal request cap per minute
- **Audit log**: append-only JSONL at `logs/audit.jsonl`

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Authorize Google access

gshield uses [`gog`](https://github.com/openclaw/gog) to talk to Google. Install it and authorize the account you want the agent to use:

```bash
gog auth --account you@gmail.com
```

This stores OAuth tokens locally for `gog` to use. gshield never touches them directly.

### 3. Generate config

```bash
npm run setup -- --gmail-account you@gmail.com --calendar-ids primary --port 8787 --bind 127.0.0.1
```

This creates `config/wrapper-config.json` with safe defaults:
- Email lookback: 2 days
- Calendar window: this week only
- Outbound: reply-only, no send allowlist (you add recipients manually)
- Auth-sensitive emails: blocked
- Calendar location / attendees / meeting URLs: off

The API key printed to stdout is what the agent uses. Store it somewhere safe (password manager, secret manager). It won't be shown again but is readable in the config file (`0600` permissions).

To enable multiple calendars:
```bash
npm run setup -- --gmail-account you@gmail.com --calendar-ids primary,work,team@example.com
```

### 4. Start gshield

```bash
npm start
```

gshield listens on `127.0.0.1:8787` by default — local only, not exposed to the internet.

### 5. Connect your agent

Have the agent mint a short-lived token before making requests:

```bash
# Mint a token (valid for 2 minutes by default)
curl -s -X POST http://localhost:8787/v1/auth/token \
  -H "x-api-key: YOUR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"sub":"my-agent"}' | jq .token

# Use it
curl -s http://localhost:8787/v1/email/unread \
  -H "authorization: Bearer TOKEN"
```

Each token is single-use. The agent should mint a fresh one per request, or per session.

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

### `GET /v1/email/unread?days=2&contextMode=full_thread|latest_only`
- `days` clamped by `policy.email.maxRecentDays` (default 2)
- `contextMode` controls full thread vs latest-only view (quote/reply content stripped)
- Sensitive auth/security emails are policy-driven:
  - `authHandlingMode=block` (default): full email withheld
  - `authHandlingMode=warn`: pass through with `warnings[]` showing what would have been blocked

### `GET /v1/calendar/events?start=<iso>&end=<iso>&calendars=primary,work`
- Range clamped to policy bounds
- Defaults to this week when omitted
- Supports multiple calendars via configured `calendar.ids` or request override

### `POST /v1/email/reply`
Allowed by default subject to allowlist + send caps.

### `POST /v1/email/send`
Blocked when `policy.outbound.replyOnlyDefault=true`.

## Configuration reference

The config lives at `config/wrapper-config.json` (or the path in `$SECURE_WRAPPER_CONFIG`). `npm run setup` generates it with safe defaults. Edit the file directly to change any setting — restart gshield to apply.

### `server`

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `8787` | Port to listen on |
| `bind` | `127.0.0.1` | Interface to bind. Keep this as loopback unless you're behind a reverse proxy |
| `maxPayloadBytes` | `32768` | Max request body size in bytes. Requests over this limit get `413` |
| `rateLimitPerMinute` | `60` | Max requests per principal per minute. Exceeding returns `429` |

### `auth`

| Key | Default | Description |
|-----|---------|-------------|
| `apiKey` | *(generated)* | Static secret the agent includes as `x-api-key`. Treat like a password |
| `tokenSigningKey` | *(generated)* | HMAC key used to sign bearer tokens. Never share this |
| `previousTokenSigningKey` | `""` | Old signing key kept during rotation so in-flight tokens still verify |
| `tokenTtlSeconds` | `120` | How long a minted bearer token is valid. Tokens are also single-use |

### `gmail`

| Key | Default | Description |
|-----|---------|-------------|
| `account` | *(required)* | Gmail address `gog` is authorized for |

### `calendar`

| Key | Default | Description |
|-----|---------|-------------|
| `ids` | `["primary"]` | Calendar IDs to query by default. Use Google Calendar's calendar ID (visible in calendar settings). Agents can request a subset of these but cannot request calendars outside this list |

### `policy.email`

| Key | Default | Description |
|-----|---------|-------------|
| `maxRecentDays` | `2` | Agent can request at most this many days of unread email. Requests for more are silently clamped |
| `authHandlingMode` | `"block"` | What to do with emails that look like OTPs, login codes, 2FA prompts, or password resets. `block` withholds them entirely; `warn` passes them through with a `warnings[]` field in the response |
| `threadContextMode` | `"full_thread"` | `full_thread` returns full message body and snippet. `latest_only` strips quoted reply text, showing only the most recent content |

### `policy.calendar`

| Key | Default | Description |
|-----|---------|-------------|
| `defaultThisWeek` | `true` | When the agent omits `start`/`end`, use the current week as the range |
| `maxPastDays` | `0` | How far back the agent can query. `0` means no past events; increase to allow historical lookback |
| `maxFutureDays` | `7` | How far ahead the agent can query. Requests beyond this are clamped |
| `allowAttendeeEmails` | `true` | Include attendee names, emails, and RSVP status in event responses |
| `allowLocation` | `false` | Include the event location field (can contain physical addresses or room names) |
| `allowMeetingUrls` | `false` | Include Google Meet `hangoutLink` in event responses |

### `policy.outbound`

| Key | Default | Description |
|-----|---------|-------------|
| `replyOnlyDefault` | `true` | When `true`, the `POST /v1/email/send` route (new emails) returns `403`. Only replies are allowed |
| `recipientAllowlist` | `[]` | Exact email addresses the agent is allowed to send to |
| `domainAllowlist` | `[]` | Domains the agent is allowed to send to (e.g. `"example.com"` covers all addresses at that domain) |
| `maxSendsPerHour` | `5` | Rolling hourly send cap across all outbound routes |
| `maxSendsPerDay` | `25` | Rolling daily send cap across all outbound routes |

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
