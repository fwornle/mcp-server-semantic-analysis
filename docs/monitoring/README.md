# Monitoring

Monitoring and observability for the MCP semantic analysis server.

## Health Checks

### Basic Health Endpoint

```bash
curl http://localhost:8765/health
```

**Response**:
```json
{
  "status": "healthy",
  "uptime": 3600,
  "version": "1.0.0",
  "agents": {
    "total": 11,
    "active": 3,
    "idle": 8
  }
}
```

### Detailed Status

```bash
curl http://localhost:8765/api/status
```

**Response**:
```json
{
  "server": {
    "status": "running",
    "startTime": "2025-01-15T10:00:00Z",
    "uptime": 3600
  },
  "agents": [
    {
      "id": "git-history",
      "status": "idle",
      "lastActivity": "2025-01-15T10:30:00Z",
      "tasksCompleted": 15
    }
  ],
  "resources": {
    "memory": {
      "used": 512000000,
      "total": 4096000000
    },
    "cpu": {
      "usage": 25.5
    }
  }
}
```

## Metrics Collection

### Enable Metrics

**Configuration**:
```typescript
{
  "monitoring": {
    "enabled": true,
    "interval": 60000,  // 1 minute
    "endpoint": "http://localhost:9090/metrics"
  }
}
```

### Prometheus Integration

**Metrics exposed**:
- `semantic_analysis_requests_total` - Total requests
- `semantic_analysis_duration_seconds` - Request duration
- `semantic_analysis_errors_total` - Error count
- `semantic_analysis_cache_hits_total` - Cache hits
- `semantic_analysis_agent_tasks_total` - Tasks per agent

**Prometheus config**:
```yaml
scrape_configs:
  - job_name: 'semantic-analysis'
    static_configs:
      - targets: ['localhost:8765']
    metrics_path: '/metrics'
```

## Logging

### Log Levels

- `error`: Errors requiring attention
- `warn`: Warning conditions
- `info`: Informational messages
- `debug`: Detailed debugging information
- `trace`: Very detailed tracing

### Configuration

```typescript
{
  "logging": {
    "level": "info",
    "format": "json",
    "destination": "logs/semantic-analysis.log",
    "rotation": {
      "maxSize": "100m",
      "maxFiles": 10
    }
  }
}
```

### Structured Logging

```typescript
logger.info('Analysis started', {
  workflow: 'repository-analysis',
  repository: '/path/to/repo',
  depth: 25,
  userId: 'user123'
});
```

## Alerting

### Critical Alerts

**Memory threshold**:
```typescript
{
  "alerts": {
    "memory": {
      "threshold": 90,  // percentage
      "action": "restart"
    }
  }
}
```

**Error rate**:
```typescript
{
  "alerts": {
    "errorRate": {
      "threshold": 5,  // per minute
      "window": 300,   // 5 minutes
      "action": "notify"
    }
  }
}
```

### Notification Channels

**Slack**:
```typescript
{
  "notifications": {
    "slack": {
      "webhook": "https://hooks.slack.com/...",
      "channel": "#alerts"
    }
  }
}
```

**Email**:
```typescript
{
  "notifications": {
    "email": {
      "smtp": "smtp.example.com",
      "recipients": ["team@example.com"]
    }
  }
}
```

## Performance Monitoring

### Response Time Tracking

```typescript
coordinator.on('workflow-complete', (event) => {
  const duration = event.endTime - event.startTime;
  metrics.recordDuration('workflow', event.name, duration);
});
```

### Resource Usage

```typescript
setInterval(() => {
  const usage = process.memoryUsage();
  metrics.gauge('memory.rss', usage.rss);
  metrics.gauge('memory.heapUsed', usage.heapUsed);

  const cpuUsage = process.cpuUsage();
  metrics.gauge('cpu.user', cpuUsage.user);
  metrics.gauge('cpu.system', cpuUsage.system);
}, 10000);
```

## Dashboards

### Grafana Dashboard

**Key panels**:
1. Request rate (requests/second)
2. Response time (p50, p95, p99)
3. Error rate (errors/minute)
4. Cache hit rate (%)
5. Memory usage (MB)
6. CPU usage (%)
7. Active agents
8. Workflow success rate

**Import dashboard**:
```bash
curl -X POST http://localhost:3000/api/dashboards/db \
  -H "Content-Type: application/json" \
  -d @grafana-dashboard.json
```

### Custom Dashboard

Create a simple web dashboard:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Semantic Analysis Monitor</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <canvas id="metricsChart"></canvas>
  <script>
    fetch('http://localhost:8765/api/metrics')
      .then(r => r.json())
      .then(data => renderChart(data));
  </script>
</body>
</html>
```

## Tracing

### Distributed Tracing

**OpenTelemetry integration**:
```typescript
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('semantic-analysis');

const span = tracer.startSpan('analyze-repository');
try {
  // Analysis logic
  span.setStatus({ code: SpanStatusCode.OK });
} catch (error) {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.recordException(error);
} finally {
  span.end();
}
```

### Trace Visualization

View traces in Jaeger:
```bash
# Start Jaeger
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

# Open UI
open http://localhost:16686
```

## Debugging

### Debug Mode

```bash
DEBUG=semantic-analysis:* node build/index.js
```

### Request Tracing

```typescript
coordinator.on('agent-message', (msg) => {
  console.log(`[${msg.timestamp}] ${msg.agentId}: ${msg.type}`);
});
```

### Workflow Visualization

```bash
# Generate workflow graph
curl http://localhost:8765/api/workflow/graph > workflow.dot
dot -Tpng workflow.dot > workflow.png
```

## Best Practices

1. **Always monitor**:
   - Error rates
   - Response times
   - Resource usage
   - Cache hit rates

2. **Set up alerts for**:
   - High error rates
   - Memory leaks
   - Slow responses
   - Agent failures

3. **Regular reviews**:
   - Weekly metric reviews
   - Monthly performance audits
   - Quarterly capacity planning

4. **Incident response**:
   - Document runbooks
   - Define escalation paths
   - Practice incident drills

## See Also

- [Troubleshooting](../troubleshooting/README.md) - Problem resolution
- [Performance Tuning](../troubleshooting/performance.md) - Optimization
- [Installation Guide](../installation/README.md) - Setup instructions
