# Tool Extensions

The MCP semantic analysis server exposes a set of tools through the Model Context Protocol for AI agents to invoke.

## Core Tools

### analyze_repository
Performs comprehensive repository analysis with configurable depth and significance thresholds.

**Parameters**:
- `repository`: Path to repository (string)
- `depth`: Analysis depth, 1-50 (number, default: 25)
- `significanceThreshold`: Min significance score, 1-10 (number, default: 6)

**Returns**: Analysis results with insights, patterns, and observations

**Example**:
```json
{
  "repository": ".",
  "depth": 25,
  "significanceThreshold": 6
}
```

### analyze_code
Analyzes specific code snippets or files for patterns and issues.

**Parameters**:
- `code`: Code content to analyze (string)
- `language`: Programming language (string, optional)
- `file_path`: File path for context (string, optional)
- `analysis_focus`: Focus area (string, optional)
  - Options: "patterns", "quality", "security", "performance", "architecture"

**Returns**: Code analysis with detected patterns and recommendations

### determine_insights
Uses LLM providers to extract insights from analysis results.

**Parameters**:
- `content`: Content to analyze (string)
- `analysis_type`: Type of analysis (string)
  - Options: "general", "code", "patterns", "architecture"
- `context`: Additional context (string, optional)
- `provider`: LLM provider (string, optional)
  - Options: "anthropic", "openai", "auto"

**Returns**: Structured insights with recommendations

### extract_patterns
Extracts reusable design and architectural patterns.

**Parameters**:
- `source`: Source content (string)
- `pattern_types`: Types of patterns to look for (array of strings, optional)
- `context`: Additional context (string, optional)

**Returns**: Identified patterns with descriptions and examples

### create_ukb_entity_with_insight
Creates UKB entity with detailed insight document.

**Parameters**:
- `entity_name`: Name for the UKB entity (string)
- `entity_type`: Entity type (string)
  - Examples: "Pattern", "Workflow", "Insight", "Decision"
- `insights`: Detailed insights content (string)
- `significance`: Significance score, 1-10 (number, optional)
- `tags`: Tags for categorization (array of strings, optional)

**Returns**: Created entity information

### execute_workflow
Executes predefined analysis workflows.

**Parameters**:
- `workflow_name`: Workflow to execute (string)
  - Options: "complete-analysis", "incremental-analysis", "conversation-analysis", "repository-analysis", "technology-research"
- `parameters`: Workflow parameters (object, optional)

**Returns**: Workflow execution results

### generate_documentation
Generates comprehensive documentation from analysis results.

**Parameters**:
- `analysis_result`: Analysis results to document (object)
- `metadata`: Optional metadata (object, optional)

**Returns**: Generated documentation content

### create_insight_report
Creates detailed insight report with PlantUML diagrams.

**Parameters**:
- `analysis_result`: Analysis results (object)
- `metadata`: Optional metadata including insight name and type (object, optional)

**Returns**: Insight report with diagrams

### generate_plantuml_diagrams
Generates PlantUML diagrams for analysis results.

**Parameters**:
- `diagram_type`: Type of diagram (string)
  - Options: "architecture", "sequence", "use-cases", "class"
- `content`: Content/title for diagram (string)
- `name`: Base name for diagram files (string)
- `analysis_result`: Optional analysis result for context (object, optional)

**Returns**: Generated diagram files

## Tool Development

### Creating Custom Tools

Tools must implement the MCP tool interface:

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler: (params: any) => Promise<any>;
}
```

### Tool Registration

Register tools in `src/tools.ts`:

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'your_tool_name':
      return await yourToolHandler(args);
    // ...
  }
});
```

### Tool Best Practices

1. **Input Validation**: Validate all parameters using JSON Schema
2. **Error Handling**: Return structured errors with helpful messages
3. **Documentation**: Provide clear descriptions and examples
4. **Performance**: Consider timeout limits and resource usage
5. **Testing**: Write comprehensive tests for all tools

## Tool Categories

### Analysis Tools
- `analyze_repository`
- `analyze_code`
- `determine_insights`

### Pattern Tools
- `extract_patterns`

### Knowledge Tools
- `create_ukb_entity_with_insight`

### Workflow Tools
- `execute_workflow`

### Documentation Tools
- `generate_documentation`
- `create_insight_report`
- `generate_plantuml_diagrams`

## See Also

- [Agent Development](agents.md) - Agent architecture
- [Integration Patterns](integration.md) - Integration strategies
- [API Reference](../api/README.md) - Complete API documentation
