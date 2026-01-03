# Integration Patterns

Guide to integrating the MCP semantic analysis server with various AI assistants and development environments.

## Coding Agent Integration

### MCP Configuration

Add to your coding agent MCP settings (e.g., `~/.config/claude-code/mcp.json`):

```json
{
  "mcpServers": {
    "semantic-analysis": {
      "command": "node",
      "args": ["/path/to/coding/integrations/mcp-server-semantic-analysis/build/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key-here"
      }
    }
  }
}
```

### Usage in Coding Agent

```
# Repository analysis
execute_workflow {
  "workflow_name": "repository-analysis",
  "parameters": {
    "repository": ".",
    "depth": 25,
    "significanceThreshold": 6
  }
}

# Code analysis
analyze_code {
  "code": "class MyClass { ... }",
  "language": "typescript",
  "analysis_focus": "patterns"
}
```

## VSCode CoPilot Integration

### HTTP API Proxy

The system provides an HTTP API proxy for CoPilot integration:

```bash
# Start the HTTP proxy
npm run api  # Port 8765
```

### API Endpoints

**Analyze Repository**:
```bash
curl -X POST http://localhost:8765/api/semantic/analyze-repository \
  -H "Content-Type: application/json" \
  -d '{
    "repository": ".",
    "depth": 25,
    "significanceThreshold": 6
  }'
```

**Analyze Code**:
```bash
curl -X POST http://localhost:8765/api/semantic/analyze-code \
  -H "Content-Type: application/json" \
  -d '{
    "code": "function example() { ... }",
    "language": "javascript"
  }'
```

**Execute Workflow**:
```bash
curl -X POST http://localhost:8765/api/semantic/execute-workflow \
  -H "Content-Type: application/json" \
  -d '{
    "workflow_name": "complete-analysis",
    "parameters": {}
  }'
```

## Direct Node.js Integration

### Import as Module

```typescript
import { SemanticAnalysisServer } from './src/server';

const server = new SemanticAnalysisServer({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY
});

await server.start();
```

### Programmatic API

```typescript
import { CoordinatorAgent } from './src/agents/coordinator';

const coordinator = new CoordinatorAgent({
  repository: '/path/to/repo',
  depth: 25,
  significanceThreshold: 6
});

const results = await coordinator.executeWorkflow('repository-analysis');
```

## Multi-Agent Orchestration

### Workflow Definition

```typescript
interface WorkflowDefinition {
  name: string;
  agents: AgentConfig[];
  dependencies: AgentDependency[];
  outputs: OutputConfig;
}

const customWorkflow: WorkflowDefinition = {
  name: 'custom-analysis',
  agents: [
    { type: 'git-history', config: {...} },
    { type: 'semantic-analysis', config: {...} },
    { type: 'insight-generation', config: {...} }
  ],
  dependencies: [
    { from: 'git-history', to: 'insight-generation' },
    { from: 'semantic-analysis', to: 'insight-generation' }
  ],
  outputs: {
    format: 'markdown',
    destination: 'docs/insights/'
  }
};
```

### Workflow Execution

```typescript
const coordinator = new CoordinatorAgent(config);
await coordinator.registerWorkflow(customWorkflow);
const results = await coordinator.executeWorkflow('custom-analysis');
```

## Event Streaming

### Real-time Progress Updates

```typescript
coordinator.on('progress', (event) => {
  console.log(`Agent ${event.agentId}: ${event.progress}%`);
});

coordinator.on('agent-complete', (event) => {
  console.log(`${event.agentId} completed with ${event.results.length} results`);
});

coordinator.on('workflow-complete', (event) => {
  console.log('Analysis complete:', event.summary);
});
```

## Integration with Knowledge Management

### UKB Integration

```typescript
// Create UKB entities from analysis
const entities = await coordinator.executeWorkflow('repository-analysis', {
  createUkbEntities: true,
  ukbPath: '/path/to/ukb'
});

// Export to shared memory
await coordinator.exportToUkb({
  format: 'json',
  destination: 'shared-memory-coding.json'
});
```

### VKB Visualization

```typescript
// Start VKB server with analysis results
const vkbServer = new VkbServer({
  port: 8080,
  data: analysisResults
});

await vkbServer.start();
// Open browser to http://localhost:8080
```

## Error Handling

### Retry Logic

```typescript
const coordinator = new CoordinatorAgent({
  retryAttempts: 3,
  retryDelay: 1000,
  retryBackoff: 2.0
});
```

### Graceful Degradation

```typescript
try {
  const results = await coordinator.executeWorkflow('complete-analysis');
} catch (error) {
  if (error.code === 'API_RATE_LIMIT') {
    // Fall back to simpler analysis
    const results = await coordinator.executeWorkflow('basic-analysis');
  }
}
```

## Performance Optimization

### Caching

```typescript
const coordinator = new CoordinatorAgent({
  enableCache: true,
  cacheDir: '.cache/semantic-analysis',
  cacheTTL: 3600 // 1 hour
});
```

### Parallel Execution

```typescript
const results = await Promise.all([
  coordinator.executeWorkflow('git-analysis'),
  coordinator.executeWorkflow('code-analysis'),
  coordinator.executeWorkflow('pattern-analysis')
]);
```

## See Also

- [Agent Development](agents.md) - Agent architecture
- [Tool Extensions](tools.md) - Custom tool development
- [Installation Guide](../installation/README.md) - Setup instructions
- [Troubleshooting](../troubleshooting/README.md) - Common issues
