# List Active Patterns

## 🎯 Key Principle
**This tool coordinates Claude Code's actions. It does NOT write code or create content.**

## MCP Tool Usage in Claude Code

**Tool:** `mcp__ruflo__agent_list`

## Parameters
```json
{
  "swarmId": "current"
}
```

## Description
View all active cognitive patterns and their current focus areas

## Details
Filters:
- **all**: Show all defined patterns
- **active**: Currently engaged patterns
- **idle**: Available but unused patterns
- **busy**: Patterns actively coordinating tasks

## Example Usage

**In Claude Code:**
1. List all agents: Use tool `mcp__ruflo__agent_list`
2. Get specific agent metrics: Use tool `mcp__ruflo__agent_status` (per-agent; no `mcp__ruflo__agent_metrics` MCP tool exists — use `mcp__ruflo__performance_metrics` for a fleet-wide aggregate instead) with parameters `{"agentId": "coder-123"}`
3. Monitor agent performance: Use tool `mcp__ruflo__swarm_status` (point-in-time — v3 has no interval-poll equivalent; call repeatedly)

## Important Reminders
- ✅ This tool provides coordination and structure
- ✅ Claude Code performs all actual implementation
- ❌ The tool does NOT write code
- ❌ The tool does NOT access files directly
- ❌ The tool does NOT execute commands

## See Also
- Main documentation: /CLAUDE.md
- Other commands in this category
- Workflow examples in /workflows/
