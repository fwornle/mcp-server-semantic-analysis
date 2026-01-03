# Common Issues

Frequently encountered problems and their solutions.

## Setup & Configuration

### Issue: MCP Server Not Found in Claude Code

**Symptoms**: Coding agent shows "No MCP servers configured" or doesn't list semantic-analysis

**Causes**:
- MCP configuration file not in correct location
- Syntax error in `mcp.json`
- Build artifacts missing

**Solutions**:
1. Verify MCP config location:
   ```bash
   ls ~/.config/claude-code/mcp.json
   ```

2. Validate JSON syntax:
   ```bash
   cat ~/.config/claude-code/mcp.json | jq .
   ```

3. Rebuild the server:
   ```bash
   cd integrations/mcp-server-semantic-analysis
   npm run build
   ```

### Issue: API Key Not Recognized

**Symptoms**: `Invalid API key` errors despite key being set

**Solutions**:
1. Check key format (no quotes, no spaces):
   ```bash
   echo "$ANTHROPIC_API_KEY" | wc -c  # Should be ~106 characters
   ```

2. Verify key in MCP config:
   ```json
   {
     "env": {
       "ANTHROPIC_API_KEY": "sk-ant-..."
     }
   }
   ```

3. Test key directly:
   ```bash
   curl https://api.anthropic.com/v1/messages \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-version: 2023-06-01" \
     -H "content-type: application/json" \
     -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
   ```

## Analysis Issues

### Issue: Empty or No Results

**Symptoms**: Analysis completes but returns no insights

**Causes**:
- Significance threshold too high
- Analysis depth too low
- Repository has no git history
- Wrong repository path

**Solutions**:
1. Lower significance threshold:
   ```json
   {
     "significanceThreshold": 3
   }
   ```

2. Increase analysis depth:
   ```json
   {
     "depth": 50
   }
   ```

3. Verify repository path:
   ```bash
   cd /path/to/repo && git log --oneline | head
   ```

### Issue: Analysis Timeout

**Symptoms**: Workflow fails with timeout error

**Solutions**:
1. Reduce scope:
   - Lower depth parameter
   - Increase significance threshold
   - Exclude large directories

2. Increase timeout:
   ```typescript
   {
     "timeout": 300000  // 5 minutes
   }
   ```

3. Use incremental analysis mode

### Issue: Duplicate Insights

**Symptoms**: Same insights appear multiple times

**Solutions**:
- Verify deduplication agent is enabled
- Check deduplication threshold settings
- Clear cache and re-run analysis

## Performance Issues

### Issue: High CPU Usage

**Symptoms**: Server uses 100% CPU

**Causes**:
- Large repository analysis
- Too many concurrent agents
- Infinite loop in agent logic

**Solutions**:
1. Limit concurrent agents:
   ```typescript
   {
     "maxConcurrentAgents": 3
   }
   ```

2. Use file filtering:
   ```typescript
   {
     "excludePatterns": ["node_modules/**", "dist/**", "*.min.js"]
   }
   ```

3. Enable CPU throttling

### Issue: Memory Leak

**Symptoms**: Memory usage grows continuously

**Solutions**:
- Restart server periodically
- Enable garbage collection: `--expose-gc`
- Check for circular references in agents
- Review event listener cleanup

## Integration Issues

### Issue: VSCode Extension Not Working

**Symptoms**: CoPilot cannot access semantic analysis features

**Solutions**:
1. Verify HTTP API is running:
   ```bash
   curl http://localhost:8765/health
   ```

2. Check extension is installed and enabled

3. Review extension logs in VSCode output panel

### Issue: UKB Integration Fails

**Symptoms**: Cannot create UKB entities from analysis

**Solutions**:
- Verify UKB path exists
- Check write permissions
- Ensure UKB format is correct
- Validate entity schema

## Data Quality Issues

### Issue: Inaccurate Insights

**Symptoms**: Generated insights don't match codebase reality

**Solutions**:
- Review source data quality
- Adjust LLM temperature (lower for more accuracy)
- Enable quality assurance agent
- Provide more context in prompts

### Issue: Incomplete PlantUML Diagrams

**Symptoms**: Diagrams missing elements or malformed

**Solutions**:
- Check PlantUML syntax in generated files
- Verify all entities are included
- Review diagram complexity limits
- Use simpler diagram types

## Workflow Issues

### Issue: Workflow Stuck

**Symptoms**: Workflow never completes, no error message

**Diagnosis**:
```bash
# Check workflow status
curl http://localhost:8765/api/workflow/status

# Review agent states
curl http://localhost:8765/api/agents
```

**Solutions**:
- Check for deadlocks in dependencies
- Verify all agents respond to heartbeat
- Review workflow definition for cycles
- Enable workflow timeout

### Issue: Agent Dependency Errors

**Symptoms**: Agent fails because dependency not met

**Solutions**:
- Review workflow dependency graph
- Ensure proper agent sequencing
- Check data format between agents
- Validate agent input schemas

## Quick Fixes

| Problem | Quick Fix |
|---------|-----------|
| Server won't start | `npm run clean && npm run build` |
| No results | Lower `significanceThreshold` to 1 |
| Timeout | Reduce `depth` to 10 |
| Memory error | Add `NODE_OPTIONS="--max-old-space-size=4096"` |
| API rate limit | Add delays between requests |
| Git errors | Verify `git` is in PATH |
| Cache issues | Delete `.cache/` directory |
| Wrong results | Clear cache and rebuild |

## See Also

- [Troubleshooting Guide](README.md) - Comprehensive troubleshooting
- [Performance Tuning](performance.md) - Optimization strategies
- [Installation Guide](../installation/README.md) - Setup instructions
