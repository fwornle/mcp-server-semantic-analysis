# Installation Guide - MCP Server Semantic Analysis

This guide covers the complete installation and configuration of the MCP Semantic Analysis Server.

## Prerequisites

### System Requirements
- **Node.js**: Version 18.0.0 or higher
- **npm**: Version 8.0.0 or higher (included with Node.js)
- **Operating System**: macOS, Linux, or Windows
- **Memory**: Minimum 4GB RAM (8GB recommended)
- **Storage**: 500MB for server and dependencies

### API Keys
Configure at least one LLM provider. The system uses the following priority order:
1. **Groq** (Default - cheap, low-latency)
2. **Gemini** (Fallback #1 - cheap, good quality)
3. **Anthropic Claude** (Fallback #2 - high quality)
4. **OpenAI** (Fallback #3)

#### Groq (Default - Recommended)
```bash
export GROQ_API_KEY="your-groq-api-key"
```
- Uses: llama-3.3-70b-versatile
- Benefits: Low cost, low latency

#### Google Gemini (Optional Fallback #1)
```bash
export GOOGLE_API_KEY="your-google-api-key"
```
- Uses: gemini-2.0-flash-exp
- Benefits: Low cost, fast, good quality

#### Anthropic Claude (Optional Fallback #2)
```bash
export ANTHROPIC_API_KEY="your-anthropic-api-key"
```
- Uses: claude-sonnet-4-20250514
- Benefits: High quality, reliable

#### OpenAI (Optional Fallback #3)
```bash
export OPENAI_API_KEY="your-openai-api-key"
```
- Uses: gpt-4
- Benefits: Widely compatible

#### Custom OpenAI-Compatible (Optional)
```bash
export OPENAI_BASE_URL="https://your-custom-endpoint.com/v1"
export OPENAI_API_KEY="your-custom-api-key"
```

## Installation Methods

### Method 1: Part of Main System (Recommended)
If you're using the complete coding knowledge management system:

```bash
# Navigate to the main coding repository
cd /path/to/coding

# Run the complete installation
./install.sh

# The MCP server will be automatically installed and configured
```

### Method 2: Standalone Installation
For standalone deployment of just the MCP server:

```bash
# Clone or navigate to the server directory
cd integrations/mcp-server-semantic-analysis

# Install dependencies
npm install

# Build the TypeScript code
npm run build

# Test the installation
npm run test
```

## Configuration

### Environment Variables
Create a `.env` file or set environment variables:

```bash
# LLM Provider Configuration (at least one required)
# Provider priority: Groq → Gemini → Anthropic → OpenAI
GROQ_API_KEY=your-groq-key              # Default provider (cheap, low-latency)
GOOGLE_API_KEY=your-google-key          # Fallback #1 (cheap, good quality)
ANTHROPIC_API_KEY=your-anthropic-key    # Fallback #2 (high quality)
OPENAI_API_KEY=your-openai-key          # Fallback #3

# Optional: Custom Endpoints
OPENAI_BASE_URL=https://custom-endpoint.com/v1

# Optional: Server Configuration
MCP_SERVER_PORT=8765
LOG_LEVEL=info
ENABLE_METRICS=true

# Optional: Knowledge Base Integration
KNOWLEDGE_BASE_PATH=/path/to/knowledge-base
UKB_INTEGRATION=true
VKB_INTEGRATION=true
```

### Claude Code Integration
The server automatically integrates with Claude Code through MCP configuration:

1. **Automatic Configuration**: When using the main system's `./install.sh`
2. **Manual Configuration**: Update `~/.claude.json`

```json
{
  "mcpServers": {
    "semantic-analysis": {
      "command": "node",
      "args": ["/path/to/mcp-server-semantic-analysis/dist/index.js"],
      "env": {
        "GROQ_API_KEY": "your-groq-key",
        "GOOGLE_API_KEY": "your-google-key",
        "ANTHROPIC_API_KEY": "your-anthropic-key",
        "OPENAI_API_KEY": "your-openai-key"
      }
    }
  }
}
```

## Verification

### Test Server Functionality
```bash
# Start the server in development mode
npm run dev

# In another terminal, test MCP connectivity
# (This requires the main system's test tools)
claude-mcp
# Then use: test_connection() or heartbeat()
```

### Verify Tools
Check that all 12 tools are available:

```typescript
// In Claude Code session
heartbeat()                    // ✅ Connection health
test_connection()              // ✅ Server status
determine_insights(content)    // ✅ AI analysis
analyze_code(code)             // ✅ Code analysis
analyze_repository(path)       // ✅ Repository analysis
extract_patterns(source)       // ✅ Pattern extraction
create_ukb_entity(...)         // ✅ Knowledge creation
execute_workflow(name)         // ✅ Workflow execution
generate_documentation(...)    // ✅ Documentation
create_insight_report(...)     // ✅ Reporting
generate_plantuml_diagrams(...) // ✅ Diagrams
generate_lessons_learned(...)  // ✅ Lessons learned
```

### Verify Agents
Check that all 7 agents are operational:

- ✅ **CoordinatorAgent**: Workflow orchestration
- ✅ **SemanticAnalyzer**: LLM-powered analysis
- ✅ **KnowledgeManager**: Knowledge base integration
- ✅ **WebSearchAgent**: External search capabilities
- ✅ **SynchronizationAgent**: Data synchronization
- ✅ **DeduplicationAgent**: Duplicate detection
- ✅ **DocumentationAgent**: Document generation
- ✅ **RepositoryAnalyzer**: Repository analysis

## Troubleshooting

### Common Installation Issues

#### Node.js Version Issues
```bash
# Check Node.js version
node --version

# If version is too old, install Node.js 18+
# macOS with Homebrew:
brew install node@18

# Ubuntu/Debian:
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

#### Permission Issues
```bash
# Fix npm permission issues (macOS/Linux)
sudo chown -R $(whoami) ~/.npm
sudo chown -R $(whoami) /usr/local/lib/node_modules

# Or use Node Version Manager (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 18
nvm use 18
```

#### TypeScript Build Issues
```bash
# Clear npm cache
npm cache clean --force

# Remove node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Rebuild
npm run build
```

#### API Key Issues
```bash
# Test Groq API key validity
curl -H "Authorization: Bearer $GROQ_API_KEY" \
     https://api.groq.com/openai/v1/models

# Test Google Gemini API key validity
curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GOOGLE_API_KEY"

# Test Anthropic API key validity
curl -H "Authorization: Bearer $ANTHROPIC_API_KEY" \
     https://api.anthropic.com/v1/models

# Test OpenAI API key validity
curl -H "Authorization: Bearer $OPENAI_API_KEY" \
     https://api.openai.com/v1/models
```

### MCP Connection Issues

#### Server Not Starting
```bash
# Check for port conflicts
lsof -i :8765

# Check logs
npm run dev 2>&1 | tee server.log

# Verify Node.js process
ps aux | grep "semantic-analysis"
```

#### Claude Code Not Connecting
```bash
# Verify MCP configuration
cat ~/.claude.json | jq .mcpServers

# Check Claude Code can find the server
which node
ls -la /path/to/mcp-server-semantic-analysis/dist/index.js

# Test server directly
node /path/to/mcp-server-semantic-analysis/dist/index.js
```

#### Tools Not Available
```bash
# Verify build completed successfully
ls -la dist/

# Check for TypeScript errors
npm run build --verbose

# Verify tool registration
grep -r "TOOLS" src/
```

### Performance Issues

#### Memory Usage
```bash
# Monitor memory usage
ps aux | grep node
top -p $(pgrep -f semantic-analysis)

# Increase Node.js heap size if needed
export NODE_OPTIONS="--max-old-space-size=8192"
```

#### Slow LLM Responses
```bash
# Test provider connectivity
curl -w "@curl-format.txt" -H "Authorization: Bearer $ANTHROPIC_API_KEY" \
     https://api.anthropic.com/v1/messages

# Check rate limiting
grep -i "rate" server.log
```

## Advanced Configuration

### Custom Agent Configuration
```typescript
// src/config.ts
export const agentConfig = {
  coordinator: {
    maxConcurrentTasks: 5,
    timeoutMs: 300000,
    enableQA: true
  },
  semantic: {
    preferredProvider: "groq",
    fallbackProviders: ["gemini", "anthropic", "openai"],
    maxTokens: 4000
  },
  webSearch: {
    provider: "duckduckgo",
    maxResults: 10,
    timeoutMs: 30000
  }
};
```

### Knowledge Base Integration
```bash
# Configure knowledge base paths
export KNOWLEDGE_BASE_PATH=/path/to/shared-memory-files
export UKB_COMMAND_PATH=/path/to/ukb
export VKB_SERVER_URL=http://localhost:8080
```

### Logging Configuration
```bash
# Enable detailed logging
export LOG_LEVEL=debug
export ENABLE_REQUEST_LOGGING=true
export LOG_FILE_PATH=/var/log/semantic-analysis.log
```

## Maintenance

### Updates
```bash
# Update dependencies
npm update

# Rebuild after updates
npm run build

# Restart server
npm run dev
```

### Monitoring
```bash
# Check server health
curl http://localhost:8765/health

# Monitor logs
tail -f /var/log/semantic-analysis.log

# Check resource usage
htop -p $(pgrep -f semantic-analysis)
```

### Backup
```bash
# Backup configuration
cp ~/.claude.json ~/.claude.json.backup

# Backup knowledge base files
tar -czf knowledge-backup.tar.gz /path/to/shared-memory-*.json
```

## Next Steps

After successful installation:

1. **Read the [Architecture Guide](../architecture/README.md)** - Understand the system design
2. **Review the [API Reference](../api/README.md)** - Learn about available tools and agents
3. **Try [Use Cases](../use-cases/README.md)** - Practical examples and workflows
4. **Set up [Monitoring](../monitoring/README.md)** - Production monitoring and alerting

## Support

For additional help:
- Check the [Troubleshooting Guide](../troubleshooting/README.md)
- Review [Common Issues](../troubleshooting/common-issues.md)
- See [Performance Tuning](../troubleshooting/performance.md)