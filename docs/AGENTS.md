# B — Agent Details

> Long-form companion to [../README.md](../README.md). The README answers "where do I edit config?" in 5 minutes; this file answers "how does each agent actually work?" and contains the operational depth (per-agent enhancement narratives, MCP tool catalog, use-case walkthroughs, project structure).

The B system orchestrates **14 intelligent agents** across three role groups (8 LLM-enhanced, 2 infrastructure, 4 orchestration/persistence/coordination). The README's Architecture section lists each agent with a 1-line role; this file expands each into its operational contract.

## Agent Catalog — Per-Agent Enhancement Detail

### 🧠 LLM-Enhanced Agents (8)

Five core agents leverage advanced LLM capabilities through the `SemanticAnalyzer` service, giving B its "semantic" depth beyond pattern-matching.

#### 1. VibeHistoryAgent — Session Analysis

- **Capability**: Generates executive summaries from conversation patterns
- **Output**: Key patterns discovered, actionable recommendations, trend analysis
- **Benefit**: Transforms raw session logs into strategic insights
- **Source**: `src/agents/vibe-history-agent.ts`

#### 2. SemanticAnalysisAgent — Code Correlation

- **Capability**: Correlates code changes with conversation context using deep semantic analysis
- **Output**: Insights connecting implementation decisions to discussion context
- **Benefit**: Captures the "why" behind code changes
- **Source**: `src/agents/semantic-analysis-agent.ts`

#### 3. WebSearchAgent — Relevance Scoring

- **Capability**: Blends keyword matching (40%) with semantic understanding (60%)
- **Output**: Semantically-ranked search results with relevance reasoning
- **Benefit**: Surfaces most contextually relevant results beyond keyword matches
- **Source**: `src/agents/web-search.ts`

#### 4. InsightGenerationAgent — Insights & Diagrams

- **Capability**: LLM-powered insight generation with PlantUML diagrams and patterns
- **Output**: Pattern catalogs, architectural diagrams, structured insights
- **Benefit**: Materializes wave-analysis findings into linkable artifacts
- **Source**: `src/agents/insight-generation-agent.ts`

#### 5. ObservationGenerationAgent — Insight Extraction

- **Capability**: Extracts structured insights with domain classification
- **Output**: Key learnings, technical domain, applicability scope, actionable recommendations
- **Benefit**: Enriches observations with deeper semantic understanding
- **Source**: `src/agents/observation-generation-agent.ts`

#### 6. QualityAssuranceAgent — Semantic Validation

- **Capability**: Detects conversation fragments, generic content, vague patterns
- **Output**: Quality assessment (high/medium/low) with confidence scores and specific issues
- **Benefit**: Prevents low-quality content from entering knowledge base
- **Source**: `src/agents/quality-assurance-agent.ts`

#### 7. GitHistoryAgent — Architectural Decision Mining

- **Capability**: Analyzes git commits from checkpoint with architectural decisions
- **Output**: Commit clusters tagged with architectural intent
- **Benefit**: Surfaces the design rationale embedded in commit history
- **Source**: `src/agents/git-history-agent.ts`

#### 8. PersistenceAgent — Ontology-Classified Persistence

- **Capability**: Persists entities to Graphology+LevelDB graph database with ontology-based classification
- **Output**: Persisted entities with `entityType` + `ontologyClass` + confidence metadata
- **Benefit**: Single canonical write path with classifier-driven typing
- **Source**: `src/agents/persistence-agent.ts`

### 🔢 Infrastructure Agents (2) — Embedding-Enhanced

#### 9. DeduplicationAgent — Semantic Duplicate Detection

- **Capability**: OpenAI embeddings (`text-embedding-3-small`) with cosine similarity for semantic duplicate detection
- **Fallback**: Graceful degradation to Jaccard text similarity
- **Output**: Survivor entities + merge plans (SUPERSEDED_BY edges)
- **Benefit**: Detects semantically similar entities even with different wording
- **Source**: `src/agents/dedup-agent.ts`

#### 10. ContentValidationAgent — Stale Knowledge Detection

- **Capability**: Validates entity content accuracy, detects stale knowledge, and generates refresh recommendations
- **Output**: Staleness flags + refresh prompts
- **Benefit**: Prevents the knowledge base from drifting away from reality
- **Source**: `src/agents/content-validation-agent.ts`

### 🟡 Orchestration & Coordination (4)

#### 11. CoordinatorAgent — Workflow Orchestration

- **Capability**: Workflow orchestration, task scheduling, and agent coordination with GraphDB integration
- **Output**: Step results threaded through `{{stepName}}` templating; status broadcasts via SSE
- **Note**: The Coordinator orchestrates ALL agents through workflow definitions — agents don't call each other directly; data flows through the coordinator via step dependencies and result templating.
- **Source**: `src/coordinator.ts`

#### 12-14. WaveController + sub-orchestration helpers

- WaveController drives the multi-wave analysis workflow (extract → analyze → classify → persist → dedup → predict → merge) and emits sub-step events for dashboard progress tracking.
- Sources: `src/wave-controller.ts`, supporting helpers under `src/wave/`

## 6-Tier LLM Provider Chain

All LLM-enhanced agents use the `SemanticAnalyzer` with automatic failover:

```
Groq → Gemini → Custom LLM → Anthropic → OpenAI → Ollama (local)
```

**Benefits:**

- 🚀 Fast responses from Groq when available
- 💪 Reliability through multiple fallback providers
- 💰 Cost optimization by preferring cheaper providers
- 🔄 Automatic provider switching on failures
- 🏠 Local Ollama fallback when all cloud APIs fail (no mock/silent failures)

Routing per process is overridable via `config/workflows/<workflow>.json` `processOverrides` (see `scripts/configure-wave-analysis-routing.sh` for the wave-analysis convention that routes through `copilot` for speed).

## Ontology Classification System

The `PersistenceAgent` features intelligent entity classification using a 5-layer hybrid approach:

1. **Team Context Filtering** — Narrows to team-specific ontology (coding, RaaS, UI, etc.)
2. **Entity Pattern Analysis** — Matches structural patterns (e.g., LSLSession file format, MCP protocols)
3. **Enhanced Keyword Matching** — Weighted keyword scoring with domain terminology
4. **Semantic Embedding Similarity** — Vector-based semantic matching (when available)
5. **LLM Classification** — Claude/GPT fallback for ambiguous cases (optional)

**Classification Performance:**

- ⚡ **Heuristic-first**: 90% of entities classified in <100ms
- 📊 **High Accuracy**: 0.85-0.95 confidence scores for most entity types
- 🔄 **Graceful Fallback**: Default to `TransferablePattern` when confidence < threshold
- 📝 **Full Metadata**: All classifications include confidence scores, methods, and reasoning

**Supported Entity Types** (33 types in coding ontology):

- `LSLSession`, `MCPAgent`, `GraphDatabase`, `KnowledgeEntity`
- `WorkflowDefinition`, `ServiceRegistry`, `EmbeddingVector`
- `TransferablePattern` (generic fallback)
- And 26 more specialized types

**Configuration (Simplified):**

```typescript
const persistenceAgent = new PersistenceAgent(repoPath, graphDB, {
  ontologyTeam: 'coding',          // Team-specific ontology (default: 'coding')
  ontologyMinConfidence: 0.7,      // Confidence threshold (default: 0.7)
  validationMode: 'lenient',       // 'disabled' | 'lenient' | 'strict'
  contentValidationMode: 'lenient' // 'disabled' | 'lenient' | 'strict' | 'report-only'
});
```

**Note:** No more boolean enable/disable toggles. Use `validationMode: 'disabled'` to disable validation.

## MCP Tools (12 Available)

These tools are exposed by B over the MCP protocol (stdio in local mode, HTTP/SSE in Docker mode on port 3848). All tool definitions live in `src/tools.ts`.

### Connection & Health

```typescript
heartbeat() → ServerStatus
test_connection() → ConnectionInfo
```

### Analysis Tools

```typescript
determine_insights(content, context?, analysis_type?, provider?) → Insights
analyze_code(code, language?, file_path?, analysis_focus?) → CodeAnalysis
analyze_repository(repository_path, include_patterns?, exclude_patterns?, max_files?) → RepositoryAnalysis
extract_patterns(source, pattern_types?, context?) → ExtractedPatterns
```

### Knowledge Management

```typescript
create_ukb_entity_with_insight(entity_name, entity_type, insights, significance?, tags?) → EntityCreationResult
execute_workflow(workflow_name, parameters?) → WorkflowResult
```

### Documentation & Reporting

```typescript
generate_documentation(analysis_result, metadata?) → Documentation
create_insight_report(analysis_result, metadata?) → InsightReport
generate_plantuml_diagrams(diagram_type, content, name, analysis_result?) → PlantUMLDiagram
generate_lessons_learned(analysis_result, title?, metadata?) → LessonsLearned
```

## Use Cases

### 1. Full Semantic Analysis Workflow

```typescript
// Execute complete 14-agent analysis
const workflow = await execute_workflow("wave-analysis", {
  repository_path: "/path/to/project",
  include_git_history: true,
  include_vibe_history: true,
  checkpoint_enabled: true
});

// Results include:
// - Git commit analysis since last checkpoint
// - Conversation context from .specstory/history
// - Deep code analysis with pattern extraction
// - External research validation
// - Comprehensive insights with diagrams
// - Structured UKB observations
// - Quality-assured outputs
// - Updated knowledge base with new checkpoint
```

### 2. Incremental Analysis

```typescript
// Analyze only changes since last checkpoint
const incremental = await execute_workflow("incremental-analysis", {
  since_last_checkpoint: true
});

// Efficient analysis of:
// - Recent git commits only
// - New conversation sessions
// - Incremental pattern updates
// - Quick observation generation
```

### 3. Pattern Extraction Pipeline

```typescript
// Extract and document patterns
const patterns = await execute_workflow("pattern-extraction", {
  pattern_types: ["design", "architectural", "workflow"]
});

// Generates:
// - Pattern catalog with examples
// - PlantUML diagrams for each pattern
// - Structured observations for knowledge base
```

## Project Structure

```text
src/
├── index.ts                   MCP server entry point
├── server.ts                  Core MCP server implementation
├── tools.ts                   Tool definitions and handlers
├── logging.ts                 Logging utilities
├── coordinator.ts             CoordinatorAgent — workflow orchestration
├── wave-controller.ts         WaveController — multi-wave analysis driver
└── agents/                    Intelligent agent implementations
    ├── git-history-agent.ts
    ├── vibe-history-agent.ts
    ├── semantic-analysis-agent.ts
    ├── web-search.ts
    ├── insight-generation-agent.ts
    ├── observation-generation-agent.ts
    ├── quality-assurance-agent.ts
    ├── persistence-agent.ts
    ├── dedup-agent.ts
    ├── content-validation-agent.ts
    └── index.ts               Agent registry
```

## Integration Notes

### Docker / HTTP-SSE Mode

For containerized deployments, this server exposes HTTP/SSE transport:

- **Port**: `3848` (configurable via `SEMANTIC_ANALYSIS_SSE_PORT`)
- **Endpoints**: `GET /health`, `GET /sse`, `POST /messages`
- **Health Check**: `curl http://localhost:3848/health` → `{"status":"ok","server":"mcp-server-semantic-analysis"}`

Claude Code connects via a lightweight stdio proxy:

```json
{
  "semantic-analysis": {
    "command": "node",
    "args": ["path/to/dist/stdio-proxy.js"],
    "env": {
      "SEMANTIC_ANALYSIS_SSE_URL": "http://localhost:3848"
    }
  }
}
```

See the parent [Docker Deployment Guide](../../../docker/README.md) for full containerization setup.

### Shared Knowledge

- **UKB Integration**: Creates and updates Universal Knowledge Base entities (persisted via km-core)
- **VKB Compatibility**: Supports knowledge visualization workflows at `http://localhost:8080`
- **Cross-Session Persistence**: Maintains context across Claude sessions via the GraphKMStore
- **Checkpoint Management**: Tracks analysis progress to avoid duplication

### Configuration Files

- **Template**: `claude-code-mcp.json` (with placeholders)
- **Processed**: `claude-code-mcp-processed.json` (actual paths)
- **Claude Config**: `~/.claude.json` (Claude Code configuration)

## Performance & Stability

### Node.js Advantages

- **No Python Environment Issues** — Eliminates venv conflicts and dependency hell
- **Stable Connections** — No 60-second connection drops
- **Fast Startup** — Immediate availability
- **Resource Efficiency** — Lower memory footprint

### Provider Management

- **Smart Fallbacks** — Automatic provider switching on failures
- **Rate Limiting** — Built-in request throttling
- **Error Recovery** — Graceful degradation and retry logic

### Monitoring

- **Health Checks** — Built-in connection monitoring
- **Logging** — Structured logging with correlation IDs
- **Metrics** — Performance tracking and analytics

## See Also

- [../README.md](../README.md) — 6-section quick-reference (Configurations Owned, Where to Edit, Related Systems)
- [../../../lib/km-core/README.md](../../../lib/km-core/README.md) — Shared persistence + REST contract layer that this server writes through
- [../../../README.md](../../../README.md) — `coding` — host runtime and observation source
