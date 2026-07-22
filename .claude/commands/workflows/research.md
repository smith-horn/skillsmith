# Research Workflow Coordination

## Purpose
Coordinate Claude Code's research activities for comprehensive, systematic exploration.

## Step-by-Step Coordination

### 1. Initialize Research Framework
```
Tool: mcp__ruflo__swarm_init
Parameters: {"topology": "mesh", "maxAgents": 5, "strategy": "balanced"}
```
Creates a mesh topology for comprehensive exploration from multiple angles.

### 2. Define Research Perspectives
```
Tool: mcp__ruflo__agent_spawn
Parameters: {"agentType": "researcher", "name": "Literature Review"}
```
```
Tool: mcp__ruflo__agent_spawn  
Parameters: {"agentType": "analyst", "name": "Data Analysis"}
```
Sets up different analytical approaches for Claude Code to use.

### 3. Execute Coordinated Research
```
Tool: mcp__ruflo__coordination_orchestrate
Parameters: {
  "task": "Research modern web frameworks performance",
  "strategy": "adaptive",
  "priority": "medium"
}
```

### 4. Store Research Findings
CLI path per H-4/U1 (SMI-5777): `mcp__ruflo__memory_store` is not present in this session's
connected tool discovery, so the default is the CLI form.
```bash
npx -y ruflo@3.14.2 memory store -k "research_findings" --value "framework performance analysis results" -n "research"
```

## What Claude Code Actually Does
1. Uses **WebSearch** tool for finding resources
2. Uses **Read** tool for analyzing documentation
3. Uses **Task** tool for parallel exploration
4. Synthesizes findings using coordination patterns
5. Stores insights in memory for future reference

Remember: The swarm coordinates HOW Claude Code researches, not WHAT it finds.

## CLI Usage
```bash
# Start research workflow via CLI — `research` is a built-in template, not a subcommand
npx -y ruflo@3.14.2 workflow run -t research --task "modern web frameworks"
```

There is no `workflow export` in v3 — no CLI verb, no `workflow_export` MCP tool. The workflow definition file is already the shareable artifact, so the "export research" example is dropped.