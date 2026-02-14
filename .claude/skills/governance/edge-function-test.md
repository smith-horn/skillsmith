# Edge Function Test Generator

**SMI-1877**: Generate test scaffolds for Supabase Edge Functions with proper Vitest/Deno mocking patterns.

## Trigger Phrases

| Trigger | Example |
|---------|---------|
| Explicit | `/edge-test`, `/edge-function-test` |
| Keyword | "create test for edge function", "test edge function" |
| Keyword | "mock Deno", "mock Deno globals" |
| Error-triggered | "Deno is not defined", "ReferenceError: Deno" |

## When to Use

Use this subskill when:
- Creating a new test file for a Supabase Edge Function
- The module accesses `Deno.env.get()` at load time (IIFE, top-level code)
- You encounter "Deno is not defined" errors in tests
- You need to mock Supabase RPC calls in Edge Function tests

## The Problem

Edge Functions often access Deno globals at module load time:

```typescript
// trial-limiter.ts
const TRIAL_SALT = (() => {
  const salt = Deno.env.get('TRIAL_SALT')  // Runs at import time!
  return salt || 'default'
})()
```

Standard Vitest mocking (`vi.stubGlobal` in `beforeAll`) runs **after** the module loads, so `Deno` is undefined when the IIFE executes.

## The Solution

Use `vi.hoisted()` to stub globals **before** any imports:

```typescript
const { mockRpc } = vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).Deno = {
    env: { get: vi.fn() },
  }
  return { mockRpc: vi.fn() }
})
```

## Generated Scaffold

When triggered, this subskill generates a complete test file with:

1. **`vi.hoisted()` block** - Deno global stub before imports
2. **Environment variable mocks** - Configurable per test
3. **Supabase RPC mocks** - Factory functions for common patterns
4. **Correct import order** - Mocks before module under test
5. **Example test structure** - Happy path, error handling, edge cases
6. **`beforeEach` cleanup** - `vi.clearAllMocks()` pattern

## Usage

### Basic Usage

```
Create a test for the trial-limiter edge function
```

**Output**: Generates `supabase/functions/_shared/trial-limiter.test.ts`

### With Specific Mocks

```
Create a test for skills-search that mocks supabase and cors
```

**Output**: Generates scaffold with specified mock dependencies

### From Error

When you paste:
```
ReferenceError: Deno is not defined
```

The skill recognizes this and offers to:
1. Fix existing test with `vi.hoisted()` pattern
2. Generate new test scaffold

## Template

See [edge-function-test-template.ts](./templates/edge-function-test-template.ts) for the full scaffold template.

### Template Placeholders

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{MODULE_PATH}}` | Relative path to module | `./trial-limiter.ts` |
| `{{MODULE_NAME}}` | PascalCase module name | `TrialLimiter` |
| `{{EXPORTS}}` | Functions to import | `checkTrialLimit, trialExceededResponse` |
| `{{ENV_VARS}}` | Environment variables to mock | `TRIAL_SALT`, `SUPABASE_URL` |
| `{{DEPENDENCIES}}` | Modules to mock | `./supabase.ts`, `./cors.ts` |

## Examples

### Minimal Test (Single Function)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockEnvGet } = vi.hoisted(() => {
  const mockEnvGet = vi.fn((key: string) => {
    if (key === 'MY_SECRET') return 'test-secret'
    return undefined
  })
  ;(globalThis as Record<string, unknown>).Deno = {
    env: { get: mockEnvGet },
  }
  return { mockEnvGet }
})

import { myFunction } from './my-module.ts'

describe('myFunction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should work with mocked Deno env', () => {
    const result = myFunction()
    expect(result).toBeDefined()
  })
})
```

### Full Test (With Supabase RPC)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRpc } = vi.hoisted(() => {
  const mockGet = (key: string) => {
    if (key === 'TRIAL_SALT') return 'test-salt'
    return undefined
  }
  ;(globalThis as Record<string, unknown>).Deno = {
    env: { get: mockGet },
  }
  return { mockRpc: vi.fn() }
})

vi.mock('./supabase.ts', () => ({
  createSupabaseAdminClient: () => ({ rpc: mockRpc }),
}))

vi.mock('./cors.ts', () => ({
  errorResponse: (msg: string, status: number) => new Response(msg, { status }),
}))

import { checkTrialLimit } from './trial-limiter.ts'

describe('checkTrialLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return allowed when within limits', async () => {
    mockRpc.mockResolvedValue({
      data: [{ allowed: true, used: 5, remaining: 5 }],
      error: null,
    })

    const req = new Request('https://example.com')
    const result = await checkTrialLimit(req)

    expect(result.allowed).toBe(true)
  })

  it('should handle RPC errors gracefully', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Database error' },
    })

    const req = new Request('https://example.com')
    const result = await checkTrialLimit(req)

    // Permissive on errors
    expect(result.allowed).toBe(true)
  })
})
```

## Checklist

When generating a test scaffold, ensure:

- [ ] `vi.hoisted()` runs before any imports
- [ ] Deno global includes `env.get` function
- [ ] All dependencies are mocked with factory functions
- [ ] Module under test is imported AFTER mocks
- [ ] `beforeEach` includes `vi.clearAllMocks()`
- [ ] Test file follows naming convention: `*.test.ts`
- [ ] File is in correct location (co-located with source)

## References

- [Edge Function Patterns](../../../docs/development/edge-function-patterns.md) - Full documentation
- [SMI-1872](https://linear.app/smith-horn-group/issue/SMI-1872) - Original discovery
- [Vitest Mocking Guide](https://vitest.dev/guide/mocking.html) - Official docs

---

**Created**: 2026-01-27
**Related Issues**: SMI-1877, SMI-1872
