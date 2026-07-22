# Development Workflow Coordination

## Purpose
Structure Claude Code's approach to complex development tasks for maximum efficiency.

## Step-by-Step Coordination

### 1. Initialize Development Framework
```
Tool: mcp__ruflo__swarm_init
Parameters: {"topology": "hierarchical", "maxAgents": 8, "strategy": "specialized"}
```
Creates hierarchical structure for organized, top-down development.

### 2. Define Development Perspectives
```
Tool: mcp__ruflo__agent_spawn
Parameters: {
  "agentType": "architect",
  "name": "System Design",
  "capabilities": ["api-design", "database-schema"]
}
```
```
Tool: mcp__ruflo__agent_spawn
Parameters: {
  "agentType": "coder",
  "name": "Implementation Focus",
  "capabilities": ["nodejs", "typescript", "express"]
}
```
```
Tool: mcp__ruflo__agent_spawn
Parameters: {
  "agentType": "tester",
  "name": "Quality Assurance",
  "capabilities": ["unit-testing", "integration-testing"]
}
```
Sets up architectural and implementation thinking patterns.

### 3. Coordinate Implementation
```
Tool: mcp__ruflo__coordination_orchestrate
Parameters: {
  "task": "Build REST API with authentication",
  "strategy": "parallel",
  "priority": "high",
  "dependencies": ["database setup", "auth system"]
}
```

### 4. Monitor Progress
```
Tool: mcp__ruflo__task_status
Parameters: {"taskId": "api-build-task-123"}
```

## What Claude Code Actually Does
1. Uses **Write** tool to create new files
2. Uses **Edit/MultiEdit** tools for code modifications
3. Uses **Bash** tool for testing and building
4. Uses **TodoWrite** tool for task tracking
5. Follows coordination patterns for systematic implementation

Remember: All code is written by Claude Code using its native tools!

## CLI Usage
```bash
# Start development workflow via CLI — `dev` is not a subcommand; `development` is a built-in template
npx -y ruflo@3.14.2 workflow run -t development --task "REST API with auth"

# Define stages in a workflow file, then register it as a template
# (old: workflow create --name "api-dev" --steps "..." — no --steps flag, no `create` verb)
workflow template create -n api-dev -f ./api-dev.yaml
# or just validate it first: workflow validate -f ./api-dev.yaml

# Run the saved workflow (old: workflow execute api-dev — no name-addressing)
workflow run -f ./api-dev.yaml
```