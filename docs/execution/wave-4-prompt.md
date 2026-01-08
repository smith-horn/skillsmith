# Wave 4: Integration

**Issues:** SMI-1182 + SMI-1183 - Domain configuration and npm package integration
**Est. Tokens:** ~40K
**Prerequisites:** Wave 3 complete (API endpoints deployed)

---

## Objective

Configure the api.skillsmith.app custom domain and update npm packages to use the live API instead of local data.

## Context

- API endpoints deployed to Supabase Edge Functions (Wave 3)
- Need custom domain for stable API URL
- npm packages currently use local SQLite data

---

## Part 1: SMI-1182 - Configure api.skillsmith.app ✅ COMPLETE

> **Status**: Completed on January 8, 2026
> **Architecture**: Vercel API Proxy (see [ADR-016](/skillsmith/docs/adr/016-vercel-api-proxy.md))

### Completed Tasks

1. ✅ **Deployed Vercel API Proxy** (`apps/api-proxy/`)
2. ✅ **Configured DNS** (Cloudflare CNAME → `cname.vercel-dns.com`, Proxy ON)
3. ✅ **SSL Certificate** provisioned via Vercel/Cloudflare
4. ✅ **Tested API access** - all routes working

### Architecture (Vercel Proxy instead of Supabase Custom Domains)

```
Client → Cloudflare (Proxy) → Vercel Edge → Supabase
                                    │
                         ┌──────────┴──────────┐
                         │                     │
                    /health              /rest/v1/*
                   (local)            /functions/v1/*
                                    (proxy to Supabase)
```

**Why Vercel Proxy?** Supabase custom domains require $10/month add-on. Vercel proxy is free.

### Verified Endpoints

```bash
# Health check (local Vercel function)
curl https://api.skillsmith.app/health
# → {"status":"ok","service":"skillsmith-api-proxy","version":"1.0.0"}

# Supabase REST API proxy
curl https://api.skillsmith.app/rest/v1/skills?select=count -H "apikey: $SUPABASE_ANON_KEY"
# → [{"count":13602}]

# Supabase Edge Functions proxy (ready for Wave 3 deployment)
curl https://api.skillsmith.app/functions/v1/skills-search?query=testing
```

---

## Part 2: SMI-1183 - Update npm packages

### Files to Create

```
/skillsmith/packages/core/src/api/
├── client.ts      # API client
├── cache.ts       # Response caching
├── types.ts       # API types
└── index.ts       # Exports
```

### API Client (client.ts)

```typescript
// packages/core/src/api/client.ts
import { ApiCache } from './cache.js';
import type { Skill, SearchResponse, RecommendResponse } from './types.js';

const DEFAULT_API_URL = 'https://api.skillsmith.app/functions/v1';

export interface ApiClientOptions {
  apiUrl?: string;
  cache?: ApiCache;
  timeout?: number;
}

export class SkillsmithApiClient {
  private apiUrl: string;
  private cache: ApiCache;
  private timeout: number;

  constructor(options: ApiClientOptions = {}) {
    this.apiUrl = options.apiUrl || process.env.SKILLSMITH_API_URL || DEFAULT_API_URL;
    this.cache = options.cache || new ApiCache();
    this.timeout = options.timeout || 10000;
  }

  async search(query: string, options?: {
    category?: string;
    trust_tier?: string;
    limit?: number;
  }): Promise<SearchResponse> {
    const params = new URLSearchParams({ query, ...options as any });
    const url = `${this.apiUrl}/skills-search?${params}`;

    // Check cache
    const cached = this.cache.get(url);
    if (cached) return cached;

    // Fetch
    const response = await this.fetchWithTimeout(url);
    const data = await response.json();

    // Cache response
    this.cache.set(url, data);

    return data;
  }

  async getSkill(id: string): Promise<Skill | null> {
    const url = `${this.apiUrl}/skills-get/${encodeURIComponent(id)}`;

    const cached = this.cache.get(url);
    if (cached) return cached;

    const response = await this.fetchWithTimeout(url);

    if (response.status === 404) {
      return null;
    }

    const data = await response.json();
    this.cache.set(url, data.skill);

    return data.skill;
  }

  async recommend(stack: string[], projectType?: string): Promise<RecommendResponse> {
    const url = `${this.apiUrl}/skills-recommend`;

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack, project_type: projectType }),
    });

    return response.json();
  }

  async sendEvent(event: string, properties: Record<string, any>, anonymousId: string): Promise<void> {
    const url = `${this.apiUrl}/events`;

    await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, properties, anonymous_id: anonymousId }),
    });
  }

  private async fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      if (!response.ok && response.status !== 404) {
        throw new Error(`API error: ${response.status}`);
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  isAvailable(): Promise<boolean> {
    return this.search('test', { limit: 1 })
      .then(() => true)
      .catch(() => false);
  }
}

// Singleton instance
let client: SkillsmithApiClient | null = null;

export function getApiClient(options?: ApiClientOptions): SkillsmithApiClient {
  if (!client) {
    client = new SkillsmithApiClient(options);
  }
  return client;
}
```

### Cache (cache.ts)

```typescript
// packages/core/src/api/cache.ts
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class ApiCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private ttl: number;

  constructor(ttlMs: number = 24 * 60 * 60 * 1000) { // 24 hours default
    this.ttl = ttlMs;
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
```

### Types (types.ts)

```typescript
// packages/core/src/api/types.ts
export interface Skill {
  id: string;
  name: string;
  description: string;
  author: string;
  repository_url: string;
  category: string;
  trust_tier: 'verified' | 'community' | 'experimental' | 'unknown';
  quality_score: number;
  install_count: number;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, any>;
}

export interface SearchResponse {
  skills: Skill[];
  total: number;
  query: string;
}

export interface Recommendation {
  skill: Skill;
  reason: string;
  confidence: number;
}

export interface RecommendResponse {
  recommendations: Recommendation[];
}
```

### Update Core Index (packages/core/src/index.ts)

Add exports:
```typescript
// API Client (Phase 6A)
export { SkillsmithApiClient, getApiClient } from './api/index.js';
export type { ApiClientOptions } from './api/client.js';
export { ApiCache } from './api/cache.js';
```

### Update MCP Server Context

Modify `/skillsmith/packages/mcp-server/src/context.ts`:

```typescript
import { getApiClient, SkillsmithApiClient } from '@skillsmith/core';

export interface ToolContext {
  apiClient: SkillsmithApiClient;
  // ... existing context
}

export function getToolContext(): ToolContext {
  const offlineMode = process.env.SKILLSMITH_OFFLINE_MODE === 'true';

  if (offlineMode) {
    // Fall back to local database
    return getLocalContext();
  }

  return {
    apiClient: getApiClient(),
    // ...
  };
}
```

### Update MCP Tools

Example for search tool (`/skillsmith/packages/mcp-server/src/tools/search.ts`):

```typescript
export async function executeSearch(
  input: SearchInput,
  context: ToolContext
): Promise<SearchOutput> {
  try {
    // Use live API
    const response = await context.apiClient.search(input.query, {
      category: input.category,
      trust_tier: input.trust_tier,
      limit: input.limit,
    });

    return {
      skills: response.skills,
      total: response.total,
    };
  } catch (error) {
    // Log error but don't fail - could fall back to local
    console.error('API search failed:', error);
    throw error;
  }
}
```

## Commands to Run

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Create API client module
mkdir -p packages/core/src/api

# Build after changes
npm run build -w @skillsmith/core
npm run build -w @skillsmith/mcp-server

# Test
npm test

# Verify API access
curl https://api.skillsmith.app/functions/v1/skills-search?query=testing
```

## Acceptance Criteria

### SMI-1182 ✅ COMPLETE
- [x] api.skillsmith.app resolves correctly
- [x] SSL certificate valid (via Cloudflare/Vercel)
- [x] API endpoints accessible via custom domain
- [x] Vercel API proxy deployed (`apps/api-proxy/`)
- [x] ADR-016 documented

### SMI-1183
- [ ] API client created in @skillsmith/core
- [ ] MCP server uses API client
- [ ] Caching works (24h TTL)
- [ ] Offline fallback works (SKILLSMITH_OFFLINE_MODE=true)
- [ ] All tests pass

## On Completion

1. Mark issues as Done:
   ```bash
   npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done 1182 1183
   ```

2. Verify Wave 4 gate: `curl https://api.skillsmith.app/...` works

3. Proceed to Wave 5
