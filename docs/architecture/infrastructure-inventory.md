# Skillsmith Infrastructure Inventory

> **Last Updated:** January 8, 2026
> **Document Status:** Living Document
> **Maintainer:** Infrastructure Team

This document provides a comprehensive inventory of all infrastructure components, services, and integrations used by the Skillsmith project.

---

## Table of Contents

1. [GitHub Actions Workflows](#1-github-actions-workflows)
2. [Supabase Edge Functions](#2-supabase-edge-functions)
3. [API Endpoints](#3-api-endpoints)
4. [Telemetry and Observability](#4-telemetry-and-observability)
5. [Database Schema](#5-database-schema)
6. [NPM Packages](#6-npm-packages)
7. [External Services](#7-external-services)
8. [Environment Variables](#8-environment-variables)

---

## 1. GitHub Actions Workflows

All workflows are located in `.github/workflows/` and follow a Docker-first CI strategy (SMI-708).

| Workflow | File | Triggers | Purpose | Status |
|----------|------|----------|---------|--------|
| **CI** | `ci.yml` | push/PR to `main` | Lint, typecheck, test, security audit, compliance, build | Active |
| **E2E Tests** | `e2e-tests.yml` | push/PR to `main`, `e2e-testing`; manual dispatch | CLI and MCP end-to-end tests | Active |
| **Skill Indexer** | `indexer.yml` | Daily cron (2:00 AM UTC); manual dispatch | Index GitHub repositories for skills | Active |
| **Publish** | `publish.yml` | GitHub Release; manual dispatch | Publish NPM packages | Active |

### Workflow Details

#### CI Workflow (`ci.yml`)

- **Concurrency:** One run per branch, cancels in-progress runs
- **Node Version:** 22
- **Jobs:**
  - `docker-build` - Build Docker image, extract node_modules artifact
  - `lint` - ESLint + Prettier formatting check
  - `typecheck` - TypeScript type checking
  - `test` - Vitest with coverage (uploads to Codecov)
  - `security` - npm audit (high severity) + security test suite
  - `compliance` - Standards audit (`npm run audit:standards`)
  - `build` - Build all packages, upload artifacts

#### E2E Tests Workflow (`e2e-tests.yml`)

- **Permissions:** `pull-requests: write`, `issues: write`
- **Test Scopes:** `all`, `cli`, `mcp`
- **Jobs:**
  - `docker-build` - Build E2E test image
  - `cli-e2e-tests` - CLI end-to-end tests
  - `mcp-e2e-tests` - MCP server end-to-end tests
  - `report-results` - Generate reports, create Linear issues on failure
  - `collect-baselines` - Performance baselines (main branch only)

#### Indexer Workflow (`indexer.yml`)

- **Schedule:** `0 2 * * *` (daily at 2 AM UTC)
- **Inputs:**
  - `dry_run` - Skip database writes (default: false)
  - `max_pages` - Max pages per topic (default: 3)
- **Secrets Required:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

#### Publish Workflow (`publish.yml`)

- **Jobs:**
  - `docker-build` - Build validation image
  - `validate` - Build, test, typecheck, lint
  - `publish-core` - Publish `@skillsmith/core` to npm
  - `publish-mcp-server` - Publish `@skillsmith/mcp-server` to npm
  - `publish-cli` - Publish `@skillsmith/cli` to npm
  - `publish-enterprise` - Publish `@skillsmith/enterprise` to GitHub Packages
- **Secrets Required:** `SKILLSMITH_NPM_TOKEN`

---

## 2. Supabase Edge Functions

Located in `supabase/functions/`. All functions are Deno-based and deployed to Supabase Edge.

| Function | Endpoint | Method | Purpose | Rate Limit |
|----------|----------|--------|---------|------------|
| **skills-search** | `/v1/skills-search` | GET | Full-text skill search with filters | 100 req/min |
| **skills-get** | `/v1/skills-get` | GET | Get skill by ID, author/name, or fuzzy match | 100 req/min |
| **skills-recommend** | `/v1/skills-recommend` | POST | AI-powered skill recommendations | 50 req/min |
| **events** | `/v1/events` | POST | Anonymous telemetry event recording | 200 req/min |
| **indexer** | `/v1/indexer` | POST/GET | GitHub repository skill indexer | Admin only |

### Shared Utilities (`_shared/`)

| File | Purpose |
|------|---------|
| `cors.ts` | CORS headers, preflight handling, JSON response helpers |
| `rate-limiter.ts` | Token bucket rate limiting with memory store |
| `supabase.ts` | Supabase client factory, pagination, logging utilities |

### Function Details

#### skills-search

- **Parameters:** `query` (required), `category`, `trust_tier`, `min_score`, `limit`, `offset`
- **Validation:** Query min 2 chars, trust_tier enum, min_score 0-100
- **Database:** Uses `search_skills` RPC for full-text search

#### skills-get

- **Parameters:** `id` (path or query)
- **Lookup Strategy:** UUID -> author/name -> fuzzy name match
- **Response:** Full skill object with categories array

#### skills-recommend

- **Body:** `stack` (required array), `project_type`, `limit`
- **Algorithm:** Tag matching + name/description matching + quality/trust boosts
- **Fallback:** Fuzzy search if direct match returns empty

#### indexer

- **Topics Searched:** `claude-code-skill`, `claude-code`, `anthropic-claude`, `claude-skill`
- **Quality Scoring:** Based on stars and forks
- **Trust Tier Assignment:** `verified` (official), `community` (50+ stars), `experimental` (5+ stars)

---

## 3. API Endpoints

### Production API Proxy

- **Base URL:** `https://api.skillsmith.dev/v1`
- **Proxy Host:** Vercel (rewrites to Supabase)
- **Configuration:** `apps/api-proxy/vercel.json`

### Endpoint Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/functions/v1/skills-search` | GET | Search skills |
| `/functions/v1/skills-get` | GET | Get skill details |
| `/functions/v1/skills-recommend` | POST | Get recommendations |
| `/functions/v1/events` | POST | Record telemetry |
| `/functions/v1/indexer` | POST | Trigger indexer (admin) |
| `/rest/v1/*` | * | Direct Supabase REST API |
| `/health` | GET | Health check endpoint |

### OpenAPI Specification

Full API documentation is available at `docs/api/openapi.yaml` with:
- Request/response schemas
- Rate limit headers
- Error response formats
- Example payloads

---

## 4. Telemetry and Observability

### PostHog Integration

- **Module:** `packages/core/src/telemetry/posthog.ts`
- **Status:** Implemented (SMI-1246)
- **Privacy:** Anonymous IDs only, no PII collected
- **Allowed Traits:** `tier`, `version`, `platform`, `sdk_version`

#### Event Types

| Event | Description |
|-------|-------------|
| `skill_search` | Search performed |
| `skill_view` | Skill details viewed |
| `skill_install` | Skill installed |
| `skill_uninstall` | Skill uninstalled |
| `skill_compare` | Skills compared |
| `skill_recommend` | Recommendations requested |
| `api_error` | API error occurred |
| `feature_flag_evaluated` | Feature flag checked |

### Prometheus Metrics

- **Module:** `packages/core/src/telemetry/prometheus.ts`
- **Status:** Implemented (SMI-1018)
- **Format:** Prometheus text exposition format
- **Endpoint:** `/metrics` (handler available)

#### Metrics Exported

| Metric | Type | Description |
|--------|------|-------------|
| `skillsmith_mcp_request_total` | counter | Total MCP requests |
| `skillsmith_mcp_request_latency_ms` | histogram | MCP request latency |
| `skillsmith_mcp_errors_total` | counter | Total MCP errors |
| `skillsmith_db_query_total` | counter | Database queries |
| `skillsmith_db_query_latency_ms` | histogram | Query latency |
| `skillsmith_cache_hits_total` | counter | Cache hits |
| `skillsmith_cache_misses_total` | counter | Cache misses |
| `skillsmith_search_total` | counter | Search operations |
| `skillsmith_rate_limit_blocked_total` | counter | Blocked requests |

### OpenTelemetry Integration

- **Module:** `packages/core/src/telemetry/tracer.ts`
- **Dependencies:** `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`
- **Status:** Implemented
- **Features:** Distributed tracing, auto-instrumentation

---

## 5. Database Schema

### Supabase Project

- **Project ID:** `vrcnzpmndtroqxxoqkzy`
- **Region:** (configured in Supabase dashboard)
- **PostgreSQL Version:** 17

### Core Tables

| Table | Purpose | RLS |
|-------|---------|-----|
| `skills` | Main skill storage | Public read, authenticated write |
| `sources` | Skill discovery sources | Public read |
| `categories` | Hierarchical skill categories | Public read |
| `skill_categories` | Skill-category junction | Public read |
| `cache` | API response cache | Public read |
| `audit_logs` | Security audit trail | Authenticated read |
| `schema_version` | Migration tracking | Public read |

### Key Indexes

| Index | Table | Columns | Type |
|-------|-------|---------|------|
| `idx_skills_search` | skills | `search_vector` | GIN |
| `idx_skills_name_trgm` | skills | `name` | GIN (trigram) |
| `idx_skills_tags` | skills | `tags` | GIN (JSONB) |
| `idx_skills_trust_tier` | skills | `trust_tier` | btree |
| `idx_skills_quality_score` | skills | `quality_score` | btree |
| `idx_skills_author_name` | skills | `author, name` | btree |
| `idx_skills_name_lower` | skills | `lower(name)` | btree |

### RPC Functions

| Function | Purpose | Migration |
|----------|---------|-----------|
| `search_skills` | Full-text search with ranking | 001 |
| `fuzzy_search_skills` | Trigram similarity search | 001 |
| `search_skills_v2` | Search with database-level filters | 004 |
| `get_skill_by_identifier` | Unified skill lookup | 005 |
| `invoke_indexer` | pg_cron indexer trigger | 003 |

### Migration History

| Migration | Description | Issue |
|-----------|-------------|-------|
| `001_initial_schema.sql` | Core tables, indexes, RLS, search functions | SMI-1179 |
| `003_indexer_schedule.sql` | pg_cron indexer configuration | SMI-1248 |
| `004_search_skills_v2.sql` | Database-level filter parameters | SMI-1263 |
| `005_get_skill_unified.sql` | Unified skill lookup RPC | SMI-1264 |
| `006_rpc_performance_indexes.sql` | Additional performance indexes | SMI-1271 |

---

## 6. NPM Packages

All packages are in `packages/` and use workspace dependencies.

| Package | Version | Registry | Status |
|---------|---------|----------|--------|
| `@skillsmith/core` | 0.2.0 | npm (public) | Published |
| `@skillsmith/mcp-server` | 0.2.0 | npm (public) | Published |
| `@skillsmith/cli` | 0.2.0 | npm (public) | Published |
| `@skillsmith/enterprise` | 0.1.2 | GitHub Packages (private) | Published |
| `@skillsmith/vscode-extension` | 0.1.2 | VS Code Marketplace | In Development |

### Package Dependencies

```
@skillsmith/core (foundation)
    |
    +---> @skillsmith/mcp-server (depends on core)
    |         |
    |         +---> @skillsmith/enterprise (optional peer)
    |
    +---> @skillsmith/cli (depends on core)
              |
              +---> @skillsmith/enterprise (optional peer)
```

### Key Dependencies

| Package | Dependency | Version | Purpose |
|---------|------------|---------|---------|
| core | `better-sqlite3` | 11.10.0 | Local SQLite database |
| core | `@xenova/transformers` | 2.17.2 | ONNX embeddings |
| core | `@opentelemetry/*` | various | Distributed tracing |
| core | `zod` | 4.2.1 | Schema validation |
| mcp-server | `@modelcontextprotocol/sdk` | ^1.0.4 | MCP protocol |
| cli | `commander` | ^12.0.0 | CLI framework |
| cli | `@inquirer/prompts` | ^7.0.0 | Interactive prompts |
| enterprise | `@aws-sdk/client-cloudwatch-logs` | ^3.700.0 | CloudWatch logging |
| enterprise | `jose` | ^5.2.0 | JWT handling |

---

## 7. External Services

### Supabase

| Resource | Purpose | Environment |
|----------|---------|-------------|
| **Database** | PostgreSQL skill storage | Production |
| **Edge Functions** | API endpoints | Production |
| **Auth** | User authentication (future) | Configured |
| **Storage** | File storage (future) | Configured |
| **Realtime** | Live updates (future) | Enabled |

### Vercel

| Resource | Purpose | URL |
|----------|---------|-----|
| **API Proxy** | Routes to Supabase | `api.skillsmith.dev` |
| **Rewrites** | `/functions/v1/*`, `/rest/v1/*` | - |

### PostHog

| Resource | Purpose |
|----------|---------|
| **Project Analytics** | Event tracking, user analytics |
| **Feature Flags** | Feature rollouts |
| **Host** | `https://app.posthog.com` |

### GitHub

| Integration | Purpose |
|-------------|---------|
| **GitHub App** | High-rate skill discovery (15K req/hr) |
| **Actions** | CI/CD workflows |
| **Packages** | Enterprise package registry |

### Stripe (Configured)

| Resource | Purpose |
|----------|---------|
| **Payments** | Team/Enterprise subscriptions |
| **Webhooks** | Payment event handling |

---

## 8. Environment Variables

Full schema defined in `.env.schema`. Key variables by category:

### Supabase

| Variable | Required | Sensitive | Purpose |
|----------|----------|-----------|---------|
| `SUPABASE_URL` | Yes | No | Project URL |
| `SUPABASE_ANON_KEY` | Yes | No | Public API key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Yes | Admin API key |
| `SUPABASE_ACCESS_TOKEN` | Yes | Yes | CLI authentication |

### GitHub

| Variable | Required | Sensitive | Purpose |
|----------|----------|-----------|---------|
| `GITHUB_APP_ID` | Yes | Yes | GitHub App ID |
| `GITHUB_APP_INSTALLATION_ID` | Yes | Yes | Installation ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | Yes | Base64 private key |

### Telemetry

| Variable | Required | Sensitive | Purpose |
|----------|----------|-----------|---------|
| `POSTHOG_KEY` | Yes | Yes | PostHog API key |
| `POSTHOG_HOST` | No | No | PostHog host URL |
| `SKILLSMITH_TELEMETRY` | No | No | Enable/disable telemetry |

### Payments (Future)

| Variable | Required | Sensitive | Purpose |
|----------|----------|-----------|---------|
| `STRIPE_SECRET_KEY` | Yes | Yes | Server-side API |
| `STRIPE_PUBLISHABLE_KEY` | No | No | Client-side API |
| `STRIPE_WEBHOOK_SECRET` | Yes | Yes | Webhook verification |

### CI/CD

| Variable | Required | Sensitive | Purpose |
|----------|----------|-----------|---------|
| `LINEAR_API_KEY` | Yes | Yes | Issue tracking |
| `NPM_TOKEN` | Yes | Yes | Package publishing |
| `VERCEL_TOKEN` | Yes | Yes | Deployment |
| `CODECOV_TOKEN` | No | Yes | Coverage reports |

---

## Infrastructure Diagram

```
                                    +-------------------+
                                    |   GitHub Actions  |
                                    |  (CI/CD/Indexer)  |
                                    +--------+----------+
                                             |
                                             v
+-------------+    +------------------+    +-------------------+
|   VS Code   |--->|  Vercel Proxy    |--->|     Supabase      |
|  Extension  |    | api.skillsmith.  |    |  (Edge Functions) |
+-------------+    +------------------+    +--------+----------+
                                                    |
+-------------+    +------------------+             v
|  Claude     |--->|  MCP Server      |    +-------------------+
|  Code CLI   |    | @skillsmith/mcp  |    |    PostgreSQL     |
+-------------+    +--------+---------+    |   (skills, etc)   |
                           |               +-------------------+
                           v
                   +------------------+    +-------------------+
                   |  Skillsmith CLI  |    |     PostHog       |
                   | @skillsmith/cli  |    |   (Telemetry)     |
                   +------------------+    +-------------------+
```

---

## Appendix: Health Check Endpoints

| Service | Endpoint | Expected Response |
|---------|----------|-------------------|
| API Proxy | `https://api.skillsmith.dev/health` | `200 OK` |
| Supabase | `https://<project>.supabase.co/rest/v1/` | `200 OK` |
| Edge Functions | `https://<project>.supabase.co/functions/v1/skills-search?query=test` | `200 OK` with JSON |

---

## Related Documents

- [System Overview](./system-overview.md)
- [Engineering Standards](./standards.md)
- [Skill Dependencies](./skill-dependencies.md)
- [API Documentation](../api/openapi.yaml)
- [ADR Index](../adr/)
