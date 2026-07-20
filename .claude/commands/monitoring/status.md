# Check Coordination Status

## 🎯 Key Principle
**This tool coordinates Claude Code's actions. It does NOT write code or create content.**

## MCP Tool Usage in Claude Code

**Tool:** `mcp__ruflo__swarm_status`

## Parameters
```json
{
  "swarmId": "current"
}
```

## Description
Monitor the effectiveness of current coordination patterns

## Details
Shows:
- Active coordination topologies
- Current cognitive patterns in use
- Task breakdown and progress
- Resource utilization for coordination
- Overall system health

## Example Usage

**In Claude Code:**
1. Check swarm status: Use tool `mcp__ruflo__swarm_status`
2. Monitor in real-time: Use tool `mcp__claude-flow__swarm_monitor` with parameters `{"interval": 1000}`
3. Get agent metrics: Use tool `mcp__claude-flow__agent_metrics` with parameters `{"agentId": "agent-123"}`
4. Health check: Use tool `mcp__claude-flow__health_check` with parameters `{"components": ["swarm", "memory", "neural"]}`

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
