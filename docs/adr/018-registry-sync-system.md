# ADR-018: Registry Sync System

**Status**: Accepted
**Date**: 2026-01-15
**Deciders**: William Smith, Claude

## Context

Users who install Skillsmith at different times have different local skill databases. A user who installs today and another who installs a month later (when 10,000 more skills exist in the live registry) would have vastly different experiences without a synchronization mechanism.

The core problem: **How do users keep their local skill database up-to-date with the live Skillsmith registry?**

Key requirements:
1. Users need a way to manually sync when desired
2. Automatic background sync should be available but user-controlled
3. Sync should be efficient (differential, not full refresh)
4. Must work within Claude Code's MCP server session model

## Decision

Implement a three-tier registry sync system:

### 1. Manual CLI Sync (Primary)
```bash
skillsmith sync              # Differential sync
skillsmith sync --force      # Full sync
skillsmith sync --dry-run    # Preview changes
```

### 2. Configurable Background Sync (Secondary)
- Session-based: runs during active MCP server sessions
- User-configurable frequency: daily (default) or weekly
- Checks every 60 seconds if sync is due
- Uses `timer.unref()` to not block process exit

### 3. Differential Sync (Tertiary)
- Tracks `last_sync_at` timestamp in local database
- Compares API `updated_at` with local timestamp
- Only fetches and upserts changed skills
- Reduces API calls and bandwidth significantly

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│ CLI: skillsmith sync                                     │
│ MCP: BackgroundSyncService                              │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│ SyncEngine                                               │
│ - Checks lastSyncAt from sync_config                    │
│ - Fetches from API with pagination (100/page)           │
│ - Filters: updated_at > lastSyncAt                      │
│ - Upserts changed skills to local DB                    │
│ - Updates lastSyncAt on completion                      │
└─────────────────────────────────────────────────────────┘
```

### Database Schema

Two new tables added in migration v3:

**sync_config** (singleton):
- `enabled`: Auto-sync on/off
- `frequency`: 'daily' | 'weekly'
- `last_sync_at`: ISO timestamp
- `next_sync_at`: Calculated from frequency
- `last_sync_error`: Error tracking

**sync_history**:
- Tracks each sync run
- Records: added, updated, unchanged counts
- Duration and error information
- Enables debugging and monitoring

## Consequences

### Positive
- Users always have access to latest skills with minimal effort
- Background sync is transparent and non-intrusive
- Differential sync minimizes bandwidth and API load
- Full audit trail via sync_history table
- User control over sync behavior (enable/disable, frequency)

### Negative
- Additional database tables increase schema complexity
- Background process adds memory footprint during sessions
- First-time sync after long gap may be slow
- Relies on API `updated_at` accuracy

### Neutral
- Session-only background sync means no sync when Claude Code isn't active
- Users must run `skillsmith sync` manually for immediate updates
- Sync frequency is limited to daily/weekly (no custom intervals)

## Alternatives Considered

### Alternative 1: Persistent Daemon Process
- Pros: Syncs even when user isn't actively using Claude Code
- Cons: Complex cross-platform daemon management, resource overhead
- Why rejected: Over-engineered for the use case; most users have frequent Claude Code sessions

### Alternative 2: Push-Based Updates (WebSockets)
- Pros: Real-time updates, no polling
- Cons: Requires persistent connection, complex infrastructure
- Why rejected: Overkill for skill registry updates; polling is sufficient

### Alternative 3: No Background Sync (Manual Only)
- Pros: Simplest implementation
- Cons: Users must remember to sync; poor UX
- Why rejected: Doesn't solve the core "stale database" problem

### Alternative 4: Server-Side Timestamp Filtering
- Pros: More efficient differential sync at API level
- Cons: Requires API changes on Supabase backend
- Why rejected: Client-side filtering works well enough; API changes add complexity

## References

- [Architecture Documentation](../architecture/registry-sync-architecture.md)
- [ADR-101: SQLite Local-First](./101-sqlite-local-first.md)
- [API Client Implementation](../../packages/core/src/api/client.ts)
