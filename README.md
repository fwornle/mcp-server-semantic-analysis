# Semantic Analysis MCP Server

A powerful multi-agent semantic analysis system built with Node.js and TypeScript, providing comprehensive code and conversation analysis capabilities through MCP (Model Context Protocol).

## Overview

This MCP server implements a sophisticated 6-agent architecture for semantic analysis:

- **Coordinator Agent** - Workflow orchestration and task coordination
- **Semantic Analysis Agent** - Core LLM analysis with multi-provider fallback (Custom → Anthropic → OpenAI)
- **Web Search Agent** - Context-aware search and external data gathering
- **Synchronization Agent** - Data sync and consistency management
- **Deduplication Agent** - Similarity detection and entity merging
- **Documentation Agent** - Automated documentation and report generation

## Features

### Multi-Interface Access
- **MCP Server** - Direct integration with Claude Code
- **HTTP API** - REST endpoints for VSCode CoPilot extension
- **CLI** - Command-line interface (`sal` command)

### API Key Flexibility
3-tier fallback system for maximum compatibility:
1. `ANTHROPIC_API_KEY` (Claude) - Primary
2. `OPENAI_API_KEY` (OpenAI) - Secondary  
3. `OPENAI_BASE_URL` + `OPENAI_API_KEY` (Custom OpenAI-compatible) - Tertiary
4. UKB-CLI fallback mode (no AI) - Final fallback

### Advanced Capabilities
- **Workflow Orchestration** - Complex multi-step analysis workflows
- **Quality Assurance** - Agent output validation and auto-correction
- **Event Sourcing** - Durable workflow state and recovery
- **Cross-Directory Execution** - Works from any directory
- **Incremental Analysis** - Delta analysis since last run
- **Knowledge Synchronization** - Multi-system data consistency

## Installation

This system is automatically installed as part of the main coding tools:

```bash
# Install the entire coding system (includes this semantic analysis server)
./install.sh
```

## Usage

### Command Line Interface

```bash
# Interactive semantic analysis
sal

# Repository analysis
sal --repository /path/to/repo

# Conversation analysis  
sal --conversation /path/to/conversation.md

# Incremental analysis since last run
sal --incremental

# Pattern extraction
sal --pattern "architectural-patterns,design-patterns"

# Check workflow status
sal --status

# Get help
sal --help
```

### MCP Tools (Claude Integration)

- `determine_insights` - Analyze repository or conversation for insights
- `analyze_repository` - Extract patterns and architectural analysis
- `update_knowledge_base` - Sync insights to knowledge systems
- `lessons_learned` - Extract lessons from code or conversations

### HTTP API (CoPilot Integration)

RESTful endpoints available at `http://localhost:8765` when running:

- `POST /analyze/repository` - Repository analysis
- `POST /analyze/conversation` - Conversation analysis  
- `POST /workflows/start` - Start custom workflow
- `GET /workflows/{id}/status` - Get workflow status

## Architecture

### Agent Responsibilities

1. **Coordinator** - Manages workflows, coordinates between agents, performs QA
2. **Semantic Analysis** - Core LLM-powered analysis with provider fallback
3. **Knowledge Graph** - Entity/relationship management, UKB integration
4. **Web Search** - Context gathering and validation
5. **Synchronization** - Data consistency across storage systems
6. **Deduplication** - Similarity detection and entity merging  
7. **Documentation** - Auto-generated reports and documentation

### Data Flow

```
User Request → Coordinator → Workflow Engine → Agents → QA Validation → Knowledge Sync → Results
```

### Storage Systems

- **MCP Memory** - Session-based memory for Claude integration
- **Graphology DB** - Graph database for CoPilot integration
- **Shared Memory Files** - Persistent JSON files for team sharing

## Configuration

Configuration is handled through environment variables:

```bash
# API Keys (3-tier fallback)
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key  
OPENAI_BASE_URL=your-custom-endpoint  # For custom OpenAI-compatible APIs

# Paths
CODING_TOOLS_PATH=/path/to/coding/repo

# Optional: Custom configuration
SEMANTIC_ANALYSIS_CONFIG=/path/to/config.json
```

## Development

### Setting up Development Environment

```bash
# Clone the repository (if developing standalone)
git clone <repository-url>
cd mcp-server-semantic-analysis

# Install dependencies
npm install

# Build the project
npm run build

# Start in development mode
npm run dev

# Start the MCP server
npm start

# Run tests (when available)
npm test
```

### Adding New Agents

1. Create agent file in `src/agents/` directory
2. Implement using TypeScript class patterns
3. Register with main server in `src/index.ts`
4. Add appropriate tool definitions and handlers

### Adding New Workflows

1. Add workflow method to `Coordinator` class
2. Register workflow in constructor
3. Implement workflow logic with proper error handling
4. Add tests and documentation

## Integration

This semantic analysis server integrates with:

- **Claude Code** - Via MCP server protocol
- **VSCode CoPilot** - Via HTTP API and bridge
- **UKB Tools** - Direct integration and fallback
- **Knowledge Management System** - Bi-directional sync
- **Git Repositories** - Direct analysis capabilities

## Troubleshooting

### Common Issues

1. **API Key Issues**: Check the 3-tier fallback chain
2. **Port Conflicts**: System uses intelligent port management
3. **Permission Issues**: Ensure proper file permissions
4. **Memory Issues**: Large repositories may need increased limits

### Logging

Comprehensive logging available at multiple levels:
- Agent-specific logs
- Workflow execution logs  
- API request/response logs
- Error and debugging logs

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

MIT License - See LICENSE file for details.