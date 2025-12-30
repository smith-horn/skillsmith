# ADR-011: Integration Test Database Strategy

**Status**: Accepted
**Date**: 2025-12-30
**Deciders**: Development Team
**Related Issues**: SMI-756, SMI-754, SMI-777

## Context

MCP integration tests (SMI-756) require a database to test end-to-end functionality. We need to decide on the database strategy for these tests.

### Options Considered

**Option A: Real PostgreSQL/MySQL Database**
- Docker-based test database
- Production parity
- Realistic performance characteristics
- Complex CI setup

**Option B: In-Memory SQLite**
- Fast execution
- No external dependencies
- Simple CI integration
- Matches production database (SQLite)

## Decision

We chose **Option B: In-Memory SQLite with Migrations**.

### Rationale

1. **Production Parity**: Skillsmith uses SQLite in production, so tests match reality
2. **CI Speed**: In-memory databases are fast, no container startup
3. **Simplicity**: No Docker dependency for tests
4. **Reliability**: No network issues or container failures
5. **Developer Experience**: Tests run instantly on any machine

### Implementation

```typescript
// packages/core/tests/setup/test-database.ts

export async function createTestDatabase(): Promise<Database> {
  const db = new Database(':memory:');

  // Run all migrations
  await runMigrations(db, {
    migrationsPath: path.join(__dirname, '../../migrations'),
  });

  return db;
}

// packages/core/tests/integration/mcp-tools.test.ts

describe('MCP Integration Tests', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
    // Seed with test data
    await seedTestSkills(db);
  });

  afterEach(() => {
    db.close();
  });

  it('search returns relevant skills', async () => {
    const results = await mcpSearch(db, { query: 'git workflow' });
    expect(results.skills).toHaveLength(expect.any(Number));
  });
});
```

### Test Data Strategy

```typescript
// packages/core/tests/fixtures/skills.ts

export const TEST_SKILLS = [
  {
    id: 'test-git-skill',
    name: 'Git Workflow Helper',
    description: 'Helps with git operations',
    triggers: ['git', 'commit', 'branch'],
    embedding: [/* deterministic vector */],
  },
  // ... more fixtures
];

export async function seedTestSkills(db: Database): Promise<void> {
  for (const skill of TEST_SKILLS) {
    await db.run(`INSERT INTO skills ...`, skill);
  }
}
```

## Consequences

### Positive
- Tests are fast and reliable
- No external dependencies
- Works identically in CI and local
- Matches production database engine

### Negative
- Cannot test PostgreSQL-specific features
- No realistic performance benchmarks
- Cannot test database connection issues

### Neutral
- Test fixtures need maintenance
- Migration testing is implicit

## Future Work

**SMI-777: Production Database Integration Tests** (Parking Lot)

When these conditions are met, consider implementing Option A:
1. Migrating to PostgreSQL/MySQL in production
2. Performance regression testing needed
3. Database-specific features required
4. Load testing requirements emerge

Implementation would include:
- Docker Compose test environment
- Fixture factory system
- CI pipeline integration
- Performance comparison benchmarks

## References

- [SMI-756: MCP integration tests](https://linear.app/smith-horn-group/issue/SMI-756)
- [SMI-777: Production Database Integration Tests](https://linear.app/smith-horn-group/issue/SMI-777) (Parking Lot)
- [ADR-002: Docker with glibc](002-docker-glibc-requirement.md)
