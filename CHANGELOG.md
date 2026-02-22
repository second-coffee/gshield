# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/grahac/molt-workspace/compare/secure-wrapper-service-v0.1.0...HEAD
[0.1.0]: https://github.com/grahac/molt-workspace/releases/tag/secure-wrapper-service-v0.1.0