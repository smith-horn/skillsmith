# Infrastructure & DevOps Implementation Plan

**Project:** Skillsmith
**Domain:** Infrastructure & DevOps
**Owner:** DevOps Specialist
**Date:** December 26, 2025
**Status:** Planned

---

## Executive Summary

This document provides the comprehensive implementation plan for Skillsmith infrastructure, covering npm package distribution, CI/CD pipelines, index generation, and monitoring for Phases 0-2.

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Package Distribution | npm | Standard Node.js ecosystem |
| CI/CD Platform | GitHub Actions | Native integration, free tier |
| Index CDN | jsDelivr | Free, GitHub-native, global edge |
| Web Hosting Phase 1 | GitHub Pages | Free, simple, sufficient for MVP |
| Web Hosting Phase 2+ | Vercel | Analytics, edge functions, speed |
| Monitoring | PostHog (opt-in) | Privacy-first, generous free tier |

### Cost Projections

| Phase | Monthly Cost | Components |
|-------|--------------|------------|
| Phase 0-1 (MVP) | ~$1 | GitHub Pages, free tiers |
| Phase 2 (Growth) | ~$50-150 | Vercel Pro, analytics |
| Scale (5K+ WAU) | ~$200-500 | Usage overage, monitoring |

---

## Phase 0: Foundation Sprint (Weeks 1-8)

### Epic INFRA-001: NPM Package Distribution

**Description:** Create and publish the npm package with all MCP servers, bootstrap index, and CLI tools.

**Business Value:** Enables one-command installation for all users.

**Dependencies:** None (foundational)

**Definition of Done:**
- [ ] Package publishes to npm successfully
- [ ] Post-install script creates ~/.skillsmith/
- [ ] Bootstrap index (~5MB) downloaded on first run
- [ ] MCP server registration instructions provided
- [ ] Works on macOS, Linux, Windows

---

#### Story INFRA-001-01: Package Structure and Build

**As a** user
**I want** to install with a single command
**So that** setup is frictionless

**Acceptance Criteria:**
- [ ] `npm install -g skillsmith` works
- [ ] Package size < 50MB (excluding bootstrap)
- [ ] Works on Node.js 18, 20, 22
- [ ] Platform-specific binaries for SQLite

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| INFRA-001-01-T1 | Create package.json with bin entries | 2h | P0 |
| INFRA-001-01-T2 | Configure TypeScript build | 3h | P0 |
| INFRA-001-01-T3 | Set up better-sqlite3 optional deps | 4h | P0 |
| INFRA-001-01-T4 | Create rollup/esbuild config | 4h | P0 |
| INFRA-001-01-T5 | Test on all target platforms | 4h | P0 |

**Code Pattern - Package.json:**

```json
{
  "name": "skillsmith",
  "version": "1.0.0",
  "description": "Claude Code skill discovery and activation system",
  "bin": {
    "skillsmith": "./bin/skillsmith"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "engines": {
    "node": ">=18.0.0"
  },
  "os": ["darwin", "linux", "win32"],
  "cpu": ["x64", "arm64"],
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "postinstall": "node scripts/postinstall.js"
  },
  "dependencies": {
    "@anthropic-ai/mcp": "^1.0.0"
  },
  "optionalDependencies": {
    "better-sqlite3": "^9.0.0"
  }
}
```

---

#### Story INFRA-001-02: Post-Install Bootstrap

**As a** new user
**I want** data directories created automatically
**So that** I can start using immediately

**Acceptance Criteria:**
- [ ] ~/.skillsmith/ created with proper structure
- [ ] Bootstrap index downloaded (5MB)
- [ ] Failure gracefully handled with instructions
- [ ] Idempotent (safe to run multiple times)

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| INFRA-001-02-T1 | Create directory structure script | 2h | P0 |
| INFRA-001-02-T2 | Implement bootstrap download with retry | 3h | P0 |
| INFRA-001-02-T3 | Add checksum verification | 2h | P0 |
| INFRA-001-02-T4 | Print setup instructions | 1h | P0 |
| INFRA-001-02-T5 | Handle CI/Docker environments | 2h | P1 |

**Code Pattern - Post-Install Script:**

```javascript
// scripts/postinstall.js
const { mkdirSync, existsSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');
const https = require('https');

const SKILLSMITH_HOME = join(homedir(), '.skillsmith');
const BOOTSTRAP_URL = 'https://cdn.jsdelivr.net/gh/skillsmith-dev/skill-index@latest/bootstrap.db';

async function postinstall() {
  // Create directory structure
  const dirs = ['index', 'user', 'cache', 'config', 'logs'];
  for (const dir of dirs) {
    const path = join(SKILLSMITH_HOME, dir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }

  // Download bootstrap index if missing
  const indexPath = join(SKILLSMITH_HOME, 'index', 'skills.db');
  if (!existsSync(indexPath)) {
    console.log('Downloading skill index...');
    await downloadFile(BOOTSTRAP_URL, indexPath);
    console.log('Skill index installed (50,000+ skills)');
  }

  // Print next steps
  console.log(`
Setup complete!

To register with Claude Code, run:
  skillsmith register

Or add to ~/.config/claude/mcp_settings.json:
  ${JSON.stringify({
    servers: {
      'skillsmith': {
        command: 'npx',
        args: ['skillsmith', 'mcp-server']
      }
    }
  }, null, 2)}
  `);
}

postinstall().catch(console.error);
```

---

### Epic INFRA-002: CI/CD Pipeline

**Description:** Set up GitHub Actions for testing, building, and publishing.

**Business Value:** Ensures quality and enables automated releases.

**Dependencies:** INFRA-001 (Package Structure)

**Definition of Done:**
- [ ] PR validation runs on all PRs
- [ ] Main branch deploys to npm (beta tag)
- [ ] Tagged releases publish to npm (latest)
- [ ] Matrix testing across Node versions and platforms

---

#### Story INFRA-002-01: PR Validation Workflow

**As a** contributor
**I want** PRs validated automatically
**So that** code quality is maintained

**Acceptance Criteria:**
- [ ] Lint, typecheck, and tests run on every PR
- [ ] Tests run on Node 18, 20, 22
- [ ] Tests run on ubuntu, macos, windows
- [ ] Package size checked against budget

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| INFRA-002-01-T1 | Create pr.yml workflow | 3h | P0 |
| INFRA-002-01-T2 | Configure matrix testing | 2h | P0 |
| INFRA-002-01-T3 | Add package size check | 1h | P1 |
| INFRA-002-01-T4 | Set up CodeQL security scan | 2h | P0 |
| INFRA-002-01-T5 | Configure test coverage reporting | 2h | P1 |

**Code Pattern - PR Workflow:**

```yaml
# .github/workflows/pr.yml
name: PR Validation

on:
  pull_request:
    branches: [main, develop]

jobs:
  validate:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        node: [18, 20, 22]
        os: [ubuntu-latest, macos-latest, windows-latest]
      fail-fast: false

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js ${{ matrix.node }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: 'npm'

      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build

      - name: Check package size
        run: |
          SIZE=$(du -sm dist/ | cut -f1)
          if [ "$SIZE" -gt 50 ]; then
            echo "Package too large: ${SIZE}MB > 50MB"
            exit 1
          fi

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm audit --audit-level=high
      - uses: github/codeql-action/analyze@v3
```

---

#### Story INFRA-002-02: Release Workflow

**As a** maintainer
**I want** automated releases on tag push
**So that** publishing is consistent and fast

**Acceptance Criteria:**
- [ ] v* tags trigger npm publish
- [ ] GitHub Release created with notes
- [ ] Provenance attestation included
- [ ] Discord/Slack notification sent

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| INFRA-002-02-T1 | Create release.yml workflow | 3h | P0 |
| INFRA-002-02-T2 | Configure npm provenance | 2h | P0 |
| INFRA-002-02-T3 | Add GitHub Release creation | 2h | P0 |
| INFRA-002-02-T4 | Set up notification webhooks | 1h | P2 |
| INFRA-002-02-T5 | Document release process | 1h | P1 |

**Code Pattern - Release Workflow:**

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - run: npm ci
      - run: npm test
      - run: npm run build

      - name: Publish to npm
        run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          generate_release_notes: true
```

---

## Phase 1: Foundation + Safety (Weeks 9-12)

### Epic INFRA-003: Index Generation Pipeline

**Description:** Automate daily skill index generation from all sources.

**Business Value:** Keeps 50K+ skill index current without manual effort.

**Dependencies:** DA-003 (Sync Infrastructure)

**Definition of Done:**
- [ ] Daily scheduled runs at 03:00 UTC
- [ ] Fetches from GitHub, SkillsMP, claude-plugins.dev, mcp.so
- [ ] Generates SQLite database and embeddings
- [ ] Delta patches for incremental updates
- [ ] Published to GitHub Releases + CDN

---

#### Story INFRA-003-01: Source Aggregation Pipeline

**As a** system
**I want** to aggregate skills from all sources
**So that** the index is comprehensive

**Acceptance Criteria:**
- [ ] GitHub API fetched with rate limit handling
- [ ] Aggregator sites scraped with retry
- [ ] Sources deduplicated by repo URL
- [ ] Failed sources don't block pipeline

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| INFRA-003-01-T1 | Create GitHub fetcher with pagination | 5h | P0 |
| INFRA-003-01-T2 | Implement SkillsMP scraper | 3h | P0 |
| INFRA-003-01-T3 | Implement claude-plugins.dev scraper | 3h | P0 |
| INFRA-003-01-T4 | Implement mcp.so API client | 3h | P0 |
| INFRA-003-01-T5 | Create deduplication engine | 4h | P0 |
| INFRA-003-01-T6 | Add source health monitoring | 2h | P1 |

**Code Pattern - Index Generation Workflow:**

```yaml
# .github/workflows/index-generation.yml
name: Generate Skill Index

on:
  schedule:
    - cron: '0 3 * * *'  # Daily at 03:00 UTC
  workflow_dispatch:

jobs:
  generate:
    runs-on: ubuntu-latest
    timeout-minutes: 60

    steps:
      - uses: actions/checkout@v4
        with:
          repository: skillsmith/skill-index

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm ci

      - name: Fetch GitHub skills
        run: npm run fetch:github
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_PAT }}

      - name: Fetch aggregators
        run: npm run fetch:aggregators
        continue-on-error: true

      - name: Merge and deduplicate
        run: npm run merge

      - name: Compute quality scores
        run: npm run score

      - name: Generate embeddings
        run: npm run embeddings

      - name: Build SQLite database
        run: npm run build:db

      - name: Generate delta patches
        run: npm run build:delta

      - name: Upload to GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          tag_name: index-${{ github.run_number }}
          files: |
            dist/skills.db
            dist/embeddings.bin
            dist/manifest.json
```

---

### Epic INFRA-004: Web Infrastructure

**Description:** Deploy static skill browser website on GitHub Pages (Phase 1) and Vercel (Phase 2).

**Business Value:** SEO-friendly web presence for skill discovery.

**Dependencies:** PROD-101 (50K Index)

**Definition of Done:**
- [ ] Astro static site deployed
- [ ] Search works client-side
- [ ] SEO tags and sitemap generated
- [ ] Mobile responsive

---

#### Story INFRA-004-01: GitHub Pages Deployment

**As a** user
**I want** to browse skills on the web
**So that** I can discover skills outside Claude Code

**Acceptance Criteria:**
- [ ] Site deployed to skillsmith.app
- [ ] Static pages for each skill (SEO)
- [ ] Client-side search with sql.js
- [ ] Lighthouse score > 90

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| INFRA-004-01-T1 | Set up Astro project | 3h | P0 |
| INFRA-004-01-T2 | Configure GitHub Pages workflow | 2h | P0 |
| INFRA-004-01-T3 | Create skill page template | 4h | P0 |
| INFRA-004-01-T4 | Implement client-side search | 5h | P0 |
| INFRA-004-01-T5 | Add SEO meta tags | 2h | P1 |
| INFRA-004-01-T6 | Generate sitemap | 2h | P1 |

---

## Phase 2: Recommendations + Entry Points (Weeks 13-16)

### Epic INFRA-005: Monitoring and Observability

**Description:** Implement privacy-first monitoring with opt-in error tracking and opt-out usage analytics.

**Business Value:** Enables data-driven improvements while respecting privacy.

**Dependencies:** SEC-001 (Telemetry Infrastructure)

**Definition of Done:**
- [ ] Error tracking via Sentry (opt-in)
- [ ] Usage analytics via PostHog (opt-out)
- [ ] Local logging to rotating files
- [ ] Health check CLI command

---

#### Story INFRA-005-01: Local Observability

**As a** user
**I want** to diagnose issues locally
**So that** I can troubleshoot without external services

**Acceptance Criteria:**
- [ ] Structured JSON logs to ~/.skillsmith/logs/
- [ ] Log rotation (7 days, 10MB max per file)
- [ ] `skillsmith health` command works
- [ ] Performance metrics available

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| INFRA-005-01-T1 | Implement structured logger | 3h | P0 |
| INFRA-005-01-T2 | Add log rotation | 2h | P0 |
| INFRA-005-01-T3 | Create health check command | 4h | P0 |
| INFRA-005-01-T4 | Implement performance metrics collector | 4h | P1 |
| INFRA-005-01-T5 | Add debug mode with verbose logging | 2h | P1 |

**Code Pattern - Health Check:**

```typescript
// src/cli/commands/health.ts
export async function healthCheck(): Promise<void> {
  console.log('Health Check Results:');
  console.log('=====================\n');

  // Database check
  console.log('Database:');
  try {
    const db = await initializeDatabase({ readonly: true });
    const count = db.prepare('SELECT COUNT(*) as count FROM skills').get() as { count: number };
    console.log(`  ✓ SQLite connection: OK`);
    console.log(`  ✓ Skill count: ${count.count.toLocaleString()}`);
  } catch (e) {
    console.log(`  ✗ SQLite connection: FAILED - ${e.message}`);
  }

  // MCP Server check
  console.log('\nMCP Servers:');
  const servers = ['discovery-core', 'learning', 'sync'];
  for (const server of servers) {
    const running = await isServerRunning(server);
    console.log(`  ${running ? '✓' : '✗'} ${server}: ${running ? 'Running' : 'Stopped'}`);
  }

  // Performance check
  console.log('\nPerformance:');
  const metrics = await getMetrics();
  console.log(`  ✓ Memory usage: ${(metrics.memoryMB).toFixed(0)}MB (target: <500MB)`);
  console.log(`  ✓ Last search latency: ${metrics.lastSearchMs}ms (target: <500ms)`);
}
```

---

### Epic INFRA-006: VS Code Extension Publishing

**Description:** Publish VS Code extension to marketplace.

**Business Value:** Enables IDE-native skill discovery for VS Code users.

**Dependencies:** PROD-208 (VS Code Extension)

**Definition of Done:**
- [ ] Extension published to VS Code Marketplace
- [ ] Automated release on tag
- [ ] Extension icon and metadata
- [ ] User documentation

---

#### Story INFRA-006-01: Marketplace Publishing

**As a** VS Code user
**I want** to install from marketplace
**So that** setup is one-click

**Acceptance Criteria:**
- [ ] Extension available in marketplace search
- [ ] Install count tracking
- [ ] Rating and review enabled
- [ ] Auto-update on new releases

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| INFRA-006-01-T1 | Create publisher account | 1h | P0 |
| INFRA-006-01-T2 | Configure vsce for publishing | 2h | P0 |
| INFRA-006-01-T3 | Create extension icon and banner | 3h | P1 |
| INFRA-006-01-T4 | Write marketplace description | 2h | P0 |
| INFRA-006-01-T5 | Set up publish workflow | 3h | P0 |

---

## Infrastructure Diagrams

### Deployment Architecture

```
+---------------------------------------------------------------+
|  User's Machine                                                 |
|                                                                 |
|  +------------------------+    +--------------------------+    |
|  | Claude Code            |    | VS Code                   |    |
|  +------------------------+    +--------------------------+    |
|           |                              |                      |
|           v                              v                      |
|  +------------------------+    +--------------------------+    |
|  | MCP Servers            |<-->| VS Code Extension         |    |
|  | (npm package)          |    | (Marketplace)             |    |
|  +------------------------+    +--------------------------+    |
|           |                                                     |
|           v                                                     |
|  +------------------------+                                     |
|  | ~/.skillsmith/   |                                     |
|  | (Local data)           |                                     |
|  +------------------------+                                     |
+---------------------------------------------------------------+
           |
           | Sync (daily)
           v
+---------------------------------------------------------------+
|  GitHub Infrastructure                                          |
|                                                                 |
|  +------------------------+    +--------------------------+    |
|  | GitHub Actions         |    | GitHub Releases          |    |
|  | (CI/CD, Index Gen)     |    | (Index distribution)     |    |
|  +------------------------+    +--------------------------+    |
|           |                              |                      |
|           v                              v                      |
|  +------------------------+    +--------------------------+    |
|  | GitHub Pages           |    | jsDelivr CDN             |    |
|  | (Web browser)          |    | (Fast edge delivery)     |    |
|  +------------------------+    +--------------------------+    |
+---------------------------------------------------------------+
```

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [Infrastructure Architecture](../architecture/infrastructure.md) | Architecture source |
| [Technical Architecture](./01-technical-architecture.md) | MCP server details |
| [Testing Strategy](./07-testing-strategy.md) | CI integration |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | December 26, 2025 | DevOps Specialist | Initial implementation plan |
