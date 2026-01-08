# Wave 5: Observability

**Issues:** SMI-1184 + SMI-1185 - Telemetry and GitHub indexer
**Est. Tokens:** ~30K
**Prerequisites:** Wave 4 complete (npm packages using live API)

---

## Objective

Add telemetry for product validation metrics (PostHog) and deploy the GitHub indexer to keep skills fresh.

## Context

- npm packages integrated with live API (Wave 4)
- Need to track usage for Gate 1/2 metrics
- Need to keep skill database updated with new skills

---

## Part 1: SMI-1184 - Add basic telemetry with PostHog

### Telemetry Design Principles

1. **Opt-out by default** - Set `SKILLSMITH_TELEMETRY=false` to disable
2. **No PII** - Anonymous ID only, no user data
3. **Transparent** - Document exactly what we collect
4. **Minimal** - Only collect what's needed for validation

### Events to Track

| Event | Properties | Purpose |
|-------|------------|---------|
| `search` | query, results_count | Measure search usage |
| `view_skill` | skill_id, source | Track skill interest |
| `install_skill` | skill_id | Measure conversions |
| `uninstall_skill` | skill_id, days_installed | Track retention |
| `error` | type, message | Monitor issues |

### Files to Create

```
/skillsmith/packages/core/src/telemetry/
├── posthog.ts     # PostHog client
├── events.ts      # Event definitions
├── anonymize.ts   # Anonymous ID generation
└── index.ts       # Exports
```

### PostHog Client (posthog.ts)

```typescript
// packages/core/src/telemetry/posthog.ts
import { getAnonymousId } from './anonymize.js';
import type { TelemetryEvent } from './events.js';

const POSTHOG_HOST = 'https://app.posthog.com';

export interface TelemetryOptions {
  apiKey?: string;
  host?: string;
  enabled?: boolean;
}

export class TelemetryClient {
  private apiKey: string | null;
  private host: string;
  private enabled: boolean;
  private anonymousId: string;

  constructor(options: TelemetryOptions = {}) {
    this.apiKey = options.apiKey || process.env.POSTHOG_API_KEY || null;
    this.host = options.host || process.env.POSTHOG_HOST || POSTHOG_HOST;
    this.enabled = options.enabled ?? (process.env.SKILLSMITH_TELEMETRY !== 'false');
    this.anonymousId = getAnonymousId();
  }

  async capture(event: TelemetryEvent): Promise<void> {
    if (!this.enabled || !this.apiKey) {
      return;
    }

    try {
      await fetch(`${this.host}/capture/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          event: event.name,
          distinct_id: this.anonymousId,
          properties: {
            ...event.properties,
            $lib: 'skillsmith',
            $lib_version: process.env.npm_package_version,
          },
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (error) {
      // Silently fail - telemetry should never break the app
      if (process.env.NODE_ENV === 'development') {
        console.debug('Telemetry error:', error);
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled && !!this.apiKey;
  }

  disable(): void {
    this.enabled = false;
  }
}

// Singleton
let client: TelemetryClient | null = null;

export function getTelemetry(options?: TelemetryOptions): TelemetryClient {
  if (!client) {
    client = new TelemetryClient(options);
  }
  return client;
}
```

### Events (events.ts)

```typescript
// packages/core/src/telemetry/events.ts

export interface TelemetryEvent {
  name: string;
  properties: Record<string, any>;
}

export const events = {
  search: (query: string, resultsCount: number): TelemetryEvent => ({
    name: 'search',
    properties: { query, results_count: resultsCount },
  }),

  viewSkill: (skillId: string, source: 'search' | 'recommend' | 'direct'): TelemetryEvent => ({
    name: 'view_skill',
    properties: { skill_id: skillId, source },
  }),

  installSkill: (skillId: string): TelemetryEvent => ({
    name: 'install_skill',
    properties: { skill_id: skillId },
  }),

  uninstallSkill: (skillId: string, daysInstalled: number): TelemetryEvent => ({
    name: 'uninstall_skill',
    properties: { skill_id: skillId, days_installed: daysInstalled },
  }),

  error: (type: string, message: string): TelemetryEvent => ({
    name: 'error',
    properties: { error_type: type, error_message: message },
  }),

  recommend: (stack: string[], resultsCount: number): TelemetryEvent => ({
    name: 'recommend',
    properties: { stack, results_count: resultsCount },
  }),
};
```

### Anonymous ID (anonymize.ts)

```typescript
// packages/core/src/telemetry/anonymize.ts
import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const ID_FILE = join(homedir(), '.skillsmith', 'anonymous_id');

export function getAnonymousId(): string {
  // Check for existing ID
  if (existsSync(ID_FILE)) {
    return readFileSync(ID_FILE, 'utf-8').trim();
  }

  // Generate new anonymous ID
  const id = `anon_${createHash('sha256')
    .update(randomBytes(32))
    .digest('hex')
    .slice(0, 16)}`;

  // Save for consistency
  try {
    mkdirSync(join(homedir(), '.skillsmith'), { recursive: true });
    writeFileSync(ID_FILE, id);
  } catch {
    // Ignore - use ephemeral ID if can't persist
  }

  return id;
}
```

### Update MCP Tools with Telemetry

Example for search tool:

```typescript
// In search.ts
import { getTelemetry, events } from '@skillsmith/core';

export async function executeSearch(input: SearchInput, context: ToolContext) {
  const response = await context.apiClient.search(input.query, { ... });

  // Track search event
  getTelemetry().capture(events.search(input.query, response.total));

  return response;
}
```

### Privacy Documentation

Create `/skillsmith/docs/PRIVACY.md`:

```markdown
# Skillsmith Privacy & Telemetry

## What We Collect

Skillsmith collects anonymous usage data to improve the product:

| Data | Example | Purpose |
|------|---------|---------|
| Search queries | "testing skills" | Improve search relevance |
| Skill views | skill ID only | Popular skill ranking |
| Install/uninstall | skill ID only | Measure value delivery |
| Errors | error type | Bug fixes |

## What We DON'T Collect

- No usernames or emails
- No IP addresses
- No file contents
- No project names
- No personal information

## How to Opt Out

Set the environment variable:
```bash
export SKILLSMITH_TELEMETRY=false
```

Or in your shell config:
```bash
echo 'export SKILLSMITH_TELEMETRY=false' >> ~/.zshrc
```

## Anonymous ID

We generate a random anonymous ID stored in `~/.skillsmith/anonymous_id`.
This is used only for session continuity and contains no personal information.
You can delete this file at any time.

## Data Retention

Telemetry data is retained for 90 days and then deleted.
```

---

## Part 2: SMI-1185 - Deploy GitHub indexer

### GitHub Action for Daily Indexing

Create `/skillsmith/.github/workflows/daily-index.yml`:

```yaml
name: Daily Skill Index

on:
  schedule:
    # Run daily at 2 AM UTC
    - cron: '0 2 * * *'
  workflow_dispatch: # Allow manual trigger

jobs:
  index:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Run indexer
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        run: npx tsx scripts/scheduled-index.ts

      - name: Report results
        if: always()
        run: |
          echo "Indexing completed at $(date)"
```

### Scheduled Index Script

Create `/skillsmith/scripts/scheduled-index.ts`:

```typescript
// scripts/scheduled-index.ts
import { GitHubIndexer } from '@skillsmith/core';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

async function main() {
  console.log('Starting scheduled index...');

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Get existing skill count
  const { count: beforeCount } = await supabase
    .from('skills')
    .select('*', { count: 'exact', head: true });

  console.log(`Existing skills: ${beforeCount}`);

  // Run indexer
  const indexer = new GitHubIndexer({
    token: GITHUB_TOKEN,
    topics: ['claude-skill', 'claude-code-skill'],
    maxResults: 1000,
  });

  let newSkills = 0;
  let updatedSkills = 0;

  for await (const skill of indexer.index()) {
    const { error } = await supabase
      .from('skills')
      .upsert({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        author: skill.author,
        repository_url: skill.repository_url,
        category: skill.category,
        trust_tier: skill.trust_tier,
        quality_score: skill.quality_score,
        updated_at: new Date().toISOString(),
        metadata: skill.metadata,
      }, {
        onConflict: 'id',
      });

    if (error) {
      console.error(`Error upserting ${skill.id}:`, error);
      continue;
    }

    // Check if new or updated
    const { data: existing } = await supabase
      .from('skills')
      .select('created_at, updated_at')
      .eq('id', skill.id)
      .single();

    if (existing?.created_at === existing?.updated_at) {
      newSkills++;
    } else {
      updatedSkills++;
    }
  }

  // Get final count
  const { count: afterCount } = await supabase
    .from('skills')
    .select('*', { count: 'exact', head: true });

  console.log(`
Indexing complete:
  - Before: ${beforeCount} skills
  - After: ${afterCount} skills
  - New: ${newSkills}
  - Updated: ${updatedSkills}
  `);
}

main().catch((error) => {
  console.error('Indexing failed:', error);
  process.exit(1);
});
```

## Commands to Run

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Create telemetry module
mkdir -p packages/core/src/telemetry

# Create privacy doc
# (write PRIVACY.md)

# Build
npm run build

# Test telemetry locally
POSTHOG_API_KEY=your_key npm test -- --grep "telemetry"

# Test indexer (dry run)
GITHUB_TOKEN=xxx SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx \
  npx tsx scripts/scheduled-index.ts

# Commit workflow
git add .github/workflows/daily-index.yml
git commit -m "Add daily indexer workflow"
git push
```

## Acceptance Criteria

### SMI-1184
- [ ] Telemetry client created
- [ ] Events tracked in PostHog (verify in dashboard)
- [ ] Opt-out works (SKILLSMITH_TELEMETRY=false)
- [ ] No PII collected
- [ ] PRIVACY.md created

### SMI-1185
- [ ] GitHub Action workflow created
- [ ] Indexer script works
- [ ] Workflow runs on schedule (or manual trigger)
- [ ] New/updated skills reflected in database

## On Completion

1. Mark issues as Done:
   ```bash
   npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done 1184 1185
   ```

2. Verify Wave 5 gate:
   - Events visible in PostHog dashboard
   - Workflow appears in GitHub Actions

3. Proceed to Wave 6
