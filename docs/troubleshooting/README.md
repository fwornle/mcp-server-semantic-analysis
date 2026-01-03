# Troubleshooting Guide

Common issues and solutions for the MCP semantic analysis server.

## Installation Issues

### Module Not Found

**Problem**: `Cannot find module '@modelcontextprotocol/sdk'`

**Solution**:
```bash
cd integrations/mcp-server-semantic-analysis
npm install
npm run build
```

### TypeScript Compilation Errors

**Problem**: Type errors during build

**Solution**:
```bash
npm run clean
npm install
npm run build
```

## Runtime Issues

### MCP Server Not Connecting

**Problem**: Coding agent cannot connect to semantic analysis server

**Diagnosis**:
```bash
# Check if server can start
node build/index.js

# Check MCP configuration
cat ~/.config/claude-code/mcp.json
```

**Solution**:
1. Verify build artifacts exist: `ls build/`
2. Check API keys are set: `echo $ANTHROPIC_API_KEY`
3. Review MCP config path in `mcp.json`
4. Restart coding agent

### API Rate Limiting

**Problem**: `429 Too Many Requests` errors

**Solution**:
1. Reduce analysis depth: `depth: 10` instead of `depth: 50`
2. Increase timeout between requests
3. Use caching: `enableCache: true`
4. Consider using fallback provider (OpenAI)

### Memory Issues

**Problem**: `JavaScript heap out of memory`

**Solution**:
```bash
# Increase Node.js memory
NODE_OPTIONS="--max-old-space-size=4096" node build/index.js

# Or reduce analysis scope
analyze_repository {
  "depth": 10,
  "significanceThreshold": 8
}
```

## Agent-Specific Issues

### GitHistoryAgent Errors

**Problem**: Git commands failing

**Solution**:
```bash
# Verify git is available
which git

# Check repository is valid git repo
cd /path/to/repo && git status

# Verify git history exists
git log --oneline | head -10
```

### SemanticAnalysisAgent Timeout

**Problem**: Code analysis timing out on large files

**Solution**:
- Break analysis into smaller chunks
- Increase timeout in configuration
- Use file filtering to exclude large files
- Enable incremental analysis mode

### LLM Provider Errors

**Problem**: `Invalid API key` or `Provider unavailable`

**Solution**:
```bash
# Test API key
curl https://api.anthropic.com/v1/messages \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":10,"messages":[{"role":"user","content":"test"}]}'

# Check environment variables
echo $ANTHROPIC_API_KEY
echo $OPENAI_API_KEY
```

## Workflow Issues

### Workflow Execution Hangs

**Problem**: Workflow never completes

**Diagnosis**:
- Check logs for stuck agent
- Monitor memory usage: `top` or `htop`
- Review workflow dependencies for cycles

**Solution**:
- Set workflow timeout
- Enable verbose logging
- Simplify workflow dependencies

### Incomplete Results

**Problem**: Workflow completes but missing expected outputs

**Solution**:
- Check significance threshold (lower to include more results)
- Verify all agents completed successfully
- Review quality assurance filters
- Check deduplication settings

## Performance Issues

### Slow Analysis

**Problem**: Analysis takes too long

**Optimization**:
1. Enable caching
2. Reduce analysis depth
3. Use parallel execution where possible
4. Filter files by extension
5. Increase significance threshold

### High Memory Usage

**Problem**: Server consuming too much memory

**Solution**:
- Process files in batches
- Clear cache periodically
- Limit concurrent agent execution
- Use streaming for large datasets

## Debugging

### Enable Verbose Logging

```bash
# Set debug environment variable
DEBUG=semantic-analysis:* node build/index.js

# Or in MCP config
{
  "env": {
    "DEBUG": "semantic-analysis:*",
    "LOG_LEVEL": "debug"
  }
}
```

### Inspect Agent Communication

```typescript
coordinator.on('agent-message', (msg) => {
  console.log('Agent message:', msg);
});
```

### Check Workflow State

```bash
# View workflow status
curl http://localhost:8765/api/workflow/status

# Get agent details
curl http://localhost:8765/api/agents
```

## Common Error Messages

### `ENOENT: no such file or directory`
- **Cause**: Invalid repository path
- **Fix**: Use absolute paths or verify relative path is correct

### `Workflow 'X' not found`
- **Cause**: Workflow not registered
- **Fix**: Check workflow name spelling, verify workflow is registered

### `Agent timeout exceeded`
- **Cause**: Agent taking too long
- **Fix**: Increase timeout, reduce scope, or optimize agent logic

### `Invalid schema for tool 'X'`
- **Cause**: Incorrect tool parameters
- **Fix**: Verify parameters match tool schema, check types

## Getting Help

1. Check [Common Issues](common-issues.md)
2. Review [Performance Tuning](performance.md)
3. Enable debug logging and collect logs
4. Create issue with:
   - Error message
   - Steps to reproduce
   - Environment details
   - Debug logs

## See Also

- [Common Issues](common-issues.md) - Frequently encountered problems
- [Performance Tuning](performance.md) - Optimization strategies
- [Installation Guide](../installation/README.md) - Setup instructions
- [API Reference](../api/README.md) - Tool documentation
