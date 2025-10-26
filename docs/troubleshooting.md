# Troubleshooting

Quick troubleshooting guide for the MCP semantic analysis server.

For comprehensive troubleshooting, see the [detailed troubleshooting guide](troubleshooting/README.md).

## Quick Fixes

| Problem | Solution |
|---------|----------|
| Server won't start | `npm run clean && npm run build` |
| No results returned | Lower `significanceThreshold` to 1 |
| Analysis timeout | Reduce `depth` parameter to 10 |
| Memory error | `NODE_OPTIONS="--max-old-space-size=4096"` |
| API rate limit | Reduce `maxConcurrentAgents` |
| Git command fails | Check `git` is in PATH |
| Cache issues | Delete `.cache/` directory |

## Common Issues

### MCP Server Not Connecting
```bash
# Verify build
cd integrations/mcp-server-semantic-analysis
npm run build
ls build/

# Check API key
echo $ANTHROPIC_API_KEY

# Test manually
node build/index.js
```

### Empty Analysis Results
```json
{
  "depth": 50,
  "significanceThreshold": 1
}
```

### Performance Issues
- Enable caching
- Reduce scope with file filters
- Lower depth parameter
- Increase significance threshold

## Getting Help

1. Check [Common Issues](troubleshooting/common-issues.md)
2. Review [Performance Tuning](troubleshooting/performance.md)
3. Enable debug logging: `DEBUG=semantic-analysis:*`
4. Collect logs and create issue

## See Also

- [Troubleshooting Guide](troubleshooting/README.md) - Comprehensive guide
- [Common Issues](troubleshooting/common-issues.md) - Frequent problems
- [Performance](troubleshooting/performance.md) - Optimization strategies
