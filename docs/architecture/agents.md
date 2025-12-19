# Agent Architecture

The semantic analysis system consists of **14 specialized agents** organized into orchestration, analysis, quality, infrastructure, and support layers.

## Agent Count Summary

| Category | Count | Description |
|----------|-------|-------------|
| Orchestration | 1 | Workflow coordination |
| Core Analysis | 6 | Data extraction and analysis |
| Quality & Validation | 3 | Output validation and repair |
| Infrastructure | 3 | Storage and deduplication |
| Support | 1 | LLM integration layer |
| **Total** | **14** | |

## Architecture Diagram

![14-Agent Semantic Analysis System](../../../../docs/images/semantic-analysis-agent-system.png)

## Workflow Sequence Diagram

![Agent Coordination Flow](../images/agent-coordination-flow.png)

## Agent Catalog

### Orchestration Layer

#### 1. CoordinatorAgent
**Purpose**: Orchestrate multi-agent workflows with dependency management

**Key Capabilities**:
- Workflow orchestration with step definitions
- Agent coordination and task sequencing
- GraphDB adapter initialization
- Error recovery and rollback handling
- Progress tracking and metrics
- Checkpoint management for incremental analysis

**Location**: `src/agents/coordinator.ts`

---

### Core Analysis Layer

#### 2. GitHistoryAgent
**Purpose**: Extract insights from git commit history and architectural decisions

**Key Capabilities**:
- Analyzes commit messages and code changes
- Identifies architectural patterns from version control
- Extracts decision rationale from commit history
- Tracks code evolution over time
- Checkpoint-based incremental analysis

**Location**: `src/agents/git-history-agent.ts`

#### 3. VibeHistoryAgent
**Purpose**: Process conversation files and extract development context with LLM-powered analysis

**Key Capabilities**:
- Parses Claude conversation transcripts from `.specstory/history/`
- Generates executive summaries from conversation patterns
- Identifies key patterns and development themes
- Provides actionable recommendations and trend analysis
- Captures team knowledge from conversations

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/vibe-history-agent.ts`

#### 4. SemanticAnalysisAgent
**Purpose**: Deep code analysis and pattern recognition with LLM-powered semantic understanding

**Key Capabilities**:
- Abstract syntax tree (AST) analysis
- Design pattern detection
- Correlates code changes with conversation context
- Deep semantic code analysis
- Captures the "why" behind code changes
- Dependency mapping

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/semantic-analysis-agent.ts`

#### 5. WebSearchAgent
**Purpose**: Research external patterns and best practices with LLM semantic relevance scoring

**Key Capabilities**:
- Web-based pattern research
- Technology documentation lookup
- Semantic relevance scoring (40% keyword + 60% semantic)
- Context-aware result ranking
- Best practices discovery
- External knowledge integration

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/web-search.ts`

#### 6. InsightGenerationAgent
**Purpose**: Generate structured insights with PlantUML diagrams using LLM-powered synthesis

**Key Capabilities**:
- Creates comprehensive insight documents (Markdown)
- Generates all 4 PlantUML diagram types (architecture, sequence, class, use-cases)
- Deep insight generation and synthesis
- Actionable recommendations
- **LLM-Based PlantUML Repair**: Automatic syntax error correction with retry loop
  - Receives PlantUML error messages from `plantuml -checkonly`
  - Generates diagram-type-specific fix prompts
  - Up to 2 retry attempts with validation
  - Falls back to regex-based fixes

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**PlantUML Repair Flow**:
```
LLM generates PUML → validateAndFixPlantUML() → plantuml -checkonly
                                                      ↓
                                               VALID? → Generate PNG
                                                      ↓ NO
                                          repairPlantUMLWithLLM()
                                                      ↓
                                          LLM gets error + context
                                                      ↓
                                          Fixed PUML → Re-validate
                                                      ↓
                                          Retry up to 2 times
```

**Location**: `src/agents/insight-generation-agent.ts`

#### 7. CodeIntelligenceAgent
**Purpose**: Generate context-aware code queries and extract evidence-backed insights from the code graph

**Key Capabilities**:
- Natural language to Cypher query translation
- Context-aware question generation based on git changes, commits, and vibe patterns
- Hotspot detection (highly connected code entities)
- Circular dependency analysis
- Inheritance hierarchy mapping
- Change impact analysis
- Architectural pattern discovery
- Evidence-backed correlation generation

**Query Types**:
- Structural: Class hierarchies, module dependencies, function callers
- Change Impact: What depends on modified files, test coverage
- Code Health: Circular dependencies, god classes, unused imports
- Architecture: Design patterns, layering, cross-module dependencies

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/code-graph-agent.ts` (via `queryIntelligently()` method)

---

### Quality & Validation Layer

#### 8. QualityAssuranceAgent
**Purpose**: Validate and auto-correct agent outputs with LLM semantic validation

**Key Capabilities**:
- Output validation against quality rules
- Detects conversation fragments and incomplete thoughts
- Identifies generic/template content
- Quality assessment (high/medium/low) with confidence scores
- Specific issue identification
- Automatic error correction
- PlantUML file validation

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/quality-assurance-agent.ts`

#### 9. ContentValidationAgent
**Purpose**: Validate entity content accuracy and detect stale knowledge

**Key Capabilities**:
- Validates entity observations against current codebase state
- Detects deprecated patterns (ukb references, shared-memory.json, etc.)
- Checks file reference validity
- Identifies stale entities requiring refresh
- Generates refresh reports with actionable recommendations
- Integrates with incremental-analysis workflow for automatic staleness detection
- Triggers InsightGenerationAgent for entity refresh

**Key Methods**:
- `validateEntityAccuracy()`: Full entity validation with scoring
- `validateAndRefreshStaleEntities()`: Batch validation during workflows
- `validateObservations()`: Check individual observations for staleness
- `generateRefreshReport()`: Human-readable staleness reports

**Location**: `src/agents/content-validation-agent.ts`

#### 10. ObservationGenerationAgent
**Purpose**: Create structured UKB-compatible observations with LLM-powered insight extraction

**Key Capabilities**:
- Generates entity observations
- Extracts structured insights with domain classification
- Identifies key learnings and technical domains
- Generates actionable recommendations
- Provides applicability scope analysis
- Creates knowledge graph entries
- Formats data for UKB import

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/observation-generation-agent.ts`

---

### Infrastructure Layer

#### 11. PersistenceAgent
**Purpose**: Manage knowledge base persistence to GraphDB

**Key Capabilities**:
- GraphDB entity storage (Graphology + LevelDB)
- Entity relationship management
- Checkpoint creation and management
- Automatic JSON export triggering
- Observation metadata handling

**Location**: `src/agents/persistence-agent.ts`

#### 12. DeduplicationAgent
**Purpose**: Semantic duplicate detection and removal using OpenAI embeddings

**Key Capabilities**:
- OpenAI text-embedding-3-small for vector-based similarity
- Cosine similarity calculation for semantic matching
- Identifies semantic duplicates beyond keyword matching
- Merges similar insights
- Graceful degradation to Jaccard text similarity (fallback)
- Reduces redundancy in knowledge base

**Embedding Model**: OpenAI text-embedding-3-small

**Location**: `src/agents/deduplication.ts`

#### 13. GitStalenessDetector
**Purpose**: Detect entity staleness based on git commit activity

**Key Capabilities**:
- Correlates entities with git commit topics
- Analyzes commit activity since entity creation
- Identifies entities affected by recent code changes
- Provides staleness scores based on topic overlap
- Integrates with ContentValidationAgent

**Location**: `src/agents/git-staleness-detector.ts`

---

### Support Layer

#### 14. SemanticAnalyzer
**Purpose**: Unified LLM integration layer for all agents

**Key Capabilities**:
- 5-tier provider chain: Groq → Gemini → Custom → Anthropic → OpenAI
- Automatic failover between providers
- Content analysis with configurable options
- Code analysis with language detection
- Pattern extraction from source code
- Used by 6 agents for LLM operations

**Location**: `src/agents/semantic-analyzer.ts`

---

### Workflow Support (Non-Agent)

#### WorkflowReportAgent
**Purpose**: Generate workflow execution reports

**Key Capabilities**:
- Compiles step-by-step execution reports
- Tracks timing and success metrics
- Generates human-readable summaries

**Location**: `src/agents/workflow-report-agent.ts`

---

## Agent Communication

Agents communicate through the CoordinatorAgent using a standardized message passing system:

```typescript
interface AgentMessage {
  type: 'request' | 'response' | 'error';
  agentId: string;
  payload: any;
  metadata?: Record<string, any>;
}
```

**Data Flow Pattern**: Hub-and-spoke via CoordinatorAgent
- Agents do NOT communicate directly with each other
- All data flows through the Coordinator
- Coordinator manages dependencies and sequencing

## Agent Lifecycle

1. **Initialization**: Agent is instantiated by Coordinator
2. **Configuration**: Receives workflow parameters and GraphDB adapter
3. **Execution**: Performs specialized analysis
4. **Output**: Produces structured results to Coordinator
5. **Cleanup**: Releases resources

## LLM Integration Summary

| Agent | Uses LLM | Provider Chain |
|-------|----------|----------------|
| CoordinatorAgent | No | - |
| GitHistoryAgent | No | - |
| VibeHistoryAgent | Yes | Groq → Gemini → Custom → Anthropic → OpenAI |
| SemanticAnalysisAgent | Yes | Groq → Gemini → Custom → Anthropic → OpenAI |
| WebSearchAgent | Yes | Groq → Gemini → Custom → Anthropic → OpenAI |
| InsightGenerationAgent | Yes | Groq → Gemini → Custom → Anthropic → OpenAI |
| CodeIntelligenceAgent | Yes | Groq → Gemini → Custom → Anthropic → OpenAI |
| ObservationGenerationAgent | Yes | Groq → Gemini → Custom → Anthropic → OpenAI |
| QualityAssuranceAgent | Yes | Groq → Gemini → Custom → Anthropic → OpenAI |
| ContentValidationAgent | No | - |
| PersistenceAgent | No | - |
| DeduplicationAgent | Embeddings | OpenAI text-embedding-3-small |
| GitStalenessDetector | No | - |
| SemanticAnalyzer | Yes | Groq → Gemini → Custom → Anthropic → OpenAI |

**Total LLM-Enhanced**: 8 agents (7 analysis + 1 embeddings)

## Recent Improvements

### PlantUML LLM Repair (December 2024)

The InsightGenerationAgent now includes intelligent PlantUML error correction:

1. **Regex-Based Fixes** (`validateAndFixPlantUML`):
   - Removes newlines from alias strings
   - Fixes component syntax variations
   - Handles note block formatting
   - Cleans blank lines in notes
   - Converts sequence diagram floating notes to `note over` syntax

2. **LLM-Based Repair** (`repairPlantUMLWithLLM`):
   - Activated when regex fixes fail and `plantuml -checkonly` reports errors
   - Sends broken PUML + error message to LLM
   - Provides diagram-type-specific guidance:
     - **Sequence**: Note syntax, participant declarations, arrow types
     - **Architecture**: Nesting, brace balancing
     - **Class**: Member syntax, relationship arrows
     - **Use-cases**: Actor/usecase declarations
   - Up to 2 retry attempts
   - Re-applies regex fixes to LLM output

## Adding New Agents

To extend the system with new agents:

1. Implement agent class in `src/agents/`
2. Follow the established interface patterns
3. Register with CoordinatorAgent workflow definitions
4. Add to workflow step sequences as needed
5. Update this documentation

## See Also

- [Tool Extensions](tools.md) - Custom tool development
- [Integration Patterns](integration.md) - Integration strategies
- [Architecture Overview](README.md) - System architecture
