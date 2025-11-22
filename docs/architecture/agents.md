# Agent Architecture

The semantic analysis system consists of 11 specialized agents, each responsible for specific aspects of code analysis and knowledge management.

## Agent Overview

### 1. GitHistoryAgent
**Purpose**: Extract insights from git commit history and architectural decisions

**Key Capabilities**:
- Analyzes commit messages and code changes
- Identifies architectural patterns from version control
- Extracts decision rationale from commit history
- Tracks code evolution over time

**Location**: `src/agents/git-history-agent.ts`

### 2. VibeHistoryAgent 🧠
**Purpose**: Process conversation files and extract development context with LLM-powered analysis

**Key Capabilities**:
- Parses Claude conversation transcripts
- **LLM Enhancement**: Generates executive summaries from conversation patterns
- **LLM Enhancement**: Identifies key patterns and development themes
- **LLM Enhancement**: Provides actionable recommendations and trend analysis
- Captures team knowledge from conversations

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/vibe-history-agent.ts`

### 3. SemanticAnalysisAgent 🧠
**Purpose**: Deep code analysis and pattern recognition with LLM-powered semantic understanding

**Key Capabilities**:
- Abstract syntax tree (AST) analysis
- Design pattern detection
- **LLM Enhancement**: Correlates code changes with conversation context
- **LLM Enhancement**: Deep semantic code analysis
- **LLM Enhancement**: Captures the "why" behind code changes
- Dependency mapping

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/semantic-analysis-agent.ts`

### 4. WebSearchAgent 🧠
**Purpose**: Research external patterns and best practices with LLM semantic relevance scoring

**Key Capabilities**:
- Web-based pattern research
- Technology documentation lookup
- **LLM Enhancement**: Semantic relevance scoring (40% keyword + 60% semantic)
- **LLM Enhancement**: Context-aware result ranking
- Best practices discovery
- External knowledge integration

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/web-search.ts`

### 5. InsightGenerationAgent 🧠
**Purpose**: Generate structured insights with PlantUML diagrams using LLM-powered synthesis

**Key Capabilities**:
- Creates comprehensive insight documents
- **LLM Enhancement**: Deep insight generation and synthesis
- **LLM Enhancement**: Actionable recommendations
- Generates PlantUML architecture diagrams
- Produces visualization artifacts

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/insight-generation-agent.ts`

### 6. ObservationGenerationAgent 🧠
**Purpose**: Create structured UKB-compatible observations with LLM-powered insight extraction

**Key Capabilities**:
- Generates entity observations
- **LLM Enhancement**: Extracts structured insights with domain classification
- **LLM Enhancement**: Identifies key learnings and technical domains
- **LLM Enhancement**: Generates actionable recommendations
- **LLM Enhancement**: Provides applicability scope analysis
- Creates knowledge graph entries
- Formats data for UKB import

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/observation-generation-agent.ts`

### 7. QualityAssuranceAgent 🧠
**Purpose**: Validate and auto-correct agent outputs with LLM semantic validation

**Key Capabilities**:
- Output validation
- **LLM Enhancement**: Detects conversation fragments and incomplete thoughts
- **LLM Enhancement**: Identifies generic/template content
- **LLM Enhancement**: Quality assessment (high/medium/low) with confidence scores
- **LLM Enhancement**: Provides specific issue identification
- Automatic error correction
- Quality metrics enforcement

**LLM Provider Chain**: Groq → Gemini → Custom → Anthropic → OpenAI

**Location**: `src/agents/quality-assurance-agent.ts`

### 8. PersistenceAgent
**Purpose**: Manage knowledge base persistence

**Key Capabilities**:
- File system operations
- Knowledge base updates
- Data serialization
- Backup management

**Location**: `src/agents/persistence-agent.ts`

### 9. SynchronizationAgent
**Purpose**: Multi-source data synchronization

**Key Capabilities**:
- Merges data from multiple sources
- Resolves conflicts
- Maintains data consistency
- Handles concurrent updates

**Location**: `src/agents/synchronization.ts`

### 10. DeduplicationAgent 🔢
**Purpose**: Semantic duplicate detection and removal using OpenAI embeddings

**Key Capabilities**:
- **Embedding Enhancement**: OpenAI text-embedding-3-small for vector-based similarity
- **Embedding Enhancement**: Cosine similarity calculation for semantic matching
- Identifies semantic duplicates beyond keyword matching
- Merges similar insights
- **Fallback**: Graceful degradation to Jaccard text similarity
- Reduces redundancy

**Embedding Model**: OpenAI text-embedding-3-small

**Location**: `src/agents/deduplication.ts`

### 11. CoordinatorAgent
**Purpose**: Orchestrate multi-agent workflows

**Key Capabilities**:
- Workflow orchestration
- Agent coordination
- Task sequencing
- Progress tracking

**Location**: `src/agents/coordinator.ts`

## Agent Communication

Agents communicate through a standardized message passing system:

```typescript
interface AgentMessage {
  type: 'request' | 'response' | 'error';
  agentId: string;
  payload: any;
  metadata?: Record<string, any>;
}
```

## Agent Lifecycle

1. **Initialization**: Agent registers with coordinator
2. **Configuration**: Receives workflow parameters
3. **Execution**: Performs specialized analysis
4. **Output**: Produces structured results
5. **Cleanup**: Releases resources

## Adding New Agents

To extend the system with new agents:

1. Implement agent class in `src/agents/`
2. Follow the base agent interface
3. Register with coordinator
4. Add to workflow definitions
5. Update documentation

## See Also

- [Tool Extensions](tools.md) - Custom tool development
- [Integration Patterns](integration.md) - Integration strategies
- [Architecture Overview](README.md) - System architecture
