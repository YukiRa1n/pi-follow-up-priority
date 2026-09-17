# Changelog

All notable changes to `@yukira1n/pi-follow-up-priority` are documented here.

## [0.1.0] - 2026-09-17

### Added

- Durable identities and explicit per-item completion receipts for interactive and RPC follow-ups.
- Dynamic newest-first steering priority while preserving FIFO ordering for ordinary follow-ups.
- Provider-only priority ledgers, independent-item boundaries, and conditional Todo guidance.
- Queue recovery across reload, context pruning, branch navigation, final-poll races, and session lifecycle events.
- A fail-closed Pi 0.84.x/0.85.x compatibility patch for lossless compaction-queue rollback.
