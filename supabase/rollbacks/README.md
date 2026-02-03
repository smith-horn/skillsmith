# Database Rollback Scripts

**Encryption**: These files are intentionally **NOT encrypted** to enable fast incident response.

## Usage

Run rollback manually via Supabase CLI:

```bash
supabase db execute --file supabase/rollbacks/NNN_description_down.sql
```

## Why Unencrypted?

- **Incident Response**: Emergency rollbacks must be accessible without git-crypt setup
- **No Secrets**: These files contain only schema DDL (no credentials or keys)
- **Public IP**: Schema is already exposed via API docs and migrations
- **CI/CD Compatible**: Enables future rollback testing automation

See [ADR-108](../../docs/adr/108-no-encrypt-rollbacks.md) for decision rationale.

## File Naming Convention

Rollback files follow the pattern: `NNN_description_down.sql`

- `NNN` matches the corresponding migration number in `supabase/migrations/`
- `_down` suffix indicates this reverses the migration
- Each rollback should be tested before committing

## Warnings

Some rollback scripts contain **data loss warnings**. Always:

1. Read the script comments before executing
2. Take a database backup if the script warns about data loss
3. Test in staging environment first when possible
