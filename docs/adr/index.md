# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Skillsmith project.

## What are ADRs?

ADRs document significant architectural decisions made during the project. They provide context for why decisions were made and help future developers understand the rationale.

## ADR Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [ADR-001](001-monorepo-structure.md) | Monorepo Structure with npm Workspaces | Accepted | 2025-12-27 |
| [ADR-002](002-docker-glibc-requirement.md) | Docker with glibc for Native Module Compatibility | Accepted | 2025-12-27 |

## Template

New ADRs should follow the template in [000-template.md](000-template.md).

## Creating a New ADR

1. Copy `000-template.md` to `NNN-short-title.md`
2. Fill in all sections
3. Add entry to this index
4. Create Linear issue if needed

## Related Documents

- [Engineering Standards](../architecture/standards.md)
- [Phase Retrospectives](../retros/)
- [CLAUDE.md](../../CLAUDE.md)
