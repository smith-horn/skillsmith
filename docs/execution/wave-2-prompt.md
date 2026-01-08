# Wave 2: Database Migration

**Issue:** SMI-1181 - Migrate skills database to Supabase
**Est. Tokens:** ~25K
**Prerequisites:** Wave 1 complete (schema deployed)

---

## Objective

Migrate all 9,717 skills from the local SQLite database to Supabase PostgreSQL.

## Context

- Schema deployed in Wave 1
- Source data in SQLite at `~/.skillsmith/skills.db`
- Need to preserve all metadata, quality scores, trust tiers

## Tasks

1. **Read source database** - Understand SQLite structure and data
2. **Create migration script** - Export from SQLite, transform, insert to Supabase
3. **Handle batch inserts** - Supabase has rate limits, use batches of 500
4. **Create validation script** - Verify row counts and data integrity
5. **Execute migration** - Run the migration
6. **Validate results** - Confirm all data migrated correctly

## Files to Read

```
/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/packages/core/src/db/schema.ts
/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/packages/core/src/repositories/SkillRepository.ts
/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/supabase/migrations/001_initial_schema.sql
```

## Files to Create

```
/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/scripts/migrate-to-supabase.ts
/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/scripts/validate-migration.ts
```

## Migration Script Structure

```typescript
// migrate-to-supabase.ts
import Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';

const BATCH_SIZE = 500;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function migrate() {
  // 1. Open SQLite
  const sqlite = new Database(process.env.SKILLSMITH_DB_PATH || '~/.skillsmith/skills.db');

  // 2. Create Supabase client
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 3. Read all skills from SQLite
  const skills = sqlite.prepare('SELECT * FROM skills').all();
  console.log(`Found ${skills.length} skills to migrate`);

  // 4. Transform and batch insert
  for (let i = 0; i < skills.length; i += BATCH_SIZE) {
    const batch = skills.slice(i, i + BATCH_SIZE);
    const transformed = batch.map(transformSkill);

    const { error } = await supabase.from('skills').upsert(transformed);
    if (error) throw error;

    console.log(`Migrated ${Math.min(i + BATCH_SIZE, skills.length)}/${skills.length}`);
  }

  console.log('Migration complete!');
}

function transformSkill(skill: any) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    author: skill.author,
    repository_url: skill.repository_url,
    category: skill.category,
    trust_tier: skill.trust_tier,
    quality_score: skill.quality_score,
    install_count: skill.install_count || 0,
    created_at: skill.created_at,
    updated_at: skill.updated_at,
    metadata: skill.metadata ? JSON.parse(skill.metadata) : {}
  };
}

migrate().catch(console.error);
```

## Validation Script Structure

```typescript
// validate-migration.ts
import Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';

async function validate() {
  // 1. Count in SQLite
  const sqlite = new Database(process.env.SKILLSMITH_DB_PATH || '~/.skillsmith/skills.db');
  const sqliteCount = sqlite.prepare('SELECT COUNT(*) as count FROM skills').get() as { count: number };

  // 2. Count in Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const { count: supabaseCount } = await supabase
    .from('skills')
    .select('*', { count: 'exact', head: true });

  console.log(`SQLite count: ${sqliteCount.count}`);
  console.log(`Supabase count: ${supabaseCount}`);

  if (sqliteCount.count !== supabaseCount) {
    console.error('❌ Count mismatch!');
    process.exit(1);
  }

  // 3. Sample queries
  const { data: sample } = await supabase
    .from('skills')
    .select('*')
    .limit(5);

  console.log('\nSample skills:');
  sample?.forEach(s => console.log(`  - ${s.id}: ${s.name}`));

  // 4. Test search
  const { data: searchResults } = await supabase
    .from('skills')
    .select('*')
    .textSearch('search_vector', 'testing')
    .limit(3);

  console.log(`\nSearch "testing" returned ${searchResults?.length} results`);

  console.log('\n✅ Validation passed!');
}

validate().catch(console.error);
```

## Commands to Run

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Load environment
source .env.phase6a

# Run migration
npx tsx scripts/migrate-to-supabase.ts

# Validate
npx tsx scripts/validate-migration.ts
```

## Acceptance Criteria

- [ ] All 9,717 skills migrated (count matches)
- [ ] No data loss (sample verification)
- [ ] Quality scores preserved
- [ ] Trust tiers preserved
- [ ] Search returns expected results

## On Completion

1. Mark SMI-1181 as Done:
   ```bash
   npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done 1181
   ```

2. Verify Wave 2 gate: Row count = 9,717

3. Proceed to Wave 3
