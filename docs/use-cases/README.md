# Use Cases

Common scenarios and workflows for the MCP semantic analysis server.

## Repository Analysis

### Onboarding New Developers

**Goal**: Help new team members understand the codebase quickly

**Workflow**:
```json
{
  "workflow_name": "repository-analysis",
  "parameters": {
    "repository": ".",
    "depth": 25,
    "significanceThreshold": 6,
    "focus": ["architecture", "patterns", "dependencies"]
  }
}
```

**Output**:
- Architecture diagrams
- Key patterns and conventions
- Module dependencies
- Entry points and flows

### Technical Debt Assessment

**Goal**: Identify areas needing refactoring

**Workflow**:
```json
{
  "workflow_name": "technical-debt-analysis",
  "parameters": {
    "repository": ".",
    "analysis_focus": ["quality", "complexity", "duplication"]
  }
}
```

**Output**:
- Code smells
- Duplication hotspots
- Complexity metrics
- Refactoring priorities

### Architecture Documentation

**Goal**: Generate up-to-date architecture docs

**Workflow**:
```json
{
  "workflow_name": "architecture-documentation",
  "parameters": {
    "repository": ".",
    "includeDiagrams": true,
    "diagramTypes": ["architecture", "sequence", "class"]
  }
}
```

**Output**:
- Architecture overview
- Component diagrams
- Sequence diagrams
- Class diagrams

## Code Analysis

### Security Audit

**Goal**: Identify potential security vulnerabilities

**Workflow**:
```typescript
analyze_code({
  code: fileContent,
  language: "typescript",
  analysis_focus: "security"
})
```

**Detects**:
- SQL injection risks
- XSS vulnerabilities
- Authentication issues
- Sensitive data exposure

### Performance Optimization

**Goal**: Find performance bottlenecks

**Workflow**:
```typescript
analyze_code({
  code: fileContent,
  language: "typescript",
  analysis_focus: "performance"
})
```

**Identifies**:
- N+1 queries
- Inefficient algorithms
- Memory leaks
- Blocking operations

### Code Review Assistant

**Goal**: Automated code review feedback

**Workflow**:
```typescript
analyze_code({
  code: pullRequestDiff,
  language: "typescript",
  analysis_focus: "quality"
})
```

**Provides**:
- Style violations
- Best practice recommendations
- Potential bugs
- Test coverage gaps

## Knowledge Management

### Pattern Extraction

**Goal**: Build reusable pattern library

**Workflow**:
```typescript
extract_patterns({
  source: repositoryContent,
  pattern_types: ["design", "architectural", "integration"]
})
```

**Output**:
- Design pattern catalog
- Best practices
- Code templates
- Implementation examples

### Decision Log

**Goal**: Track architectural decisions

**Workflow**:
```json
{
  "workflow_name": "conversation-analysis",
  "parameters": {
    "source": ".claude/conversations",
    "extractDecisions": true
  }
}
```

**Captures**:
- Design decisions
- Trade-offs considered
- Alternatives evaluated
- Rationale

### Knowledge Base Building

**Goal**: Create searchable knowledge base

**Workflow**:
```typescript
create_ukb_entity_with_insight({
  entity_name: "Authentication Pattern",
  entity_type: "Pattern",
  insights: analysisResults,
  tags: ["security", "auth", "jwt"]
})
```

**Benefits**:
- Searchable insights
- Cross-project learning
- Team knowledge sharing
- Onboarding resources

## Team Workflows

### Sprint Planning

**Goal**: Estimate complexity and dependencies

**Workflow**:
1. Analyze target files/modules
2. Extract complexity metrics
3. Identify dependencies
4. Generate effort estimates

### Code Migration

**Goal**: Plan and execute technology migrations

**Workflow**:
1. Analyze current implementation
2. Identify migration patterns
3. Generate migration plan
4. Track progress

### API Documentation

**Goal**: Auto-generate API documentation

**Workflow**:
```typescript
generate_documentation({
  analysis_result: codeAnalysis,
  metadata: {
    format: "openapi",
    version: "3.0.0"
  }
})
```

**Output**:
- OpenAPI specifications
- Endpoint documentation
- Schema definitions
- Example requests

## CI/CD Integration

### Pre-Commit Analysis

**Goal**: Catch issues before commit

**Workflow**:
```bash
# .git/hooks/pre-commit
npx semantic-analysis analyze-code \
  --staged \
  --fail-on-error
```

### Pull Request Automation

**Goal**: Automated PR review and documentation

**Workflow**:
```yaml
# .github/workflows/pr-analysis.yml
- name: Analyze PR
  run: |
    npx semantic-analysis analyze-code \
      --diff="${{ github.event.pull_request.base.sha }}..HEAD" \
      --output="pr-analysis.md"
```

### Release Documentation

**Goal**: Auto-generate release notes

**Workflow**:
```bash
npx semantic-analysis analyze-repository \
  --since-tag="v1.0.0" \
  --format="release-notes"
```

## Specialized Use Cases

### Multi-Repo Analysis

**Goal**: Analyze patterns across multiple repositories

**Workflow**:
```typescript
for (const repo of repositories) {
  const results = await analyzeRepository(repo);
  await mergeResults(results);
}
```

### Language Migration

**Goal**: Plan migration from one language to another

**Workflow**:
1. Analyze source language patterns
2. Map to target language equivalents
3. Generate migration templates
4. Track conversion progress

### Compliance Auditing

**Goal**: Verify code meets compliance requirements

**Workflow**:
```typescript
analyze_code({
  code: fileContent,
  analysis_focus: "security",
  compliance: ["GDPR", "HIPAA", "SOC2"]
})
```

## See Also

- [Installation Guide](../installation/README.md) - Setup instructions
- [API Reference](../api/README.md) - Tool documentation
- [Architecture](../architecture/README.md) - System design
