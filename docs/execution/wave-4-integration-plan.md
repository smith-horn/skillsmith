# Wave 4: Integration Execution Plan

**Issues:** SMI-1182, SMI-1183
**Est. Tokens:** ~40K
**Agents:** 4 (infra, npm-integrator, tester, reviewer)
**Date:** January 8, 2026

---

## Executive Summary

Wave 4 connects the Skillsmith npm packages to the live Supabase API via a Vercel proxy. The api-proxy infrastructure exists (`apps/api-proxy/`), DNS is configured, and Wave 3 has deployed comprehensive Edge Functions with rate limiting, CORS, and input sanitization.

**This wave focuses on:**
1. **Deploying** the Vercel API proxy to production (SMI-1182)
2. **Creating an API client** in @skillsmith/core with caching and offline fallback (SMI-1183)
3. **Updating the MCP server** to use the API client as primary data source

---

## Wave 3 Completed Work (Reference)

Wave 3 delivered significant infrastructure that Wave 4 builds upon:

| Component | Status | Details |
|-----------|--------|---------|
| Edge Functions | ✅ Deployed | 4 endpoints: search, get, recommend, events |
| Rate Limiting | ✅ Done | Upstash Redis + in-memory fallback (SMI-1231) |
| Input Sanitization | ✅ Done | `escapeLikePattern()`, `sanitizeFilterInput()` |
| CORS | ✅ Done | Production allowlist in `_shared/cors.ts` |
| OpenAPI Spec | ✅ Done | Full 555-line spec in `docs/api/openapi.yaml` |
| Integration Tests | ✅ Done | 29 tests in `tests/api/integration.test.ts` |
| Security Fixes | ✅ Done | Filter injection, LIKE wildcard injection fixed |

**Key Files from Wave 3:**
- `supabase/functions/_shared/rate-limiter.ts` - Rate limiting with fallback
- `supabase/functions/_shared/supabase.ts` - Input validation helpers
- `supabase/functions/_shared/cors.ts` - CORS configuration

---

## Current State Analysis

### What Already Exists

| Component | Status | Location |
|-----------|--------|----------|
| API Proxy Config | ✅ Ready | `apps/api-proxy/vercel.json` |
| Health Endpoint | ✅ Ready | `apps/api-proxy/api/health.ts` |
| DNS CNAME | ✅ Configured | `api` → `cname.vercel-dns.com` (Proxy ON) |
| Cache System | ✅ Ready | `packages/core/src/cache/CacheManager.ts` |
| Source Adapter Interface | ✅ Ready | `packages/core/src/sources/ISourceAdapter.ts` |
| Env Schema | ✅ Ready | `.env.schema` (SKILLSMITH_API_URL defined) |
| Edge Functions | ✅ Deployed | `supabase/functions/skills-*` |
| Rate Limiting | ✅ Done | `supabase/functions/_shared/rate-limiter.ts` |
| OpenAPI Spec | ✅ Done | `docs/api/openapi.yaml` |

### What Needs Building

| Component | Priority | Agent | Notes |
|-----------|----------|-------|-------|
| Deploy api-proxy to Vercel | High | infra | `vercel --prod` |
| Verify SSL certificate | High | infra | Via Vercel dashboard |
| API Client class | High | npm-integrator | Use OpenAPI types |
| API Cache layer | High | npm-integrator | Extend CacheManager |
| MCP server integration | High | npm-integrator | API-first with fallback |
| Offline fallback logic | Medium | npm-integrator | Env-based switch |
| API client unit tests | Medium | tester | New tests |
| Code review | Required | reviewer | Final gate |

---

## Hive Mind Execution Plan

### Phase 1: Swarm Initialization

```bash
# Initialize mesh topology for peer coordination
mcp__claude-flow__swarm_init {
  topology: "mesh",
  maxAgents: 4,
  strategy: "specialized"
}
```

### Phase 2: Parallel Agent Execution

#### Agent 1: Infrastructure Specialist (infra)

**Role:** Deploy and verify Vercel API proxy infrastructure

**Tasks:**
1. Deploy `apps/api-proxy/` to Vercel production
   ```bash
   cd apps/api-proxy && vercel --prod
   ```
2. Configure custom domain `api.skillsmith.app` in Vercel
   ```bash
   vercel domains add api.skillsmith.app
   ```
3. Verify SSL certificate provisioning
4. Test API proxy connectivity:
   ```bash
   curl https://api.skillsmith.app/health
   curl "https://api.skillsmith.app/rest/v1/skills?select=count" -H "apikey: $SUPABASE_ANON_KEY"
   ```
5. Update deployment documentation

**Acceptance Criteria:**
- [ ] `https://api.skillsmith.app/health` returns 200 with JSON
- [ ] SSL certificate is valid (not self-signed)
- [ ] Supabase proxy routes work (`/rest/v1/*`, `/functions/v1/*`)

---

#### Agent 2: NPM Integrator (npm-integrator) - PRIMARY

**Role:** Create API client and integrate with MCP server

**Tasks:**

**2.1 Create API Client Module** (`packages/core/src/api/`)

```
packages/core/src/api/
├── client.ts      # SkillsmithApiClient class
├── cache.ts       # ApiCacheManager (wraps CacheManager)
├── types.ts       # API response types (from OpenAPI)
└── index.ts       # Exports
```

**client.ts Key Features:**
```typescript
export class SkillsmithApiClient {
  private baseUrl: string
  private cache: ApiCacheManager
  private offlineMode: boolean
  private timeout: number = 10_000  // 10s timeout

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl ??
      process.env.SKILLSMITH_API_URL ??
      'https://api.skillsmith.app'
    this.offlineMode = options.offlineMode ??
      (process.env.SKILLSMITH_OFFLINE_MODE === 'true')
    this.cache = new ApiCacheManager({ ttl: options.cacheTtl ?? 86_400_000 }) // 24h
  }

  // Methods
  async search(params: SearchParams): Promise<SearchResponse>
  async getSkill(id: string): Promise<Skill | null>
  async recommend(stack: string[]): Promise<Skill[]>
  async checkHealth(): Promise<HealthStatus>
}
```

**2.2 Use OpenAPI Types**
- Import types from `docs/api/openapi.yaml` schema definitions
- Ensure client types match Edge Function responses
- Key types: `Skill`, `SearchResult`, `SearchResponse`, `RecommendResponse`

**2.3 API Cache Layer** (`packages/core/src/api/cache.ts`)
- Extend existing `CacheManager` for API responses
- 24-hour default TTL for skill data
- Cache invalidation on offline mode switch
- Key generation: `api:${endpoint}:${sha256(params)}`

**2.4 Update MCP Server Context** (`packages/mcp-server/src/context.ts`)

```typescript
export interface ToolContext {
  db: DatabaseType              // Local SQLite (fallback)
  searchService: SearchService  // Local search (fallback)
  skillRepository: SkillRepository  // Local CRUD (fallback)
  apiClient: SkillsmithApiClient   // NEW: API client (primary)
}
```

**2.5 Update Tool Handlers with Fallback Pattern**

```typescript
// In tools/search.ts
async function executeSearch(input, context) {
  // Skip API if offline mode forced
  if (context.apiClient.isOffline()) {
    return context.searchService.search(input.query, input)
  }

  try {
    // Try API first with timeout
    return await context.apiClient.search(input)
  } catch (error) {
    // Fallback to local DB
    console.warn('[skillsmith] API unavailable, using local database:', error.message)
    return context.searchService.search(input.query, input)
  }
}
```

**Files to Modify:**
- `packages/mcp-server/src/tools/search.ts`
- `packages/mcp-server/src/tools/get-skill.ts`
- `packages/mcp-server/src/tools/recommend.ts`

**2.6 Export API Client from Core**

Update `packages/core/src/index.ts`:
```typescript
export { SkillsmithApiClient, type ApiClientOptions } from './api/index.js'
```

**Acceptance Criteria:**
- [ ] API client module created with all methods
- [ ] Cache layer reduces duplicate API calls
- [ ] MCP server uses API by default
- [ ] Offline fallback works when `SKILLSMITH_OFFLINE_MODE=true`
- [ ] Offline fallback activates when API is unreachable
- [ ] 10-second timeout on all API requests

---

#### Agent 3: Test Specialist (tester)

**Role:** Write API client unit tests (integration tests exist from Wave 3)

**Tasks:**

**3.1 API Client Unit Tests** (`tests/api/client.test.ts`)
- Test URL construction
- Test cache hit/miss behavior
- Test timeout handling
- Test offline mode switch
- Test error transformation
- Mock fetch for unit tests

**3.2 Offline Fallback Tests** (`tests/api/offline.test.ts`)
- Test offline mode env var
- Test automatic fallback on API failure
- Test cache persistence across sessions

**3.3 MCP Tool Integration Tests** (extend existing)
- Test search tool uses API
- Test get_skill tool uses API
- Test fallback to local DB

**Commands:**
```bash
docker exec skillsmith-dev-1 npm test -- --grep "API Client"
docker exec skillsmith-dev-1 npm test -- --grep "offline"
```

**Note:** Wave 3 already created comprehensive integration tests in `tests/api/integration.test.ts` (29 tests). Focus on unit tests for the new API client.

**Acceptance Criteria:**
- [ ] >80% code coverage on API client
- [ ] All offline scenarios tested
- [ ] Unit tests pass without Supabase

---

#### Agent 4: Code Reviewer (reviewer)

**Role:** Final code review and quality assurance

**Tasks:**

**4.1 Security Review**
- No hardcoded API keys or secrets
- Input validation before API calls
- Safe error messages (no internal URLs/keys exposed)
- Verify Supabase anon key not logged

**4.2 Code Quality Review**
- TypeScript strict mode compliance
- Consistent error handling patterns
- JSDoc documentation on public APIs
- No console.log in production code (use structured logging)

**4.3 Architecture Review**
- API client follows existing patterns
- Cache layer properly integrated
- Fallback logic is robust
- Types match OpenAPI spec

**4.4 Standards Compliance**
```bash
docker exec skillsmith-dev-1 npm run audit:standards
docker exec skillsmith-dev-1 npm run lint
docker exec skillsmith-dev-1 npm run typecheck
docker exec skillsmith-dev-1 npm run preflight
```

---

## Execution Sequence

```
┌────────────────────────────────────────────────────────────────────┐
│                     WAVE 4 EXECUTION TIMELINE                       │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  T+0min   ┌─────────┐   ┌──────────────────┐                       │
│           │  infra  │   │  npm-integrator  │  ← Parallel Start     │
│           └────┬────┘   └────────┬─────────┘                       │
│                │                 │                                  │
│  T+15min       │ Deploy done     │ API client created              │
│                │                 │                                  │
│  T+30min       ▼                 ▼                                  │
│           SSL verified     MCP server updated                       │
│                │                 │                                  │
│  T+35min       └─────────┬───────┘                                 │
│                          │                                          │
│                   ┌──────▼──────┐                                   │
│  T+40min         │   tester    │  ← Unit Tests                     │
│                   └──────┬──────┘                                   │
│                          │                                          │
│  T+50min         ┌───────▼───────┐                                 │
│                  │   reviewer    │  ← Code Review                  │
│                  └───────┬───────┘                                 │
│                          │                                          │
│  T+60min                 ▼                                          │
│                    WAVE 4 COMPLETE                                  │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## Files Created/Modified

### New Files (4)

| File | Purpose |
|------|---------|
| `packages/core/src/api/client.ts` | API client class with timeout/caching |
| `packages/core/src/api/cache.ts` | API cache layer (extends CacheManager) |
| `packages/core/src/api/types.ts` | API response types (from OpenAPI) |
| `packages/core/src/api/index.ts` | Module exports |

### Modified Files (6)

| File | Changes |
|------|---------|
| `packages/core/src/index.ts` | Export API client |
| `packages/mcp-server/src/context.ts` | Add apiClient to context |
| `packages/mcp-server/src/tools/search.ts` | Use API with fallback |
| `packages/mcp-server/src/tools/get-skill.ts` | Use API with fallback |
| `packages/mcp-server/src/tools/recommend.ts` | Use API with fallback |
| `.env.schema` | Document API environment variables |

### Test Files (2 new, 1 extended)

| File | Purpose |
|------|---------|
| `tests/api/client.test.ts` | API client unit tests (new) |
| `tests/api/offline.test.ts` | Offline fallback tests (new) |
| `tests/api/integration.test.ts` | Extended MCP integration (existing) |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SKILLSMITH_API_URL` | `https://api.skillsmith.app` | API base URL |
| `SKILLSMITH_OFFLINE_MODE` | `false` | Force offline mode |
| `SKILLSMITH_API_CACHE_TTL` | `86400000` | Cache TTL in ms (24h) |
| `SKILLSMITH_API_TIMEOUT` | `10000` | API request timeout in ms |

---

## Additional Issues Identified

After reviewing Wave 3 commits and the current codebase, here are remaining issues for Wave 4:

| Issue | Description | Severity | Status |
|-------|-------------|----------|--------|
| **No request timeout** | API client needs configurable timeout | **High** | To implement |
| **No circuit breaker** | Repeated failures don't prevent hammering API | Medium | Consider for v0.3.0 |
| **Cache key collisions** | JSON.stringify may produce collisions | Low | Use SHA-256 hashing |
| **No request deduplication** | Concurrent identical requests not deduplicated | Low | Add in-flight tracking |
| **Vercel cold starts** | First request may be slow (~200ms) | Low | Accept or add keepalive |
| **Missing OpenAPI types codegen** | Types manually defined vs generated | Low | Consider openapi-typescript |
| ~~Rate limiting~~ | ~~Client needs rate limiting~~ | ~~Medium~~ | ✅ Server-side in Wave 3 |
| ~~Input sanitization~~ | ~~User input validation~~ | ~~High~~ | ✅ Done in Wave 3 |
| ~~CORS configuration~~ | ~~Production CORS setup~~ | ~~Medium~~ | ✅ Done in Wave 3 |
| ~~Security: Filter injection~~ | ~~PostgREST filter safety~~ | ~~Critical~~ | ✅ Fixed in Wave 3 |
| ~~Security: LIKE injection~~ | ~~Wildcard escape needed~~ | ~~Medium~~ | ✅ Fixed in Wave 3 |

### Severity Legend
- **Critical**: Security vulnerability, must fix immediately
- **High**: Affects reliability/functionality, fix in this wave
- **Medium**: Important improvement, can defer if needed
- **Low**: Nice to have, defer to future release

---

## Verification Commands

```bash
# 1. Verify API proxy deployment
curl https://api.skillsmith.app/health

# 2. Test Supabase proxy
curl "https://api.skillsmith.app/rest/v1/skills?select=id,name&limit=5" \
  -H "apikey: $SUPABASE_ANON_KEY"

# 3. Test Edge Function proxy
curl "https://api.skillsmith.app/functions/v1/skills-search?query=testing" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"

# 4. Build packages
docker exec skillsmith-dev-1 npm run build -w @skillsmith/core
docker exec skillsmith-dev-1 npm run build -w @skillsmith/mcp-server

# 5. Run tests
docker exec skillsmith-dev-1 npm test

# 6. Lint and typecheck
docker exec skillsmith-dev-1 npm run lint
docker exec skillsmith-dev-1 npm run typecheck

# 7. Standards audit
docker exec skillsmith-dev-1 npm run audit:standards
```

---

## Rollback Plan

If Wave 4 fails:

1. **API proxy issues:** Keep local-only mode, skip custom domain
2. **API client bugs:** Revert to 100% local database mode
3. **MCP server breaks:** Git revert tool changes

```bash
# Quick rollback
git checkout HEAD~1 -- packages/mcp-server/src/tools/
git checkout HEAD~1 -- packages/mcp-server/src/context.ts
git checkout HEAD~1 -- packages/core/src/index.ts
rm -rf packages/core/src/api/
```

---

## Success Criteria

| Gate | Validation |
|------|------------|
| API accessible | `curl https://api.skillsmith.app/health` returns 200 |
| SSL valid | Certificate chain validates (not self-signed) |
| Packages build | `npm run build` succeeds for core and mcp-server |
| Tests pass | `npm test` passes with >80% coverage |
| Lint clean | `npm run lint` has no errors |
| Types valid | `npm run typecheck` passes |
| Offline works | `SKILLSMITH_OFFLINE_MODE=true` uses local DB |
| Timeout works | API calls abort after 10 seconds |

---

## Post-Wave Actions

1. Mark SMI-1182 and SMI-1183 as Done in Linear:
   ```bash
   npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done SMI-1182 SMI-1183
   ```

2. Create project update:
   ```bash
   npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts create-project-update \
     "Skillsmith Phase 6A" \
     "Wave 4 complete. API proxy deployed at api.skillsmith.app, npm packages integrated with live API. Offline fallback tested."
   ```

3. Proceed to Wave 5 (Observability: SMI-1184 Telemetry, SMI-1185 Indexer)

---

## References

- [ADR-016: Vercel API Proxy](../adr/016-vercel-api-proxy.md)
- [Wave 3 Retrospective](../retros/wave-3-api-development.md)
- [OpenAPI Specification](../api/openapi.yaml)
- [Phase 6A Implementation Plan](./phase-6a-implementation-plan.md)
