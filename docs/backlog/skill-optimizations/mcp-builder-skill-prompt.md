# MCP Builder Skill Upgrade Prompt

**Purpose:** Use this prompt in Claude Code to create or upgrade an MCP builder skill that intelligently evaluates whether a task should be implemented as a Skill with scripts or as an MCP server, then generates the appropriate implementation.

---

## Prompt

```
I need to create an MCP builder skill that serves as an intelligent decision engine for choosing between Skills (with scripts) and MCP servers when extending Claude's capabilities. Based on research comparing these approaches, the skill should evaluate requirements and generate the appropriate implementation.

## Core Capability

When a user describes a task or integration they want to build, this skill should:

1. **Analyze the requirements** against a decision framework
2. **Recommend the optimal approach** (Skill, MCP, or Hybrid)
3. **Generate the implementation** for the recommended approach
4. **Provide migration guidance** if the initial choice proves suboptimal

## Decision Framework to Implement

The skill should evaluate these criteria and score each dimension:

### Evaluation Criteria

| Criterion | Favors Skill + Script | Favors MCP Server |
|-----------|----------------------|-------------------|
| **Task Repeatability** | Same operation performed frequently | Dynamic, exploratory operations |
| **Data Freshness** | Point-in-time data acceptable | Real-time data required |
| **Token Sensitivity** | Budget constrained, cost-sensitive | Flexible budget, large context |
| **Reliability Needs** | High (deterministic execution required) | Moderate (can handle retries) |
| **Maintenance Capacity** | Limited ops resources | DevOps team available |
| **Integration Scope** | Single API/service | Multiple enterprise systems |
| **Discovery Needs** | Known, stable capabilities | Dynamic tool discovery needed |
| **Auth Complexity** | Simple (API key, bearer token) | Complex (OAuth, SSO, enterprise) |

### Scoring Logic

For each criterion, assign:
- **+2**: Strongly favors this approach
- **+1**: Slightly favors this approach
- **0**: Neutral
- **-1**: Slightly disfavors this approach
- **-2**: Strongly disfavors this approach

**Decision Thresholds:**
- Score ≥ 6 for Skills: Implement as Skill with scripts
- Score ≥ 6 for MCP: Implement as MCP server
- Mixed scores: Recommend Hybrid approach

### Automatic Disqualifiers

**Must use MCP if:**
- Real-time streaming data is required
- Dynamic tool discovery is essential
- Enterprise SSO/OAuth integration is mandated
- Multi-system orchestration with shared state

**Must use Skill if:**
- Token budget is severely constrained (<10K available)
- Deterministic, auditable execution is required
- No DevOps capacity for server management
- Operation is highly repetitive (>10x daily)

## Output Templates

### If Skill is Recommended

Generate a complete skill package:

```
.claude/skills/[task-name]/
├── SKILL.md
├── scripts/
│   └── [operation].py (or .sh, .js)
└── references/
    └── api-docs.md (if needed)
```

**SKILL.md Template:**
```yaml
---
name: [task-name]
description: [What it does]. Use when [trigger conditions].
allowed-tools: Read, Bash, Write
---

# [Task Name]

## Overview
[Brief description of capability]

## Usage

### Quick Start
[Primary use case with example]

### Scripts

**[script-name].py**: [Description]
```bash
python scripts/[script-name].py [args]
```

Output format:
```json
{
  "status": "success|error",
  "result": {...},
  "metadata": {...}
}
```

## Configuration

### Environment Variables
- `[SERVICE]_API_KEY`: API authentication
- `[SERVICE]_BASE_URL`: API endpoint (optional override)

### Error Handling
[Common errors and resolution steps]
```

**Script Template (Python):**
```python
#!/usr/bin/env python3
"""
[Task description]
Usage: python [script].py [args]
"""

import os
import sys
import json
import requests
from typing import Optional

def main(arg1: str, arg2: Optional[str] = None) -> dict:
    """
    [Function description]
    
    Args:
        arg1: [Description]
        arg2: [Description]
    
    Returns:
        dict with status, result, and metadata
    """
    api_key = os.environ.get('[SERVICE]_API_KEY')
    if not api_key:
        return {"status": "error", "message": "Missing API key"}
    
    try:
        # Implementation here
        response = requests.get(
            f"https://api.example.com/endpoint",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30
        )
        response.raise_for_status()
        
        return {
            "status": "success",
            "result": response.json(),
            "metadata": {"source": "api", "timestamp": "..."}
        }
    except requests.RequestException as e:
        return {"status": "error", "message": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"status": "error", "message": "Usage: script.py <arg1> [arg2]"}))
        sys.exit(1)
    
    result = main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    print(json.dumps(result, indent=2))
```

### If MCP is Recommended

Generate MCP server scaffolding:

```
[task-name]-mcp/
├── src/
│   └── index.ts (or server.py)
├── package.json (or pyproject.toml)
├── README.md
└── .claude/
    └── skills/
        └── [task-name]-patterns/
            └── SKILL.md  # Companion skill for efficient usage
```

**Include in output:**
1. Server implementation with tool definitions
2. Configuration instructions for Claude Code
3. Companion skill for common query patterns (hybrid approach)
4. Token budget estimates

**MCP Configuration Template:**
```json
{
  "mcpServers": {
    "[task-name]": {
      "command": "node",
      "args": ["path/to/server/dist/index.js"],
      "env": {
        "[SERVICE]_API_KEY": "${[SERVICE]_API_KEY}"
      }
    }
  }
}
```

**Companion Skill Template (for hybrid):**
```yaml
---
name: [task-name]-patterns
description: Optimized patterns for [task] queries. Use before calling [task] MCP.
---

# [Task Name] Query Patterns

## Before querying:
1. [Pre-check step]
2. [Optimization step]
3. [Filter/limit step]

## Common Patterns

### [Pattern 1 Name]
```
[Optimized query format]
```

### [Pattern 2 Name]
```
[Optimized query format]
```

## Token Optimization
- Limit results to [N] unless pagination needed
- Select only required fields: [field1, field2]
- Apply filters: [common filters]
```

### If Hybrid is Recommended

Generate both components with clear separation:

1. **MCP server** for discovery and dynamic operations
2. **Skill** for codified, repeatable patterns
3. **Migration guide** for moving patterns from MCP to Skill

## Evaluation Report Format

Before generating implementation, output an evaluation report:

```markdown
## Integration Evaluation: [Task Name]

### Requirements Analysis
- **Task Type**: [Repeatable workflow | Dynamic exploration | Mixed]
- **Data Freshness**: [Real-time required | Point-in-time acceptable]
- **Token Budget**: [Constrained | Flexible]
- **Reliability**: [Critical | Standard]
- **Maintenance**: [Self-service | DevOps supported]

### Scoring

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Repeatability | [+2 to -2] | [Why] |
| Data Freshness | [+2 to -2] | [Why] |
| Token Sensitivity | [+2 to -2] | [Why] |
| Reliability | [+2 to -2] | [Why] |
| Maintenance | [+2 to -2] | [Why] |
| Integration Scope | [+2 to -2] | [Why] |
| Discovery Needs | [+2 to -2] | [Why] |
| Auth Complexity | [+2 to -2] | [Why] |

**Skill Score**: [Sum of positive skill indicators]
**MCP Score**: [Sum of positive MCP indicators]

### Recommendation
**[SKILL | MCP | HYBRID]**: [Rationale in 2-3 sentences]

### Token Impact Estimate
- Skill approach: ~[N] tokens per invocation
- MCP approach: ~[N] tokens startup + ~[N] per operation
- Projected savings: [X]% with recommended approach

### Implementation follows below...
```

## Additional Requirements

### For Skills Generated

1. **Always include structured output**: Scripts should return JSON with status, result, metadata
2. **Handle errors gracefully**: Return error status, don't crash
3. **Document environment variables**: List all required configuration
4. **Set appropriate timeouts**: Default 30s for API calls
5. **Make scripts executable**: Include shebang, proper permissions note

### For MCP Servers Generated

1. **Minimize tool definitions**: Keep descriptions concise (<100 tokens per tool)
2. **Include health checks**: Provide connection validation
3. **Document token overhead**: Estimate context consumption
4. **Provide companion skill**: Always generate hybrid pattern skill
5. **Include timeout configuration**: Document MCP_TIMEOUT settings

### For Hybrid Patterns

1. **Clear separation**: Which operations use MCP vs Skill
2. **Migration path**: How to move patterns from MCP to Skill
3. **Token monitoring**: How to evaluate if hybrid is working

## Example Interaction

**User**: "I need to query our Salesforce CRM to get contact information for sales follow-ups. We do this about 20 times per day with similar queries."

**Skill Response**:

```
## Integration Evaluation: Salesforce Contact Queries

### Requirements Analysis
- **Task Type**: Repeatable workflow (20x daily, similar queries)
- **Data Freshness**: Point-in-time acceptable (sales follow-up)
- **Token Budget**: Not specified, assume standard
- **Reliability**: Standard (can retry failed queries)
- **Maintenance**: Not specified, assume limited

### Scoring

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Repeatability | +2 (Skill) | 20x daily with similar patterns |
| Data Freshness | +1 (Skill) | Follow-up data doesn't need real-time |
| Token Sensitivity | +1 (Skill) | High volume benefits from efficiency |
| Reliability | 0 | Standard for both approaches |
| Maintenance | +1 (Skill) | Scripts simpler than MCP server |
| Integration Scope | +1 (Skill) | Single system (Salesforce) |
| Discovery Needs | -1 (MCP) | May need to explore new query patterns |
| Auth Complexity | 0 | OAuth manageable in both |

**Skill Score**: 6
**MCP Score**: 1

### Recommendation
**SKILL**: High repetition (20x/day) with similar query patterns strongly favors 
a skill-based approach. The token savings will be substantial, and deterministic 
execution ensures consistent results. Include a script that handles Salesforce 
OAuth and common query patterns.

### Token Impact Estimate
- Skill approach: ~800 tokens per query
- MCP approach: ~12,000 tokens startup + ~1,500 per query
- Projected savings: 93% on first query, 47% on subsequent queries

### Implementation

[Generate complete Salesforce contact query skill with OAuth handling script]
```

## Deliverables

1. Create the MCP builder skill with the decision framework above
2. Include the evaluation report template
3. Include output templates for Skill, MCP, and Hybrid
4. Provide example scripts in Python (primary) and Bash (alternative)
5. Test with 3 sample scenarios:
   - High-repetition API task (should recommend Skill)
   - Real-time data exploration task (should recommend MCP)
   - Mixed requirements task (should recommend Hybrid)
```

---

## Usage Instructions

1. Open Claude Code in your skills repository
2. Paste the prompt above
3. Review the generated skill structure
4. Test with sample integration requests
5. Iterate on the decision framework weights if needed

## Expected Outputs

After running this prompt, your MCP builder skill should:

```
.claude/skills/mcp-builder/
├── SKILL.md                    # Main decision engine
├── templates/
│   ├── skill-template.md       # Skill generation template
│   ├── mcp-template.md         # MCP generation template
│   └── hybrid-template.md      # Hybrid generation template
├── scripts/
│   ├── evaluate.py             # Scoring logic
│   └── generate.py             # Template generation
└── examples/
    ├── skill-example/          # Sample skill output
    ├── mcp-example/            # Sample MCP output
    └── hybrid-example/         # Sample hybrid output
```

## Validation Checklist

After creation, verify the skill:

- [ ] Correctly identifies high-repetition tasks → recommends Skill
- [ ] Correctly identifies real-time needs → recommends MCP
- [ ] Correctly identifies mixed requirements → recommends Hybrid
- [ ] Generates working script templates with error handling
- [ ] Includes token impact estimates in evaluation
- [ ] Produces companion skills for MCP recommendations
- [ ] Documents all environment variables and configuration
