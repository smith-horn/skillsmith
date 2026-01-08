# Wave 3: API Development

**Issue:** SMI-1180 - Create skill registry API endpoints
**Est. Tokens:** ~50K
**Prerequisites:** Wave 2 complete (database migrated)

---

## Objective

Create Supabase Edge Functions to serve the skill registry API at api.skillsmith.app.

## Context

- Database populated with 9,717 skills (Wave 2)
- Need 4 API endpoints for skill discovery
- Using Supabase Edge Functions (Deno runtime)

## API Endpoints

### 1. GET /v1/skills/search
Search for skills by query string with optional filters.

```typescript
// Request
GET /v1/skills/search?query=testing&category=testing&trust_tier=verified&limit=10

// Response
{
  "skills": [
    {
      "id": "author/skill-name",
      "name": "Skill Name",
      "description": "...",
      "author": "author",
      "category": "testing",
      "trust_tier": "verified",
      "quality_score": 85,
      "repository_url": "https://github.com/..."
    }
  ],
  "total": 42,
  "query": "testing"
}
```

### 2. GET /v1/skills/:id
Get a single skill by ID.

```typescript
// Request
GET /v1/skills/community/jest-helper

// Response
{
  "skill": {
    "id": "community/jest-helper",
    "name": "Jest Helper",
    "description": "...",
    // ... full skill object
  }
}

// Error Response (404)
{
  "error": "Skill not found",
  "id": "community/nonexistent"
}
```

### 3. POST /v1/skills/recommend
Get skill recommendations based on project stack.

```typescript
// Request
POST /v1/skills/recommend
{
  "stack": ["typescript", "react", "vitest"],
  "project_type": "frontend"
}

// Response
{
  "recommendations": [
    {
      "skill": { /* skill object */ },
      "reason": "Matches your testing stack (vitest)",
      "confidence": 0.85
    }
  ]
}
```

### 4. POST /v1/events
Receive telemetry events (for PostHog integration in Wave 5).

```typescript
// Request
POST /v1/events
{
  "event": "search",
  "properties": {
    "query": "testing",
    "results_count": 42
  },
  "anonymous_id": "anon_xxxxx"
}

// Response
{ "ok": true }
```

## Files to Create

```
/skillsmith/supabase/functions/
├── _shared/
│   ├── cors.ts          # CORS headers
│   ├── supabase.ts      # Supabase client factory
│   └── types.ts         # Shared types
├── skills-search/
│   └── index.ts
├── skills-get/
│   └── index.ts
├── skills-recommend/
│   └── index.ts
└── events/
    └── index.ts
```

## Shared Utilities

### cors.ts
```typescript
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function handleCors(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}
```

### supabase.ts
```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function getSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
}
```

## Edge Function Template

```typescript
// skills-search/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { getSupabase } from '../_shared/supabase.ts';

serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const url = new URL(req.url);
    const query = url.searchParams.get('query') || '';
    const category = url.searchParams.get('category');
    const trust_tier = url.searchParams.get('trust_tier');
    const limit = parseInt(url.searchParams.get('limit') || '10');

    const supabase = getSupabase();

    let queryBuilder = supabase
      .from('skills')
      .select('*', { count: 'exact' });

    // Full-text search
    if (query) {
      queryBuilder = queryBuilder.textSearch('search_vector', query);
    }

    // Filters
    if (category) {
      queryBuilder = queryBuilder.eq('category', category);
    }
    if (trust_tier) {
      queryBuilder = queryBuilder.eq('trust_tier', trust_tier);
    }

    // Execute
    const { data, count, error } = await queryBuilder
      .order('quality_score', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return new Response(
      JSON.stringify({ skills: data, total: count, query }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
```

## Commands to Run

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Create functions structure
mkdir -p supabase/functions/_shared
mkdir -p supabase/functions/skills-search
mkdir -p supabase/functions/skills-get
mkdir -p supabase/functions/skills-recommend
mkdir -p supabase/functions/events

# Test locally
supabase functions serve

# Deploy
supabase functions deploy skills-search
supabase functions deploy skills-get
supabase functions deploy skills-recommend
supabase functions deploy events

# Test deployed function
curl "https://<project-ref>.supabase.co/functions/v1/skills-search?query=testing"
```

## Testing

Create integration tests:

```typescript
// tests/api/integration.test.ts
import { describe, it, expect } from 'vitest';

const API_URL = process.env.SUPABASE_URL + '/functions/v1';

describe('Skills API', () => {
  it('should search skills', async () => {
    const res = await fetch(`${API_URL}/skills-search?query=testing`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.skills).toBeInstanceOf(Array);
    expect(data.total).toBeGreaterThan(0);
  });

  it('should get skill by id', async () => {
    const res = await fetch(`${API_URL}/skills-get/community/jest-helper`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.skill).toBeDefined();
  });

  it('should return 404 for unknown skill', async () => {
    const res = await fetch(`${API_URL}/skills-get/unknown/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('should accept recommendations request', async () => {
    const res = await fetch(`${API_URL}/skills-recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: ['typescript', 'react'] })
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.recommendations).toBeInstanceOf(Array);
  });
});
```

## Acceptance Criteria

- [ ] All 4 endpoints deployed and responding
- [ ] CORS configured (any origin allowed)
- [ ] Search returns relevant results
- [ ] Get returns skill or 404
- [ ] Recommend returns stack-based suggestions
- [ ] Events accepts POST and returns ok
- [ ] Error responses are JSON with status codes
- [ ] Integration tests pass

## On Completion

1. Mark SMI-1180 as Done:
   ```bash
   npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done 1180
   ```

2. Verify Wave 3 gate: All endpoints return 200

3. Proceed to Wave 4
