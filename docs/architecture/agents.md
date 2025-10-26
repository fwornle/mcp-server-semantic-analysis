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

### 2. VibeHistoryAgent
**Purpose**: Process conversation files and extract development context

**Key Capabilities**:
- Parses Claude conversation transcripts
- Extracts development decisions from discussions
- Identifies problem-solving patterns
- Captures team knowledge from conversations

**Location**: `src/agents/vibe-history-agent.ts`

### 3. SemanticAnalysisAgent
**Purpose**: Deep code analysis and pattern recognition

**Key Capabilities**:
- Abstract syntax tree (AST) analysis
- Design pattern detection
- Code structure analysis
- Dependency mapping

**Location**: `src/agents/semantic-analysis-agent.ts`

### 4. WebSearchAgent
**Purpose**: Research external patterns and best practices

**Key Capabilities**:
- Web-based pattern research
- Technology documentation lookup
- Best practices discovery
- External knowledge integration

**Location**: `src/agents/web-search.ts`

### 5. InsightGenerationAgent
**Purpose**: Generate structured insights with PlantUML diagrams

**Key Capabilities**:
- Creates comprehensive insight documents
- Generates PlantUML architecture diagrams
- Synthesizes findings into actionable insights
- Produces visualization artifacts

**Location**: `src/agents/insight-generation-agent.ts`

### 6. ObservationGenerationAgent
**Purpose**: Create structured UKB-compatible observations

**Key Capabilities**:
- Generates entity observations
- Creates knowledge graph entries
- Formats data for UKB import
- Ensures observation consistency

**Location**: `src/agents/observation-generation-agent.ts`

### 7. QualityAssuranceAgent
**Purpose**: Validate and auto-correct agent outputs

**Key Capabilities**:
- Output validation
- Automatic error correction
- Quality metrics enforcement
- Consistency checking

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

### 10. DeduplicationAgent
**Purpose**: Semantic duplicate detection and removal

**Key Capabilities**:
- Identifies semantic duplicates
- Merges similar insights
- Reduces redundancy
- Maintains unique knowledge

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
