# ADR-0001: Use MCP as API Layer

**Status:** Accepted
**Date:** 2025-12-26
**Deciders:** Senior Architect, Product Team

## Context

Claude Discovery Hub needs an API layer to expose functionality to Claude Code. We need to decide how to structure this interface given the constraints:
- Must integrate seamlessly with Claude Code
- Must work in terminal environment
- Must support local-first operation
- Must be extensible for future capabilities

## Decision

Use Anthropic's Model Context Protocol (MCP) as the primary API layer. All functionality will be exposed through MCP tools that Claude Code can invoke.

### MCP Server Structure

Three consolidated MCP servers:
1. **discovery-core** - Search, recommend, install, audit
2. **learning** - Educational content and progress
3. **sync** - Background synchronization

## Consequences

### Positive
- Native integration with Claude Code (no additional setup)
- Protocol alignment with Anthropic's direction
- Automatic tool discovery by Claude
- Structured input/output through JSON schemas

### Negative
- Tied to MCP protocol evolution
- Limited to what MCP can express
- No direct HTTP API for web clients
- Debugging requires MCP-aware tools

### Neutral
- Web frontend will need separate static API or scrape index directly
- VS Code extension will communicate via MCP through Claude Code

## Alternatives Considered

### Alternative 1: REST API
- Standard HTTP endpoints
- Requires running separate server
- Not native to Claude Code experience
- **Rejected:** Additional complexity, not aligned with local-first principle

### Alternative 2: CLI Tool
- Standalone command-line interface
- Could be invoked by Claude Code via bash
- **Rejected:** Extra hop, not as integrated, shell escaping issues

### Alternative 3: Direct File System
- Skills discovered by scanning .claude directories
- No API needed
- **Rejected:** No search capability, no quality scoring, no recommendations

## References

- [Anthropic MCP Documentation](https://code.claude.com/docs/en/mcp)
- [MCP SDK on GitHub](https://github.com/anthropics/anthropic-sdk-mcp)
- [PRD Section 6](../prd-v3.md#6-feature-requirements)
