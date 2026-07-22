# Token Usage Optimization

## Purpose
Reduce token consumption while maintaining quality through intelligent coordination.

## Optimization Strategies

### 1. Smart Caching
- Search results cached for 5 minutes
- File content cached during session
- Pattern recognition reduces redundant searches

### 2. Efficient Coordination
- Agents share context automatically
- Avoid duplicate file reads
- Batch related operations

### 3. Measurement & Tracking

There is no `mcp__ruflo__token_usage` tool. Check savings via the CLI, or the learning-metrics MCP tool:

```bash
# Check token savings after session
npx -y ruflo@3.14.2 hooks token-optimize --stats
```

```javascript
// Equivalent MCP form
mcp__ruflo__hooks_metrics({
  "period": "24h",
  "includeV3": true
})
```

## Best Practices
1. **Use Task tool** for complex searches
2. **Enable caching** in pre-search hooks
3. **Batch operations** when possible
4. **Review session summaries** for insights

## Token Reduction Results
- 📉 32.3% average token reduction
- 🎯 More focused operations
- 🔄 Intelligent result reuse
- 📊 Cumulative improvements