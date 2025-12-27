# ADR-001: Monorepo Structure with npm Workspaces

**Status**: Accepted
**Date**: 2025-12-27
**Deciders**: Skillsmith Team

## Context

Skillsmith needs to deliver multiple packages:
- Core library (database, repositories, services)
- MCP server (Claude Code integration)
- CLI tool (command-line interface)

We needed to decide how to structure the codebase for development efficiency and release management.

## Decision

Use a monorepo with npm workspaces containing three packages:

```
packages/
├── core/        # @skillsmith/core
├── mcp-server/  # @skillsmith/mcp-server
└── cli/         # @skillsmith/cli
```

## Consequences

### Positive
- Shared development environment and tooling
- Atomic commits across packages
- Easy local development with workspace references
- Single CI/CD pipeline

### Negative
- More complex build ordering (core must build before dependents)
- Larger initial clone size
- Need to manage inter-package dependencies carefully

### Neutral
- Each package still published independently to npm
- TypeScript project references handle build ordering

## Alternatives Considered

### Alternative 1: Separate Repositories
- Pros: Independent release cycles, simpler per-repo
- Cons: Harder to coordinate changes, more CI complexity
- Why rejected: Too much overhead for a small team

### Alternative 2: Single Package
- Pros: Simplest structure
- Cons: Forces users to install everything, harder to maintain
- Why rejected: Different use cases need different packages

## References

- [npm Workspaces](https://docs.npmjs.com/cli/v7/using-npm/workspaces)
- [TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references.html)
