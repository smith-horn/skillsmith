# Infrastructure Architecture

> **Navigation**: [Technical Index](../technical/index.md) | [Overview](../technical/overview.md) | [Performance](../technical/performance.md)

**Version:** 1.0
**Last Updated:** December 26, 2025
**Author:** DevOps/Infrastructure Architect
**Status:** Design Document - Pending Implementation

---

## Executive Summary

The Claude Discovery Hub follows a **local-first, distributed architecture** that prioritizes:
- **Offline capability**: Core functionality works without network access
- **Privacy by default**: All user data stays on the local machine
- **Zero-dependency deployment**: Single npm package with SQLite embedded
- **Sustainable infrastructure**: Minimal ongoing operational costs

This document details the infrastructure design across seven key areas: local-first architecture, distribution strategy, background sync, web infrastructure, monitoring, CI/CD, and performance targets.

---

## Table of Contents

1. [Local-First Architecture](#1-local-first-architecture)
2. [Distribution Strategy](#2-distribution-strategy)
3. [Background Sync Infrastructure](#3-background-sync-infrastructure)
4. [Web Infrastructure](#4-web-infrastructure)
5. [Monitoring and Observability](#5-monitoring-and-observability)
6. [CI/CD Pipeline](#6-cicd-pipeline)
7. [Performance Targets](#7-performance-targets)
8. [Cost Analysis](#8-cost-analysis)
9. [Security Considerations](#9-security-considerations)
10. [Disaster Recovery](#10-disaster-recovery)

---

## 1. Local-First Architecture

### 1.1 System Overview Diagram

```
+============================================================================+
|  USER'S LOCAL MACHINE                                                       |
+============================================================================+
|                                                                             |
|  +---------------------------+         +--------------------------------+   |
|  |     Claude Code CLI       |         |    VS Code Extension           |   |
|  |     (Primary Interface)   |         |    (IDE Integration)           |   |
|  +-----------+---------------+         +---------------+----------------+   |
|              |                                         |                    |
|              v                                         v                    |
|  +------------------------------------------------------------------+      |
|  |                    MCP Server Runtime                             |      |
|  |  +------------------+ +------------------+ +------------------+   |      |
|  |  | discovery-core   | | learning         | | sync             |   |      |
|  |  | (150MB, 1.5s)    | | (50MB, 0.5s)     | | (100MB, 0.5s)    |   |      |
|  |  +------------------+ +------------------+ +------------------+   |      |
|  +------------------------------------------------------------------+      |
|              |                                                              |
|              v                                                              |
|  +------------------------------------------------------------------+      |
|  |  ~/.claude-discovery/                                             |      |
|  |  +------------------+ +------------------+ +------------------+   |      |
|  |  | index/           | | config/          | | cache/           |   |      |
|  |  | - skills.db      | | - settings.json  | | - api_cache.db   |   |      |
|  |  | - embeddings.bin | | - blocklist.json | | - images/        |   |      |
|  |  | - metadata.json  | | - priorities.yaml| +------------------+   |      |
|  |  +------------------+ +------------------+                        |      |
|  +------------------------------------------------------------------+      |
|                                                                             |
+============================================================================+
              |                                    ^
              v                                    |
+============================================================================+
|  EXTERNAL SERVICES (Optional, for sync)                                     |
+============================================================================+
|                                                                             |
|  +----------------+  +------------------+  +------------------+             |
|  | GitHub CDN     |  | discoveries.dev  |  | GitHub API       |             |
|  | (Index Bundle) |  | (Web Browser)    |  | (Incremental)    |             |
|  +----------------+  +------------------+  +------------------+             |
|                                                                             |
+============================================================================+
```

### 1.2 MCP Server Deployment

The MCP servers are deployed as part of a single npm package, installed globally or locally.

#### Package Structure

```
@claude-discovery/hub
├── bin/
│   └── claude-discovery          # CLI entry point
├── dist/
│   ├── mcp/
│   │   ├── discovery-core.js     # Main discovery server
│   │   ├── learning.js           # Learning path server
│   │   └── sync.js               # Background sync server
│   ├── cli/
│   │   └── index.js              # CLI commands
│   └── shared/
│       ├── database.js           # SQLite wrapper
│       ├── embeddings.js         # Vector search
│       └── github.js             # GitHub API client
├── assets/
│   ├── index-bootstrap.db        # Pre-populated skill index (~5MB)
│   └── embeddings-bootstrap.bin  # Pre-computed embeddings (~20MB)
└── package.json
```

#### MCP Server Configuration

Claude Code integrates with MCP servers via `~/.config/claude/mcp_settings.json`:

```json
{
  "servers": {
    "claude-discovery": {
      "command": "npx",
      "args": ["@claude-discovery/hub", "mcp-server"],
      "env": {
        "CLAUDE_DISCOVERY_HOME": "~/.claude-discovery",
        "CLAUDE_DISCOVERY_LOG_LEVEL": "info"
      }
    }
  }
}
```

### 1.3 Local SQLite Database

#### Database Location Strategy

```
~/.claude-discovery/
├── index/
│   ├── skills.db              # Primary skill database (FTS5 enabled)
│   ├── embeddings.bin         # Vector embeddings for semantic search
│   └── sync_state.json        # Last sync timestamps, cursors
├── user/
│   ├── preferences.db         # User preferences, history
│   ├── progress.db            # Learning progress
│   └── telemetry_queue.db     # Opt-in telemetry buffer
├── cache/
│   ├── github_responses/      # Cached GitHub API responses
│   └── skill_details/         # Cached skill metadata
└── logs/
    └── claude-discovery.log   # Rotating log files
```

#### SQLite Configuration for Performance

```sql
-- Applied on database initialization
PRAGMA journal_mode = WAL;           -- Write-ahead logging for concurrency
PRAGMA synchronous = NORMAL;         -- Balance durability/performance
PRAGMA cache_size = -64000;          -- 64MB page cache
PRAGMA mmap_size = 268435456;        -- 256MB memory-mapped I/O
PRAGMA temp_store = MEMORY;          -- In-memory temp tables
PRAGMA foreign_keys = ON;            -- Referential integrity
```

### 1.4 Offline Operation Requirements

#### Offline Capability Matrix

| Feature | Offline Support | Requirements |
|---------|-----------------|--------------|
| Skill search | Full | Local index populated |
| Skill details | Partial | Cached if previously viewed |
| Recommendations | Full | Local codebase scan, local index |
| Quality scores | Full | Pre-computed in index |
| Installation | None | Requires GitHub/npm access |
| Learning exercises | Full | Exercises embedded in package |
| Telemetry | Queued | Synced when online |

#### Offline-First Architecture Principles

```
+------------------------------------------------------------------+
|  OFFLINE-FIRST DATA FLOW                                          |
+------------------------------------------------------------------+
|                                                                   |
|  1. LOCAL FIRST: Always check local storage before network        |
|                                                                   |
|     [Request] --> [Local Cache] --hit--> [Response]               |
|                         |                                         |
|                        miss                                       |
|                         v                                         |
|                   [Network Request]                               |
|                         |                                         |
|                   [Cache Response]                                |
|                         v                                         |
|                    [Response]                                     |
|                                                                   |
|  2. GRACEFUL DEGRADATION: Feature availability tiers              |
|                                                                   |
|     Full Offline: Search, Recommend, Learn, Audit                 |
|     Partial:      Skill Details (cached only)                     |
|     Online Only:  Install, Sync, Telemetry                        |
|                                                                   |
|  3. BACKGROUND SYNC: Queue changes, sync when possible            |
|                                                                   |
|     [Action] --> [Local DB] --> [Sync Queue] --> [Remote]         |
|                                                                   |
+------------------------------------------------------------------+
```

---

## 2. Distribution Strategy

### 2.1 npm Package Structure

#### Package Manifest (package.json)

```json
{
  "name": "@claude-discovery/hub",
  "version": "1.0.0",
  "description": "Claude Code skill discovery and activation system",
  "bin": {
    "claude-discovery": "./bin/claude-discovery"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "engines": {
    "node": ">=18.0.0"
  },
  "os": ["darwin", "linux", "win32"],
  "cpu": ["x64", "arm64"],
  "dependencies": {
    "better-sqlite3": "^9.0.0",
    "@anthropic-ai/mcp": "^1.0.0"
  },
  "optionalDependencies": {
    "better-sqlite3-darwin-arm64": "^9.0.0",
    "better-sqlite3-darwin-x64": "^9.0.0",
    "better-sqlite3-linux-x64": "^9.0.0",
    "better-sqlite3-win32-x64": "^9.0.0"
  },
  "scripts": {
    "postinstall": "node scripts/postinstall.js"
  }
}
```

#### Binary Distribution Strategy

```
Platform-Specific Binaries (optional dependencies):

darwin-arm64:  macOS Apple Silicon
darwin-x64:    macOS Intel
linux-x64:     Linux x86_64
linux-arm64:   Linux ARM64 (for cloud/containers)
win32-x64:     Windows x86_64

Fallback: Pure JS implementation with slower performance
```

### 2.2 Installation Flow

```
+===========================================================================+
|  INSTALLATION FLOW DIAGRAM                                                 |
+===========================================================================+

User runs: npm install -g @claude-discovery/hub

  +------------------+
  | npm fetch        |
  | package + deps   |
  +--------+---------+
           |
           v
  +------------------+
  | Extract package  |
  | to node_modules  |
  +--------+---------+
           |
           v
  +------------------+
  | postinstall.js   |
  | runs             |
  +--------+---------+
           |
           v
  +------------------+
  | Create           |
  | ~/.claude-       |
  | discovery/       |
  +--------+---------+
           |
           v
  +------------------+
  | Copy bootstrap   |
  | index (~25MB)    |
  +--------+---------+
           |
           v
  +------------------+
  | Verify SQLite    |
  | binary works     |
  +--------+---------+
           |
           v
  +------------------+
  | Register MCP     |
  | server with      |
  | Claude Code      |
  +--------+---------+
           |
           v
  +------------------+
  | Print success    |
  | message + next   |
  | steps            |
  +------------------+

Total time target: < 30 seconds on typical connection
```

#### Post-Install Script

```typescript
// scripts/postinstall.js
async function postinstall() {
  const homeDir = getDiscoveryHome();

  // Step 1: Create directory structure
  await ensureDirectories(homeDir);

  // Step 2: Copy bootstrap data if first install
  if (!await exists(path.join(homeDir, 'index/skills.db'))) {
    await copyBootstrapData(homeDir);
    console.log('Installed skill index with 50,000+ skills');
  }

  // Step 3: Verify native module
  try {
    require('better-sqlite3');
    console.log('SQLite native module verified');
  } catch (e) {
    console.warn('Native module unavailable, using fallback');
  }

  // Step 4: Suggest MCP registration
  console.log(`
To complete setup, add to Claude Code:

  claude-discovery register

Or manually add to ~/.config/claude/mcp_settings.json
  `);
}
```

### 2.3 Update Mechanism

#### Auto-Update Strategy

```
+===========================================================================+
|  UPDATE MECHANISM                                                          |
+===========================================================================+

  TWO-TIER UPDATE SYSTEM:

  1. INDEX UPDATES (Frequent, Automatic)
     +-----------------------------------------------------------------+
     | Frequency: Daily (default), hourly (configurable)               |
     | Size: Incremental delta (~100KB-5MB)                            |
     | Mechanism: Background sync server                               |
     | Fallback: Full index re-download (~25MB)                        |
     +-----------------------------------------------------------------+

  2. PACKAGE UPDATES (Infrequent, User-Initiated)
     +-----------------------------------------------------------------+
     | Frequency: Monthly releases, patches as needed                  |
     | Mechanism: npm update @claude-discovery/hub                     |
     | Notification: Check for updates on startup (opt-out)            |
     | Migration: Automatic schema migration on startup                |
     +-----------------------------------------------------------------+
```

#### Index Update Flow

```
+------------------+     +------------------+     +------------------+
| sync MCP server  | --> | Check CDN for    | --> | Compare versions |
| background task  |     | index manifest   |     | (ETag/timestamp) |
+------------------+     +------------------+     +---------+--------+
                                                           |
                              +----------------------------+
                              v
           +------------------+------------------+
           |                                     |
    No Update Needed                      Update Available
           |                                     |
           v                                     v
    +----------------+               +------------------+
    | Log "up to     |               | Download delta   |
    | date"          |               | or full index    |
    +----------------+               +--------+---------+
                                              |
                                              v
                                   +------------------+
                                   | Apply to local   |
                                   | SQLite database  |
                                   +--------+---------+
                                              |
                                              v
                                   +------------------+
                                   | Rebuild FTS5     |
                                   | index if needed  |
                                   +--------+---------+
                                              |
                                              v
                                   +------------------+
                                   | Verify integrity |
                                   | (checksum)       |
                                   +------------------+
```

---

## 3. Background Sync Infrastructure

### 3.1 Index Generation Pipeline

```
+===========================================================================+
|  INDEX GENERATION PIPELINE (GitHub Actions)                                |
+===========================================================================+

  DAILY SCHEDULED RUN (03:00 UTC)

  +------------------+
  | GitHub Actions   |
  | Trigger (cron)   |
  +--------+---------+
           |
           v
  +------------------+     +------------------+
  | Checkout index   | --> | Fetch GitHub API |
  | repository       |     | topic:mcp-server |
  +------------------+     | topic:claude-*   |
                           +--------+---------+
                                    |
                                    v
                           +------------------+
                           | Fetch external   |
                           | sources:         |
                           | - skillsmp.com   |
                           | - claude-plugins |
                           | - mcp.so         |
                           +--------+---------+
                                    |
                                    v
                           +------------------+
                           | Deduplicate and  |
                           | merge skill data |
                           +--------+---------+
                                    |
                                    v
                           +------------------+
                           | Compute quality  |
                           | scores           |
                           +--------+---------+
                                    |
                                    v
                           +------------------+
                           | Generate         |
                           | embeddings       |
                           | (if changed)     |
                           +--------+---------+
                                    |
                                    v
                           +------------------+
                           | Build SQLite     |
                           | database         |
                           +--------+---------+
                                    |
                                    v
                           +------------------+
                           | Generate delta   |
                           | patches          |
                           +--------+---------+
                                    |
                                    v
                           +------------------+
                           | Upload to CDN    |
                           | (GitHub Releases |
                           | + jsDelivr)      |
                           +--------+---------+
                                    |
                                    v
                           +------------------+
                           | Update manifest  |
                           | (version, hash)  |
                           +------------------+
```

### 3.2 GitHub Actions Workflow

```yaml
# .github/workflows/index-generation.yml
name: Generate Skill Index

on:
  schedule:
    - cron: '0 3 * * *'  # Daily at 03:00 UTC
  workflow_dispatch:      # Manual trigger

env:
  INDEX_REPO: claude-discovery/skill-index
  CDN_BUCKET: skill-index-cdn

jobs:
  generate-index:
    runs-on: ubuntu-latest
    timeout-minutes: 60

    steps:
      - name: Checkout index repository
        uses: actions/checkout@v4
        with:
          repository: ${{ env.INDEX_REPO }}
          token: ${{ secrets.INDEX_REPO_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Fetch GitHub skills
        run: npm run fetch:github
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_PAT }}

      - name: Fetch external sources
        run: npm run fetch:external
        env:
          FETCH_SKILLSMP: true
          FETCH_CLAUDE_PLUGINS: true
          FETCH_MCP_SO: true

      - name: Merge and deduplicate
        run: npm run merge

      - name: Compute quality scores
        run: npm run score

      - name: Generate embeddings
        run: npm run embeddings
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}  # For embedding generation

      - name: Build SQLite database
        run: npm run build:db

      - name: Generate delta patches
        run: npm run build:delta

      - name: Validate index
        run: npm run validate

      - name: Upload to GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          tag_name: index-${{ github.run_number }}
          files: |
            dist/skills.db
            dist/embeddings.bin
            dist/delta-*.patch
            dist/manifest.json
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Purge CDN cache
        run: |
          curl -X POST "https://purge.jsdelivr.net/gh/${INDEX_REPO}@latest"
```

### 3.3 CDN Distribution Architecture

```
+===========================================================================+
|  CDN DISTRIBUTION ARCHITECTURE                                             |
+===========================================================================+

  PRIMARY: GitHub Releases + jsDelivr CDN

  +------------------+
  | GitHub Release   |
  | index-v123       |
  | - skills.db      |
  | - embeddings.bin |
  | - manifest.json  |
  | - delta-*.patch  |
  +--------+---------+
           |
           v
  +------------------+     +------------------+
  | jsDelivr CDN     | --> | Edge Locations   |
  | (Free, fast,     |     | (200+ global)    |
  | GitHub native)   |     +------------------+
  +--------+---------+
           |
           v
  +------------------+
  | User Download    |
  | https://cdn.     |
  | jsdelivr.net/gh/ |
  | claude-discovery/|
  | skill-index@     |
  | latest/...       |
  +------------------+

  FALLBACK: GitHub Raw (slower, rate-limited)

  https://raw.githubusercontent.com/claude-discovery/skill-index/main/dist/...
```

#### CDN URL Structure

```
# Manifest (check for updates)
https://cdn.jsdelivr.net/gh/claude-discovery/skill-index@latest/manifest.json

# Full index download (initial install, recovery)
https://cdn.jsdelivr.net/gh/claude-discovery/skill-index@latest/skills.db
https://cdn.jsdelivr.net/gh/claude-discovery/skill-index@latest/embeddings.bin

# Delta patches (incremental updates)
https://cdn.jsdelivr.net/gh/claude-discovery/skill-index@latest/delta-v122-v123.patch

# Specific version (for reproducibility)
https://cdn.jsdelivr.net/gh/claude-discovery/skill-index@index-123/skills.db
```

### 3.4 Index Manifest Schema

```json
{
  "version": "1.2.3",
  "build_number": 456,
  "build_timestamp": "2025-12-26T03:45:00Z",
  "files": {
    "skills.db": {
      "size_bytes": 26214400,
      "sha256": "abc123...",
      "url": "https://cdn.jsdelivr.net/.../skills.db"
    },
    "embeddings.bin": {
      "size_bytes": 20971520,
      "sha256": "def456...",
      "url": "https://cdn.jsdelivr.net/.../embeddings.bin"
    }
  },
  "delta_from": {
    "1.2.2": {
      "size_bytes": 524288,
      "sha256": "ghi789...",
      "url": "https://cdn.jsdelivr.net/.../delta-v122-v123.patch"
    }
  },
  "stats": {
    "total_skills": 52341,
    "sources": {
      "github": 25000,
      "skillsmp": 15000,
      "claude_plugins": 8412,
      "mcp_so": 17237
    },
    "updated_skills": 234,
    "new_skills": 45,
    "removed_skills": 12
  }
}
```

---

## 4. Web Infrastructure

### 4.1 Static Site Hosting Options Analysis

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| **GitHub Pages** | Free, GitHub-native, simple | Limited customization, no edge functions | Phase 1 (MVP) |
| **Vercel** | Fast, preview deployments, analytics | Costs at scale | Phase 2+ |
| **Netlify** | Similar to Vercel, good forms | Slightly less performant | Alternative |
| **Cloudflare Pages** | Fastest, free tier generous | Less mature | Future option |

**Recommendation:** Start with GitHub Pages, migrate to Vercel at Phase 2.

### 4.2 Web Architecture Diagram

```
+===========================================================================+
|  WEB INFRASTRUCTURE (discoveries.dev)                                      |
+===========================================================================+

  PHASE 1: GitHub Pages (Simple, Free)

  +------------------+     +------------------+
  | Astro Static     | --> | GitHub Pages     |
  | Site Generator   |     | (Free Hosting)   |
  +------------------+     +--------+---------+
                                    |
                                    v
                           +------------------+
                           | Custom Domain    |
                           | discoveries.dev  |
                           | (Cloudflare DNS) |
                           +------------------+

  PHASE 2+: Vercel (Advanced Features)

  +------------------+     +------------------+     +------------------+
  | Astro/Next.js    | --> | Vercel           | --> | Edge Network     |
  | Framework        |     | (Build + Deploy) |     | (100+ locations) |
  +------------------+     +--------+---------+     +------------------+
                                    |
                                    v
                           +------------------+
                           | Vercel Analytics |
                           | + Speed Insights |
                           +------------------+
                                    |
                                    v
                           +------------------+
                           | Edge Functions   |
                           | (API Routes)     |
                           +------------------+
```

### 4.3 CDN Configuration

```
+===========================================================================+
|  CDN CONFIGURATION                                                         |
+===========================================================================+

  Cloudflare (DNS + CDN for assets)

  discoveries.dev
  ├── /                    → Vercel (HTML, dynamic)
  ├── /assets/*            → Cloudflare Cache (aggressive, 1 year)
  ├── /api/*               → Vercel Edge Functions
  └── /_next/*             → Vercel (immutable, long cache)

  Cache-Control Headers:
  ┌──────────────────┬────────────────────────────────┐
  │ Path Pattern     │ Cache-Control                  │
  ├──────────────────┼────────────────────────────────┤
  │ /*.html          │ public, max-age=0, s-maxage=60 │
  │ /assets/*        │ public, max-age=31536000       │
  │ /_next/static/*  │ public, max-age=31536000       │
  │ /api/*           │ no-cache                       │
  │ /skill/*         │ public, max-age=3600           │
  └──────────────────┴────────────────────────────────┘
```

### 4.4 Domain and SSL Configuration

```
Domain Structure:
├── discoveries.dev                 # Main web app
├── cdn.discoveries.dev             # Static assets (optional, Cloudflare)
├── api.discoveries.dev             # API endpoints (Vercel Edge)
└── @<username>.discoveries.dev     # Public profiles (Phase 4)

SSL/TLS:
├── Provider: Cloudflare (free) or Let's Encrypt (via Vercel)
├── Protocol: TLS 1.3 minimum
├── HSTS: max-age=31536000; includeSubDomains; preload
└── Certificate: Wildcard for *.discoveries.dev

DNS Configuration (Cloudflare):
┌──────────────────┬────────┬──────────────────────────────┐
│ Record           │ Type   │ Value                        │
├──────────────────┼────────┼──────────────────────────────┤
│ discoveries.dev  │ A      │ 76.76.21.21 (Vercel)         │
│ www              │ CNAME  │ cname.vercel-dns.com         │
│ cdn              │ CNAME  │ discoveries.dev.cdn.cloudflare.net │
└──────────────────┴────────┴──────────────────────────────┘
```

---

## 5. Monitoring and Observability

### 5.1 Monitoring Architecture

```
+===========================================================================+
|  OBSERVABILITY ARCHITECTURE                                                |
+===========================================================================+

  ┌────────────────────────────────────────────────────────────────────┐
  │                       USER'S LOCAL MACHINE                          │
  │                                                                      │
  │  +----------------+     +----------------+     +----------------+    │
  │  | MCP Servers    | --> | Local Logs     | --> | Opt-in         |   │
  │  | (Structured    |     | (~/.claude-    |     | Telemetry      |   │
  │  |  Logging)      |     |  discovery/    |     | Queue          |   │
  │  +----------------+     |  logs/)        |     +--------+-------+   │
  │                         +----------------+              |           │
  └─────────────────────────────────────────────────────────|───────────┘
                                                            |
                                                   (If opt-in enabled)
                                                            |
                                                            v
  ┌────────────────────────────────────────────────────────────────────┐
  │                       CLOUD SERVICES                                │
  │                                                                      │
  │  +----------------+     +----------------+     +----------------+    │
  │  | Telemetry      | --> | Analytics      | --> | Dashboards     |   │
  │  | Collector      |     | (PostHog or    |     | (Grafana/      |   │
  │  | (Edge Fn)      |     |  Plausible)    |     |  Custom)       |   │
  │  +----------------+     +----------------+     +----------------+    │
  │                                                                      │
  │  +----------------+     +----------------+                          │
  │  | Error Tracking | --> | Alerts         |                          │
  │  | (Sentry)       |     | (PagerDuty/    |                          │
  │  | (Opt-in only)  |     |  Discord)      |                          │
  │  +----------------+     +----------------+                          │
  │                                                                      │
  └────────────────────────────────────────────────────────────────────┘
```

### 5.2 Error Tracking (Opt-In)

#### Privacy-First Error Tracking Design

```typescript
interface ErrorReport {
  // Collected (non-PII)
  error_type: string;           // e.g., "YAML_PARSE_ERROR"
  error_message: string;        // Sanitized, no paths
  component: string;            // e.g., "discovery-core"
  operation: string;            // e.g., "install"
  stack_trace?: string;         // Sanitized, no local paths

  // System info (anonymized)
  platform: 'darwin' | 'linux' | 'win32';
  arch: 'x64' | 'arm64';
  node_version: string;
  package_version: string;

  // Context (minimal)
  skill_id?: string;            // Only if relevant
  search_query?: string;        // Only if relevant (hashed)

  // NOT collected
  // - File paths
  // - User identifiers
  // - IP addresses (stripped at edge)
  // - Codebase contents
  // - Personal data
}
```

#### Opt-In Flow

```
+------------------+
| First run or     |
| explicit prompt  |
+--------+---------+
         |
         v
+------------------+
| "Help improve    |
| Discovery Hub?   |
| Send anonymous   |
| error reports"   |
+--------+---------+
         |
    +----+----+
    |         |
  [Yes]      [No]
    |         |
    v         v
+--------+ +--------+
| Enable | | Store  |
| error  | | pref   |
| tracking| | (off)  |
+--------+ +--------+
```

### 5.3 Usage Analytics (Opt-Out)

#### Telemetry Data Model

```typescript
interface TelemetryEvent {
  // Event identification
  event_type: 'search' | 'install' | 'recommend' | 'learn';
  timestamp: string;
  session_id: string;           // Random per-session, not persistent

  // Aggregatable metrics
  search_result_count?: number;
  install_success?: boolean;
  recommendation_shown_count?: number;
  recommendation_clicked?: boolean;

  // Performance
  latency_ms: number;
  cache_hit: boolean;

  // NOT collected
  // - Search queries (only result counts)
  // - Skill names (only aggregate category)
  // - User paths
  // - Personal identifiers
}
```

#### Value Proposition for Opt-Out

```
+------------------------------------------------------------------+
|  WHY TELEMETRY MATTERS                                            |
+------------------------------------------------------------------+
|                                                                   |
|  "Telemetry helps us:"                                            |
|                                                                   |
|  1. Identify which skills are most popular                        |
|     → Better recommendations for everyone                         |
|                                                                   |
|  2. Find performance bottlenecks                                  |
|     → Faster search, quicker startup                              |
|                                                                   |
|  3. Detect broken skills before you report them                   |
|     → Fewer activation failures                                   |
|                                                                   |
|  4. Prioritize features by actual usage                           |
|     → Development focused on what matters                         |
|                                                                   |
|  "You can opt out anytime: claude-discovery config --no-telemetry"|
|                                                                   |
+------------------------------------------------------------------+
```

### 5.4 Health Checks

#### Local Health Check (CLI)

```bash
$ claude-discovery health

Health Check Results:
=====================

Database:
  ✓ SQLite connection: OK
  ✓ Index version: 1.2.3 (up to date)
  ✓ Skill count: 52,341
  ✓ FTS5 index: Valid

MCP Server:
  ✓ discovery-core: Running (PID 12345)
  ✓ learning: Running (PID 12346)
  ✓ sync: Running (PID 12347)

External Services:
  ✓ GitHub API: Reachable (4,521 requests remaining)
  ✓ CDN: Reachable (latency: 45ms)
  ⚠ skillsmp.com: Slow (latency: 1,234ms)

Performance:
  ✓ Last search latency: 145ms (target: <500ms)
  ✓ Memory usage: 287MB (target: <500MB)
  ✓ Startup time: 2.3s (target: <5s)

Overall: HEALTHY (1 warning)
```

#### Health Check Implementation

```typescript
interface HealthCheckResult {
  component: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency_ms?: number;
  message?: string;
  details?: Record<string, any>;
}

async function runHealthChecks(): Promise<HealthReport> {
  const checks = await Promise.allSettled([
    checkDatabase(),
    checkMCPServers(),
    checkExternalServices(),
    checkPerformance(),
  ]);

  return {
    timestamp: new Date().toISOString(),
    overall: deriveOverallStatus(checks),
    checks: checks.map(formatResult),
  };
}
```

---

## 6. CI/CD Pipeline

### 6.1 Pipeline Overview

```
+===========================================================================+
|  CI/CD PIPELINE OVERVIEW                                                   |
+===========================================================================+

  ┌──────────────────────────────────────────────────────────────────────┐
  │  PULL REQUEST                                                         │
  │                                                                        │
  │  [Commit] → [Lint] → [Type Check] → [Unit Tests] → [Integration] → [PR Check]
  │                                                                        │
  └──────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ Merge to main
                                      ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  MAIN BRANCH                                                          │
  │                                                                        │
  │  [Build] → [Test (Full)] → [Build Package] → [Publish to npm (beta)]  │
  │                                                                        │
  └──────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ Tag release
                                      ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  RELEASE                                                              │
  │                                                                        │
  │  [Build] → [Test] → [Package] → [Sign] → [npm publish] → [GitHub Release]
  │                           │                       │
  │                           ▼                       ▼
  │                    [Update Changelog]      [Notify Channels]
  │                                                                        │
  └──────────────────────────────────────────────────────────────────────┘
```

### 6.2 GitHub Actions Workflows

#### PR Validation Workflow

```yaml
# .github/workflows/pr.yml
name: PR Validation

on:
  pull_request:
    branches: [main, develop]

jobs:
  validate:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20, 22]
        os: [ubuntu-latest, macos-latest, windows-latest]

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js ${{ matrix.node }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Type check
        run: npm run typecheck

      - name: Unit tests
        run: npm run test:unit

      - name: Integration tests
        run: npm run test:integration
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Build
        run: npm run build

      - name: Package size check
        run: |
          SIZE=$(du -sh dist/ | cut -f1)
          echo "Package size: $SIZE"
          # Fail if over 50MB
          npm run check:size

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: npm audit
        run: npm audit --audit-level=high

      - name: CodeQL Analysis
        uses: github/codeql-action/analyze@v3
```

#### Release Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Test
        run: npm test

      - name: Build all platforms
        run: npm run build:all-platforms

      - name: Publish to npm
        run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          generate_release_notes: true
          files: |
            dist/*.tgz
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Announce release
        uses: sarisia/actions-status-discord@v1
        with:
          webhook: ${{ secrets.DISCORD_WEBHOOK }}
          title: "Claude Discovery Hub ${{ github.ref_name }} Released"
          description: "New version available: npm install -g @claude-discovery/hub"
```

### 6.3 Release Process

```
+===========================================================================+
|  RELEASE PROCESS                                                           |
+===========================================================================+

  VERSIONING: Semantic Versioning (semver)

  Major.Minor.Patch
    │     │     │
    │     │     └── Bug fixes, security patches
    │     └──────── New features, backward compatible
    └────────────── Breaking changes

  RELEASE CADENCE:
  ┌────────────────┬──────────────┬────────────────────────┐
  │ Type           │ Frequency    │ Process                │
  ├────────────────┼──────────────┼────────────────────────┤
  │ Patch          │ As needed    │ Automated from hotfix  │
  │ Minor          │ Bi-weekly    │ Feature branch merge   │
  │ Major          │ Quarterly    │ Manual with migration  │
  └────────────────┴──────────────┴────────────────────────┘

  RELEASE CHECKLIST:

  [ ] All tests passing
  [ ] Changelog updated
  [ ] Migration guide (if breaking)
  [ ] Documentation updated
  [ ] npm audit clean
  [ ] Performance benchmarks pass
  [ ] Beta testing complete (major only)
  [ ] Rollback plan documented
```

### 6.4 Version Management

```
Branch Strategy:

main          ──●────●────●────●────●──────────────────────
               │    │    │    │    │
develop       ─●──●─●──●─●──●─●──●─●──●──●──●──●──●──●──●──
               \  /   \  /   \  /   \  /   \  /
feature/*      ●──●   ●──●   ●──●   ●──●   ●──●
                              │
hotfix/*                      ●──● (cherry-picked to main)

Tagging:
- v1.0.0          Stable release
- v1.1.0-beta.1   Beta release
- v1.1.0-rc.1     Release candidate
- index-456       Index build number

npm Tags:
- latest          Current stable
- beta            Next version testing
- next            Bleeding edge
```

---

## 7. Performance Targets

### 7.1 Performance Budget

```
+===========================================================================+
|  PERFORMANCE TARGETS AND BUDGETS                                           |
+===========================================================================+

  MCP SERVER PERFORMANCE:
  ┌────────────────────────┬──────────┬──────────┬──────────────────────┐
  │ Metric                 │ Target   │ Max      │ Measurement          │
  ├────────────────────────┼──────────┼──────────┼──────────────────────┤
  │ Total startup time     │ < 3s     │ 5s       │ Cold start to ready  │
  │ Discovery-core startup │ < 1.5s   │ 2s       │ Module load + init   │
  │ Learning startup       │ < 0.5s   │ 1s       │ Module load + init   │
  │ Sync startup           │ < 0.5s   │ 1s       │ Module load + init   │
  └────────────────────────┴──────────┴──────────┴──────────────────────┘

  MEMORY BUDGETS:
  ┌────────────────────────┬──────────┬──────────┬──────────────────────┐
  │ Component              │ Idle     │ Active   │ Notes                │
  ├────────────────────────┼──────────┼──────────┼──────────────────────┤
  │ Discovery-core         │ 150MB    │ 250MB    │ Includes SQLite      │
  │ Learning               │ 50MB     │ 100MB    │ Exercise loading     │
  │ Sync                   │ 100MB    │ 150MB    │ Index operations     │
  │ TOTAL                  │ 300MB    │ 500MB    │ 8GB machine safe     │
  └────────────────────────┴──────────┴──────────┴──────────────────────┘

  LATENCY TARGETS:
  ┌────────────────────────┬──────────┬──────────┬──────────────────────┐
  │ Operation              │ P50      │ P95      │ P99                  │
  ├────────────────────────┼──────────┼──────────┼──────────────────────┤
  │ Search (cached)        │ 100ms    │ 200ms    │ 400ms                │
  │ Search (uncached)      │ 200ms    │ 500ms    │ 800ms                │
  │ Codebase scan (1K)     │ 5s       │ 15s      │ 30s                  │
  │ Codebase scan (10K)    │ 15s      │ 30s      │ 60s                  │
  │ Embedding search       │ 50ms     │ 100ms    │ 200ms                │
  │ Install (skill fetch)  │ 500ms    │ 2s       │ 5s                   │
  │ Index sync (delta)     │ 10s      │ 60s      │ 5min                 │
  └────────────────────────┴──────────┴──────────┴──────────────────────┘
```

### 7.2 Performance Monitoring

```typescript
interface PerformanceMetrics {
  // Startup metrics
  startup: {
    total_ms: number;
    discovery_core_ms: number;
    learning_ms: number;
    sync_ms: number;
    db_init_ms: number;
    embeddings_load_ms: number;  // Lazy, may be 0
  };

  // Runtime metrics (rolling 5-minute window)
  runtime: {
    search_latency_p50_ms: number;
    search_latency_p95_ms: number;
    cache_hit_rate: number;
    memory_rss_bytes: number;
    memory_heap_used_bytes: number;
  };

  // Operation counts (since startup)
  operations: {
    searches: number;
    installs: number;
    recommendations: number;
    errors: number;
  };
}
```

### 7.3 Performance Optimization Strategies

```
+===========================================================================+
|  OPTIMIZATION STRATEGIES                                                   |
+===========================================================================+

  1. LAZY LOADING
     ─────────────
     - Embeddings loaded on first semantic search (saves 1-2s startup)
     - Learning exercises loaded on demand
     - GitHub API connections pooled and reused

  2. CACHING HIERARCHY
     ──────────────────
     ┌─────────────────┐
     │ Memory Cache    │ ← Hot data (LRU, 100MB max)
     │ (in-process)    │
     ├─────────────────┤
     │ SQLite Cache    │ ← Warm data (TTL-based)
     │ (disk, WAL)     │
     ├─────────────────┤
     │ HTTP Cache      │ ← Cold data (ETag, If-Modified-Since)
     │ (CDN/GitHub)    │
     └─────────────────┘

  3. PARALLEL INITIALIZATION
     ────────────────────────
     - MCP servers start in parallel
     - DB connections opened async
     - Health checks run background

  4. INCREMENTAL PROCESSING
     ───────────────────────
     - Index updates via delta patches
     - Codebase scans use file hashing for change detection
     - Embeddings computed incrementally for new skills only
```

---

## 8. Cost Analysis

### 8.1 Infrastructure Costs

```
+===========================================================================+
|  MONTHLY COST BREAKDOWN (Estimated)                                        |
+===========================================================================+

  PHASE 1 (MVP): ~$0/month
  ┌────────────────────────┬──────────────────────────────────────────────┐
  │ Component              │ Cost / Notes                                 │
  ├────────────────────────┼──────────────────────────────────────────────┤
  │ GitHub Pages hosting   │ $0 (Free tier)                               │
  │ GitHub Actions CI      │ $0 (2,000 min/month free)                    │
  │ jsDelivr CDN           │ $0 (Free for open source)                    │
  │ Domain (discoveries.dev)│ ~$12/year ≈ $1/month                        │
  │ Cloudflare DNS         │ $0 (Free tier)                               │
  ├────────────────────────┼──────────────────────────────────────────────┤
  │ TOTAL PHASE 1          │ ~$1/month                                    │
  └────────────────────────┴──────────────────────────────────────────────┘

  PHASE 2+ (Growth): ~$50-150/month
  ┌────────────────────────┬──────────────────────────────────────────────┐
  │ Component              │ Cost / Notes                                 │
  ├────────────────────────┼──────────────────────────────────────────────┤
  │ Vercel Pro             │ $20/month (needed for team, analytics)       │
  │ GitHub Actions         │ $0-50 (may exceed free tier)                 │
  │ PostHog (analytics)    │ $0 (1M events/month free)                    │
  │ Sentry (errors)        │ $0 (5K errors/month free)                    │
  │ Domain + DNS           │ $1/month                                     │
  │ OpenAI API (embeddings)│ $20-50/month (embedding generation)          │
  ├────────────────────────┼──────────────────────────────────────────────┤
  │ TOTAL PHASE 2+         │ $50-150/month                                │
  └────────────────────────┴──────────────────────────────────────────────┘

  SCALE (5,000+ WAU): ~$200-500/month
  ┌────────────────────────┬──────────────────────────────────────────────┐
  │ Component              │ Cost / Notes                                 │
  ├────────────────────────┼──────────────────────────────────────────────┤
  │ Vercel Pro             │ $20/month                                    │
  │ Vercel usage overage   │ $50-100/month (bandwidth)                    │
  │ GitHub Actions         │ $50-100/month                                │
  │ PostHog Growth         │ $0-50/month (if exceeding free tier)         │
  │ Sentry Team            │ $26/month                                    │
  │ OpenAI API             │ $50-100/month                                │
  │ PagerDuty (optional)   │ $0 (free tier) - $25/month                   │
  ├────────────────────────┼──────────────────────────────────────────────┤
  │ TOTAL SCALE            │ $200-500/month                               │
  └────────────────────────┴──────────────────────────────────────────────┘
```

### 8.2 Cost Optimization Strategies

```
1. AGGRESSIVE CACHING
   - Cache everything at CDN edge
   - Use stale-while-revalidate patterns
   - Local caching in npm package

2. EFFICIENT INDEX GENERATION
   - Delta patches vs full rebuilds (90% size reduction)
   - Incremental embedding generation
   - GitHub Events API vs polling

3. FREE TIER MAXIMIZATION
   - jsDelivr for CDN (free for open source)
   - GitHub Actions (2,000 min/month free)
   - Cloudflare for DNS (free tier)
   - PostHog/Plausible free tiers

4. ON-DEMAND RESOURCES
   - No always-on servers (serverless/edge only)
   - Scheduled Actions (not continuous)
   - Lazy loading reduces compute
```

---

## 9. Security Considerations

### 9.1 Supply Chain Security

```
+===========================================================================+
|  SUPPLY CHAIN SECURITY                                                     |
+===========================================================================+

  NPM PACKAGE SECURITY:
  ┌────────────────────────────────────────────────────────────────────────┐
  │ ✓ npm provenance attestation (verifiable build origin)                 │
  │ ✓ Package signing with npm publish --provenance                        │
  │ ✓ Lock file committed (package-lock.json)                              │
  │ ✓ Dependabot for automated updates                                     │
  │ ✓ npm audit in CI (fail on high severity)                              │
  │ ✓ CodeQL static analysis                                               │
  └────────────────────────────────────────────────────────────────────────┘

  SKILL INDEX SECURITY:
  ┌────────────────────────────────────────────────────────────────────────┐
  │ ✓ SHA-256 checksums in manifest                                        │
  │ ✓ Manifest signed (GPG or Sigstore)                                    │
  │ ✓ Version pinning for downloads                                        │
  │ ✓ Rollback capability (previous versions retained)                     │
  │ ✓ Tamper detection on local database                                   │
  └────────────────────────────────────────────────────────────────────────┘
```

### 9.2 Data Security

```
LOCAL DATA PROTECTION:
├── SQLite databases are not encrypted (user responsibility)
├── Sensitive config can use system keychain (optional)
├── No credentials stored in plain text
├── Telemetry queue encrypted at rest
└── Log files contain no PII

TRANSPORT SECURITY:
├── HTTPS only for all external requests
├── TLS 1.3 minimum
├── Certificate pinning for critical endpoints (optional)
└── No HTTP fallback
```

### 9.3 Access Control

```
GITHUB ACTIONS SECRETS:
┌────────────────────────┬─────────────────────────────────────────────────┐
│ Secret                 │ Purpose                                         │
├────────────────────────┼─────────────────────────────────────────────────┤
│ NPM_TOKEN              │ Publish to npm registry                         │
│ GITHUB_PAT             │ Cross-repo access for index generation          │
│ OPENAI_API_KEY         │ Embedding generation (index pipeline only)      │
│ DISCORD_WEBHOOK        │ Release announcements                           │
│ SENTRY_DSN             │ Error tracking (web only)                       │
└────────────────────────┴─────────────────────────────────────────────────┘

ROTATION SCHEDULE:
├── NPM_TOKEN: Annual or on team change
├── GITHUB_PAT: Quarterly
├── API keys: Annual
└── Webhooks: On compromise suspicion
```

---

## 10. Disaster Recovery

### 10.1 Recovery Scenarios

```
+===========================================================================+
|  DISASTER RECOVERY SCENARIOS                                               |
+===========================================================================+

  SCENARIO 1: npm Package Compromised
  ───────────────────────────────────
  Detection: User reports, automated monitoring
  Response:
    1. npm unpublish affected version (if <72h)
    2. Publish patched version
    3. Notify users via GitHub, Discord, Twitter
    4. Rotate all secrets
  RTO: 1 hour
  RPO: N/A (no data loss, package is rebuilt)

  SCENARIO 2: Index Corruption
  ────────────────────────────
  Detection: Checksum mismatch, user reports
  Response:
    1. Rollback to previous index version
    2. Regenerate index from sources
    3. Push corrected version
  RTO: 30 minutes (rollback), 2 hours (regenerate)
  RPO: 24 hours (daily index builds)

  SCENARIO 3: CDN Outage
  ──────────────────────
  Detection: Health checks, user reports
  Response:
    1. Failover to GitHub raw URLs (automatic)
    2. Monitor CDN recovery
  RTO: Automatic (fallback built-in)
  RPO: N/A

  SCENARIO 4: GitHub Outage
  ─────────────────────────
  Detection: API errors, status.github.com
  Response:
    1. Graceful degradation (use cached data)
    2. Queue sync operations
    3. Resume when available
  RTO: Automatic degradation
  RPO: N/A (local-first architecture)
```

### 10.2 Backup Strategy

```
WHAT IS BACKED UP:
┌────────────────────────┬─────────────────┬────────────────────────────┐
│ Data                   │ Frequency       │ Retention                  │
├────────────────────────┼─────────────────┼────────────────────────────┤
│ Skill index            │ Daily builds    │ 30 days (GitHub Releases)  │
│ User data (local)      │ User managed    │ User managed               │
│ Web analytics          │ Continuous      │ Per provider policy        │
│ CI/CD config           │ Git-versioned   │ Forever                    │
└────────────────────────┴─────────────────┴────────────────────────────┘

WHAT IS NOT BACKED UP (by design):
├── User telemetry (aggregated only, no raw backup)
├── Temporary caches
├── Log files older than 7 days
└── Local user databases (user responsibility)
```

### 10.3 Rollback Procedures

```
NPM PACKAGE ROLLBACK:

  # Users can install previous version
  npm install -g @claude-discovery/hub@1.2.2

  # We can deprecate bad version
  npm deprecate @claude-discovery/hub@1.2.3 "Known issue, use 1.2.2"

INDEX ROLLBACK:

  # Automatic: Update manifest to point to previous version
  # Manual: User can force specific version
  claude-discovery config set index.version 1.2.2
  claude-discovery sync --force

WEB ROLLBACK:

  # Vercel: Instant rollback to previous deployment
  vercel rollback

  # GitHub Pages: Revert commit
  git revert HEAD && git push
```

---

## Summary and Recommendations

### Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Package distribution | npm | Native to Node.js ecosystem, easy updates |
| Database | SQLite (embedded) | Zero dependencies, offline-first, portable |
| Index distribution | GitHub Releases + jsDelivr | Free, reliable, global CDN |
| Web hosting | GitHub Pages (MVP), Vercel (Growth) | Progressive complexity |
| Monitoring | Opt-in error tracking, opt-out analytics | Privacy-first with clear value proposition |
| CI/CD | GitHub Actions | Native integration, generous free tier |

### Phase Implementation Roadmap

| Phase | Infrastructure Focus | Key Deliverables |
|-------|---------------------|------------------|
| Phase 0 | POC setup | Basic npm package, manual index |
| Phase 1 | MVP infrastructure | Automated index pipeline, GitHub Pages |
| Phase 2 | Growth infrastructure | Vercel migration, VS Code extension publishing |
| Phase 3 | Reliability | Error tracking, performance monitoring |
| Phase 4 | Scale | CDN optimization, cost management |

### Critical Success Factors

1. **Startup performance must be <5 seconds** - Users will abandon if Claude Code slows down
2. **Offline operation is mandatory** - Local-first is not optional
3. **Zero-cost MVP** - Sustainability requires minimal infrastructure
4. **Privacy by default** - Earn trust before asking for telemetry

---

## Related Documentation

- [Technical Overview](../technical/overview.md) - System architecture
- [Performance Requirements](../technical/performance.md) - Detailed performance specs
- [Observability](../technical/observability.md) - Logging and monitoring
- [Sync Strategy](../technical/data/sync-strategy.md) - Data synchronization
- [Security Index](../technical/security/index.md) - Security architecture

---

*Document History:*
- v1.0 (December 26, 2025): Initial infrastructure architecture design
