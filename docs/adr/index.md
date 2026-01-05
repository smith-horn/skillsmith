# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Skillsmith project.

## What are ADRs?

ADRs document significant architectural decisions made during the project. They provide context for why decisions were made and help future developers understand the rationale.

## ADR Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [ADR-001](001-monorepo-structure.md) | Monorepo Structure with npm Workspaces | Accepted | 2025-12-27 |
| [ADR-002](002-docker-glibc-requirement.md) | Docker with glibc for Native Module Compatibility | Accepted (Updated) | 2025-12-27 (Updated: 2026-01-03) |
| [ADR-003](003-claude-flow-integration.md) | Claude-flow Integration for Technical Risk Mitigation | Accepted | 2025-12-27 |
| [ADR-004](004-docker-guard-hook.md) | Docker Guard Hook for Daemon Timeout Protection | Accepted | 2025-12-28 |
| [ADR-005](005-vscode-mcp-client.md) | VS Code Extension MCP Client Architecture | Accepted | 2025-12-28 |
| [ADR-006](006-coverage-threshold-strategy.md) | Test Coverage Threshold Strategy | Accepted | 2025-12-28 |
| [ADR-008](008-security-hardening-phase.md) | Security Hardening Phase (Phase 2d) | Accepted | 2025-12-29 |
| [ADR-009](009-embedding-service-fallback.md) | Embedding Service Fallback Strategy | Accepted | 2025-12-30 |
| [ADR-010](010-codebase-analysis-scope.md) | Codebase Analysis Scope (TS/JS Only) | Accepted | 2025-12-30 |
| [ADR-011](011-integration-test-database.md) | Integration Test Database Strategy | Accepted | 2025-12-30 |
| [ADR-012](012-native-module-version-management.md) | Native Module Version Management Strategy | Accepted | 2025-12-31 |
| [ADR-013](013-open-core-licensing.md) | Open Core Licensing Model | Accepted | 2026-01-02 |
| [ADR-014](014-enterprise-package-architecture.md) | Enterprise Package Architecture | Accepted | 2026-01-02 |
| [ADR-015](015-immutable-audit-log-storage.md) | Immutable Audit Log Storage with SHA-256 Hash Chains | Accepted | 2026-01-04 |

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
