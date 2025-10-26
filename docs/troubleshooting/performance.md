# Performance Tuning

Optimization strategies for the MCP semantic analysis server.

## Performance Metrics

### Baseline Performance

Typical performance on a mid-range development machine:

| Operation | Repository Size | Time | Memory |
|-----------|----------------|------|--------|
| Git analysis | 1K commits | 30s | 200MB |
| Code analysis | 100 files | 45s | 300MB |
| Complete workflow | Medium repo | 2-3min | 500MB |
| Pattern extraction | 50 files | 15s | 150MB |

## Optimization Strategies

### 1. Caching

**Enable persistent caching**:
```typescript
{
  "enableCache": true,
  "cacheDir": ".cache/semantic-analysis",
  "cacheTTL": 3600  // 1 hour
}
```

**Benefits**:
- 10-100x faster for repeated analyses
- Reduced API calls
- Lower costs

**Considerations**:
- Disk space usage
- Cache invalidation strategy
- Stale data risk

### 2. Parallel Execution

**Configure concurrency**:
```typescript
{
  "maxConcurrentAgents": 4,
  "maxConcurrentTasks": 8
}
```

**Optimal settings by machine**:
- **2-core CPU**: `maxConcurrentAgents: 2`
- **4-core CPU**: `maxConcurrentAgents: 4`
- **8+ core CPU**: `maxConcurrentAgents: 6-8`

**CPU-bound vs I/O-bound**:
- Git operations: I/O-bound, more parallelism
- LLM calls: Rate-limited, less parallelism
- File parsing: CPU-bound, match CPU cores

### 3. Scope Reduction

**Filter files**:
```typescript
{
  "includePatterns": ["src/**/*.ts", "lib/**/*.ts"],
  "excludePatterns": [
    "node_modules/**",
    "**/*.test.ts",
    "**/*.spec.ts",
    "dist/**",
    "build/**",
    "*.min.js"
  ]
}
```

**Adjust depth**:
```typescript
{
  "depth": 10,  // Instead of 50
  "significanceThreshold": 8  // Instead of 3
}
```

**Impact**:
- **Depth 10 vs 50**: 5x faster, 80% reduction in results
- **Threshold 8 vs 3**: 3x faster, 70% reduction in results

### 4. Incremental Analysis

**Enable incremental mode**:
```typescript
{
  "incremental": true,
  "lastAnalysisTimestamp": "2025-01-15T10:00:00Z"
}
```

**Strategy**:
- Analyze only files changed since last run
- Use git diff to identify changed files
- Merge with previous results

**Performance gain**: 90-95% time reduction on subsequent runs

### 5. Batching

**Process files in batches**:
```typescript
{
  "batchSize": 10,
  "batchDelay": 100  // ms between batches
}
```

**Benefits**:
- Reduced memory peaks
- Better rate limit handling
- More consistent performance

### 6. Memory Management

**Node.js memory settings**:
```bash
NODE_OPTIONS="--max-old-space-size=4096 --max-semi-space-size=64"
```

**Garbage collection**:
```bash
NODE_OPTIONS="--expose-gc --gc-interval=100"
```

**Stream large files**:
```typescript
// Instead of loading entire file
const stream = fs.createReadStream(filePath);
// Process line by line
```

### 7. API Optimization

**Request batching**:
```typescript
{
  "batchLLMRequests": true,
  "maxBatchSize": 5
}
```

**Smart retries**:
```typescript
{
  "retryStrategy": "exponential",
  "maxRetries": 3,
  "retryDelay": 1000,
  "retryBackoff": 2.0
}
```

**Rate limiting**:
```typescript
{
  "rateLimit": {
    "requestsPerMinute": 50,
    "tokensPerMinute": 80000
  }
}
```

## Performance Monitoring

### Enable Metrics

```typescript
coordinator.on('metrics', (metrics) => {
  console.log({
    duration: metrics.duration,
    filesProcessed: metrics.filesProcessed,
    apiCalls: metrics.apiCalls,
    cacheHitRate: metrics.cacheHitRate,
    memoryUsage: process.memoryUsage()
  });
});
```

### Key Metrics to Track

- **Analysis duration**: Total time per workflow
- **Files processed**: Throughput rate
- **API calls**: Count and costs
- **Cache hit rate**: Effectiveness of caching
- **Memory usage**: Peak and average
- **Error rate**: Failed operations

### Profiling

**CPU profiling**:
```bash
node --prof build/index.js
node --prof-process isolate-*.log > profile.txt
```

**Memory profiling**:
```bash
node --inspect build/index.js
# Connect with Chrome DevTools
```

**Flamegraphs**:
```bash
npm install -g 0x
0x build/index.js
```

## Configuration Recommendations

### Small Repositories (<100 files)

```json
{
  "depth": 50,
  "significanceThreshold": 3,
  "maxConcurrentAgents": 2,
  "enableCache": true
}
```

### Medium Repositories (100-1000 files)

```json
{
  "depth": 25,
  "significanceThreshold": 5,
  "maxConcurrentAgents": 4,
  "enableCache": true,
  "batchSize": 20
}
```

### Large Repositories (>1000 files)

```json
{
  "depth": 10,
  "significanceThreshold": 7,
  "maxConcurrentAgents": 6,
  "enableCache": true,
  "incremental": true,
  "batchSize": 50,
  "excludePatterns": ["tests/**", "docs/**"]
}
```

## Troubleshooting Performance

### Symptom: Slow Analysis

**Diagnosis**:
1. Check CPU usage: `top`
2. Check memory: `ps aux | grep node`
3. Review logs for bottlenecks
4. Profile with `--prof`

**Solutions**:
- Reduce scope
- Enable caching
- Increase parallelism
- Use incremental mode

### Symptom: High Memory Usage

**Diagnosis**:
```bash
# Monitor memory over time
watch -n 1 'ps aux | grep node | grep -v grep'
```

**Solutions**:
- Process in smaller batches
- Clear cache periodically
- Reduce concurrent agents
- Use streaming for large files

### Symptom: API Rate Limiting

**Diagnosis**:
- Count 429 errors in logs
- Monitor requests per minute

**Solutions**:
- Reduce parallelism
- Add delays between requests
- Use request batching
- Enable caching to reduce API calls

## Benchmarking

### Performance Test

```bash
# Run with timing
time node build/index.js analyze-repository \
  --repository /path/to/repo \
  --depth 25 \
  --significance 6

# Compare configurations
./scripts/benchmark.sh --config fast
./scripts/benchmark.sh --config balanced
./scripts/benchmark.sh --config thorough
```

### Load Testing

```bash
# Simulate concurrent workflows
for i in {1..10}; do
  curl -X POST http://localhost:8765/api/workflow/execute &
done
wait
```

## See Also

- [Common Issues](common-issues.md) - Troubleshooting guide
- [Architecture Overview](../architecture/README.md) - System design
- [Installation Guide](../installation/README.md) - Setup instructions
