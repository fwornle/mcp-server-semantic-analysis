# MCP Server - Semantic Analysis

🚀 **Model Context Protocol (MCP) server for semantic analysis and knowledge management** - A standalone Node.js server providing AI-powered code analysis, pattern extraction, and knowledge base management through standardized MCP tools.

## Overview

This MCP server integrates seamlessly with Claude Code to provide advanced semantic analysis capabilities. Built entirely in Node.js with TypeScript, it offers **12 specialized tools** and **11 intelligent agents** for comprehensive code and knowledge analysis using an 8-agent workflow system.

### 🤖 Intelligent Agents (11 Total - 8 Core Workflow + 3 Supporting)

#### Core Workflow Agents (8-Agent System)
1. **`GitHistoryAgent`** - Analyzes git commits from checkpoint with architectural decisions
2. **`VibeHistoryAgent`** - Processes .specstory/history conversation files for context
3. **`SemanticAnalysisAgent`** - Deep code analysis correlating git and conversation data
4. **`WebSearchAgent`** - External pattern research and reference gathering
5. **`InsightGenerationAgent`** - Generates insights with PlantUML diagrams and patterns
6. **`ObservationGenerationAgent`** - Creates structured UKB-compatible observations
7. **`QualityAssuranceAgent`** - Validates outputs with auto-correction capabilities
8. **`PersistenceAgent`** - Manages knowledge base persistence and checkpoints

#### Supporting Agents
9. **`CoordinatorAgent`** - Workflow orchestration for the 8-agent system
10. **`SynchronizationAgent`** - Multi-source data synchronization
11. **`DeduplicationAgent`** - Semantic duplicate detection and merging

## ✨ Key Features

### 🔧 MCP Tools (12 Available)
- **`heartbeat`** - Connection health monitoring
- **`test_connection`** - Server connectivity verification
- **`determine_insights`** - AI-powered content insight extraction
- **`analyze_code`** - Code pattern and quality analysis
- **`analyze_repository`** - Repository-wide architecture analysis
- **`extract_patterns`** - Reusable design pattern identification
- **`create_ukb_entity_with_insight`** - Knowledge base entity creation
- **`execute_workflow`** - Coordinated 8-agent workflows
- **`generate_documentation`** - Automated documentation generation
- **`create_insight_report`** - Detailed analysis reports
- **`generate_plantuml_diagrams`** - Architecture diagram generation
- **`generate_lessons_learned`** - Lessons learned document creation

### 🔗 Integration Capabilities
- **Claude Code Integration** - Full MCP compatibility
- **Multiple LLM Providers** - Custom LLM (primary), Anthropic Claude (secondary), OpenAI GPT (fallback)
- **Knowledge Base Support** - UKB/VKB integration with shared-memory-*.json files
- **PlantUML Diagrams** - Architecture visualization
- **Web Search** - Technical documentation discovery
- **Git & Conversation Analysis** - Cross-correlates code changes with development discussions

### 🚀 Performance & Stability
- **Node.js Advantages** - No Python environment issues, stable connections
- **Smart Fallbacks** - Automatic provider switching on failures
- **Error Recovery** - Graceful degradation and retry logic
- **Checkpoint Management** - Prevents duplicate analysis work

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- API keys for LLM providers (Anthropic recommended, OpenAI optional)

### Installation

```bash
# Clone or navigate to the server directory
cd integrations/mcp-server-semantic-analysis

# Install dependencies
npm install

# Build the server
npm run build

# Test the installation
npm run dev
```

### Configuration

1. **API Keys Setup**: Configure in your environment or the parent system
2. **Claude Code Integration**: The server automatically integrates when started via `claude-mcp`
3. **LLM Provider Priority**: Custom LLM (primary) → Anthropic (secondary) → OpenAI (fallback)

### Usage with Claude Code

```bash
# Start Claude Code with MCP support
claude-mcp

# The semantic-analysis server will be automatically available
# Use any of the 12 tools directly in Claude conversations
```

## 🔧 API Reference Summary

### Tool Categories

#### Connection & Health
```typescript
heartbeat() → ServerStatus
test_connection() → ConnectionInfo
```

#### Analysis Tools
```typescript
determine_insights(content, context?, analysis_type?, provider?) → Insights
analyze_code(code, language?, file_path?, analysis_focus?) → CodeAnalysis
analyze_repository(repository_path, include_patterns?, exclude_patterns?, max_files?) → RepositoryAnalysis
extract_patterns(source, pattern_types?, context?) → ExtractedPatterns
```

#### Knowledge Management
```typescript
create_ukb_entity_with_insight(entity_name, entity_type, insights, significance?, tags?) → EntityCreationResult
execute_workflow(workflow_name, parameters?) → WorkflowResult
```

#### Documentation & Reporting
```typescript
generate_documentation(analysis_result, metadata?) → Documentation
create_insight_report(analysis_result, metadata?) → InsightReport
generate_plantuml_diagrams(diagram_type, content, name, analysis_result?) → PlantUMLDiagram
generate_lessons_learned(analysis_result, title?, metadata?) → LessonsLearned
```

## 🏗️ Architecture Overview

### 8-Agent Workflow System

```mermaid
graph TB
    subgraph "8-Agent Semantic Analysis Workflow"
        GIT[1. GitHistoryAgent<br/>Git Commits Analysis]
        VIBE[2. VibeHistoryAgent<br/>Conversation Analysis]
        SEM[3. SemanticAnalysisAgent<br/>Deep Code Analysis]
        WEB[4. WebSearchAgent<br/>External Research]
        INS[5. InsightGenerationAgent<br/>Insights & Diagrams]
        OBS[6. ObservationGenerationAgent<br/>Structured Observations]
        QA[7. QualityAssuranceAgent<br/>Validation & Correction]
        PER[8. PersistenceAgent<br/>Knowledge Base Update]
    end
    
    subgraph "Supporting Infrastructure"
        COORD[CoordinatorAgent<br/>Orchestration]
        SYNC[SynchronizationAgent]
        DEDUP[DeduplicationAgent]
    end
    
    COORD -->|Orchestrates| GIT
    GIT -->|Commits| SEM
    VIBE -->|Context| SEM
    SEM -->|Analysis| WEB
    WEB -->|Research| INS
    INS -->|Insights| OBS
    OBS -->|Observations| QA
    QA -->|Validated| PER
    PER -->|Updates| SYNC
    SYNC -->|Syncs| DEDUP
    
    style GIT fill:#e6f3ff
    style VIBE fill:#e6f3ff
    style SEM fill:#e6f3ff
    style WEB fill:#e6f3ff
    style INS fill:#e6f3ff
    style OBS fill:#e6f3ff
    style QA fill:#e6f3ff
    style PER fill:#e6f3ff
    style COORD fill:#fff2e6
    style SYNC fill:#e8f4fd
    style DEDUP fill:#e8f4fd
```

### System Architecture

```mermaid
graph TB
    subgraph "Claude Code Client"
        CLAUDE[Claude Interface]
    end
    
    subgraph "MCP Server Core"
        MCP[MCP Protocol Handler]
        TOOLS[Tool Layer<br/>12 Tools]
        AGENTS[Agent Layer<br/>11 Agents]
        INTEG[Integration Layer]
    end
    
    subgraph "External Services"
        CUSTOM[Custom LLM<br/>Primary]
        ANTHROPIC[Anthropic Claude<br/>Secondary]
        OPENAI[OpenAI GPT<br/>Fallback]
        SEARCH[Web Search APIs<br/>DuckDuckGo]
        KB[Knowledge Bases<br/>UKB/VKB]
        GIT[Git Repository]
        HIST[.specstory/history]
    end
    
    CLAUDE -->|MCP Protocol| MCP
    MCP --> TOOLS
    MCP --> AGENTS
    MCP --> INTEG
    
    AGENTS -->|Primary| CUSTOM
    AGENTS -->|Secondary| ANTHROPIC
    AGENTS -->|Fallback| OPENAI
    AGENTS --> SEARCH
    AGENTS --> KB
    AGENTS --> GIT
    AGENTS --> HIST
    
    style CLAUDE fill:#e8f4fd
    style MCP fill:#fff2e6
    style TOOLS fill:#e8f4fd
    style AGENTS fill:#e6f3ff
    style INTEG fill:#fff2e6
    style CUSTOM fill:#f5f5f5
    style ANTHROPIC fill:#f5f5f5
    style OPENAI fill:#f5f5f5
    style SEARCH fill:#f5f5f5
    style KB fill:#fff9e6
    style GIT fill:#e8f4fd
    style HIST fill:#e8f4fd
```

## 📚 Detailed Documentation

### Core Documentation
- **[Installation Guide](docs/installation/README.md)** - Complete setup and configuration
- **[Architecture Details](docs/architecture/README.md)** - Technical architecture and design patterns
- **[API Reference](docs/api/README.md)** - Complete tool and agent API documentation

### Diagrams and Visualizations
- **[Architecture Diagrams](docs/images/)** - PlantUML-generated system diagrams
- **[PlantUML Source](docs/puml/)** - Editable diagram source files

### Advanced Topics
- **[Agent Development](docs/architecture/agents.md)** - Creating custom agents
- **[Tool Extensions](docs/architecture/tools.md)** - Adding new MCP tools
- **[Integration Patterns](docs/architecture/integration.md)** - External system integration

## 🎯 Use Cases

### 1. **Full Semantic Analysis Workflow**
```typescript
// Execute complete 8-agent analysis
const workflow = await execute_workflow("complete-analysis", {
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

### 2. **Incremental Analysis**
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

### 3. **Pattern Extraction Pipeline**
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

## 🔌 Integration with Main System

This MCP server is designed to integrate seamlessly with the broader coding knowledge management system:

### Main System Architecture Integration
![Main System Integration](docs/images/mcp-server-architecture.png)

### Configuration Files
- **Template**: `claude-code-mcp.json` (with placeholders)
- **Processed**: `claude-code-mcp-processed.json` (actual paths)
- **Claude Config**: `~/.claude.json` (Claude Code configuration)

### Shared Knowledge
- **UKB Integration**: Creates and updates Universal Knowledge Base entities
- **VKB Compatibility**: Supports knowledge visualization workflows  
- **Cross-Session Persistence**: Maintains context across Claude sessions
- **Checkpoint Management**: Tracks analysis progress to avoid duplication

## 🚀 Performance & Stability

### Node.js Advantages
- **No Python Environment Issues** - Eliminates venv conflicts and dependency hell
- **Stable Connections** - No 60-second connection drops
- **Fast Startup** - Immediate availability
- **Resource Efficiency** - Lower memory footprint

### Provider Management
- **Smart Fallbacks** - Automatic provider switching on failures
- **Rate Limiting** - Built-in request throttling
- **Error Recovery** - Graceful degradation and retry logic

### Monitoring
- **Health Checks** - Built-in connection monitoring
- **Logging** - Structured logging with correlation IDs
- **Metrics** - Performance tracking and analytics

## 🛠️ Development

### Building from Source
```bash
# Development mode with watching
npm run watch

# Production build
npm run build

# Run tests
npm run test
```

### Project Structure
```mermaid
graph TD
    src["/src"]
    
    src --> index["index.ts<br/><small>MCP server entry point</small>"]
    src --> server["server.ts<br/><small>Core MCP server implementation</small>"]
    src --> tools["tools.ts<br/><small>Tool definitions and handlers</small>"]
    src --> logging["logging.ts<br/><small>Logging utilities</small>"]
    src --> agents["agents/<br/><small>Intelligent agent implementations</small>"]
    
    agents --> git["git-history-agent.ts"]
    agents --> vibe["vibe-history-agent.ts"]
    agents --> semantic["semantic-analysis-agent.ts"]
    agents --> web["web-search.ts"]
    agents --> insight["insight-generation-agent.ts"]
    agents --> observation["observation-generation-agent.ts"]
    agents --> qa["quality-assurance-agent.ts"]
    agents --> persistence["persistence-agent.ts"]
    agents --> coordinator["coordinator.ts"]
    agents --> sync["synchronization.ts"]
    agents --> dedup["deduplication.ts"]
    
    classDef mainFile fill:#e1f5fe,stroke:#0277bd,stroke-width:2px
    classDef agentFile fill:#f3e5f5,stroke:#7b1fa2,stroke-width:1px
    classDef folderStyle fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
    
    class index,server,tools,logging mainFile
    class git,vibe,semantic,web,insight,observation,qa,persistence,coordinator,sync,dedup agentFile
    class agents folderStyle
```

## 📄 License

MIT License - See parent project for details.

## 🤝 Contributing

This server is part of the larger coding knowledge management system. Contributions should align with the overall system architecture and patterns.

### Development Guidelines
- Follow TypeScript best practices
- Maintain MCP protocol compliance
- Add comprehensive tests for new tools/agents
- Update documentation for new features

## 📞 Support & Troubleshooting

For issues and support:
1. Check the [troubleshooting guide](docs/troubleshooting.md)
2. Review MCP server logs
3. Verify API key configuration
4. Test with simple tools first (`heartbeat`, `test_connection`)

---

**🔗 Related Projects:**
- [Main Coding System](../../README.md) - Parent project documentation
- [UKB Documentation](../../docs/ukb/README.md) - Universal Knowledge Base
- [VKB Documentation](../../docs/vkb/README.md) - Knowledge Visualization

**🏷️ Tags:** MCP, Semantic Analysis, Claude Code, Node.js, TypeScript, AI, Knowledge Management, 8-Agent System