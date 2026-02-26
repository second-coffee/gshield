# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-02-26

### Added
- Calendar create and update endpoints (`POST /v1/calendar/events`, `PATCH /v1/calendar/events/:id`) with deny-by-default policy
- Calendar write policy controls: per-calendar write allowlists, attendee invite blocking, forced `sendUpdates` override, and hourly/daily rate limits
- Separate calendar mutation rate limiter with its own counter file (`logs/calendar-counters.json`)
- `allowReplyToAnyone` flag so replies can bypass the recipient allowlist (enabled by default, since you're responding to someone who contacted you)
- `allowAllRecipients` flag for unrestricted outbound sends (off by default)
- Calendar privacy parameters: `allowLocation`, `allowAttendeeEmails`, `allowMeetingUrls` each independently toggleable

### Changed
- README rewritten for human readers with what/why/how structure, getting started guide, and full configuration reference
- Fixed `gog` CLI link to correct repository (`https://github.com/steipete/gogcli`)

## [0.1.0] - 2026-02-22

### Added
- Built the initial secure Gmail and Google Calendar wrapper MVP with policy enforcement, setup flow, audit logging, documentation, and tests
- Upgraded the service to TypeScript + Hono with outbound controls and persistent auth foundations
- Added token replay protection and hardened request handling for API auth
- Added configurable email auth-content handling modes (`block` and `warn`)
- Added configurable email thread context modes (`full_thread` and `latest_only`)
- Added support for aggregating events across multiple calendars

### Changed
- Improved runtime safety for audit and rate-limit path handling
- Tightened auth, recipient allowlist checks, parsing behavior, and quota accounting
- Improved handling of residual P3 hardening items including streamed payload caps, typed calendar behavior, and replay sweeper stability

### Fixed
- Contained upstream provider failures behind stable API error responses
- Hardened replay marker safety and related auth edge cases

[Unreleased]: https://github.com/second-coffee/gshield/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/second-coffee/gshield/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/second-coffee/gshield/releases/tag/v0.1.0
