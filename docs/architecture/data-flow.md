# Data Flow Architecture

This document describes how data flows through Skillsmith and what stays local vs. what is transmitted.

## Data Classification

### Local-Only Data (Never Transmitted)

```
+---------------------------------------------------+
|                  YOUR COMPUTER                    |
+---------------------------------------------------+
|  ~/.skillsmith/analytics.db                       |
|  +-- Skill usage events                           |
|  +-- Time saved calculations                      |
|  +-- ROI metrics                                  |
|  +-- Session history                              |
|                                                   |
|  ~/.skillsmith/skills.db                          |
|  +-- Cached skill metadata                        |
|  +-- Search index                                 |
+---------------------------------------------------+
```

**Your analytics data never leaves your machine.** The ROI Dashboard, usage tracking, and time-saved calculations are entirely local features designed to show YOU the value you're getting from skills.

### Transmitted Data (Required for Service)

```
+--------------+     Search Query      +--------------+
|              | -------------------->  |              |
|    User      |                       |  Skillsmith  |
|  Computer    |  <------------------- |    API       |
|              |    Skill Results      |              |
+--------------+                       +--------------+
```

| Data Transmitted | When | Purpose |
|------------------|------|---------|
| Search queries | `skillsmith search "testing"` | Return matching skills |
| Skill IDs | Viewing or installing a skill | Fetch skill details |
| Sync requests | `skillsmith sync` | Get registry updates |

These requests are necessary for core functionality. No analytics or usage data is included.

### Telemetry (Opt-In Only)

```
Default:         User --X--> PostHog  (DISABLED)
Opt-In Enabled:  User ----> PostHog  (anonymous events only)
```

Telemetry is **disabled by default**. To enable:

1. Set `SKILLSMITH_TELEMETRY_ENABLED=true`
2. Configure `POSTHOG_API_KEY`

When enabled, only anonymous aggregate events are collected (search count, feature usage). No personal data, no skill names, no usage patterns.

## Storage Locations

| File | Purpose | Contains |
|------|---------|----------|
| `~/.skillsmith/skills.db` | Skill cache | Downloaded skill metadata, search index |
| `~/.skillsmith/analytics.db` | Usage analytics | Local-only ROI and usage tracking |
| `~/.skillsmith/sync.json` | Sync state | Last sync timestamp, config |

## Privacy Controls

### Run Fully Offline

```bash
SKILLSMITH_OFFLINE_MODE=true skillsmith list
```

Disables all network calls. Search will use local cache only.

### Disable Telemetry (Default)

Telemetry is off by default. To explicitly ensure it's disabled:

```bash
SKILLSMITH_TELEMETRY_ENABLED=false
```

### Clear Analytics Data

```bash
rm ~/.skillsmith/analytics.db
```

Your local analytics can be deleted at any time without affecting functionality.

## Summary

| Data Type | Location | Transmitted? |
|-----------|----------|--------------|
| Usage analytics | Local SQLite | Never |
| ROI metrics | Local SQLite | Never |
| Time saved | Local computation | Never |
| Skill cache | Local SQLite | Never (downloaded once) |
| Search queries | N/A | Yes (required) |
| Telemetry | PostHog | Opt-in only |
