#!/bin/bash
# MCP Server startup script with venv activation

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Debug logging
echo "🔍 MCP startup script called" >&2
echo "   SCRIPT_DIR: $SCRIPT_DIR" >&2
echo "   Current PATH: $PATH" >&2

# CRITICAL: Use the venv Python directly instead of relying on activation
VENV_PYTHON="$SCRIPT_DIR/venv/bin/python"

if [ ! -f "$VENV_PYTHON" ]; then
    echo "❌ Venv Python not found at: $VENV_PYTHON" >&2
    echo "   Please run: cd $SCRIPT_DIR && python3 -m venv venv && venv/bin/pip install -r requirements.txt" >&2
    exit 1
fi

# Set environment variables
export CODING_TOOLS_PATH="/Users/q284340/Agentic/coding"
export PYTHONPATH="/Users/q284340/Agentic/coding/integrations/mcp-server-semantic-analysis"

# Load environment variables from root .env file if not already set
if [ -z "$ANTHROPIC_API_KEY" ] || [ -z "$OPENAI_API_KEY" ]; then
    if [ -f "/Users/q284340/Agentic/coding/.env" ]; then
        set -a
        source "/Users/q284340/Agentic/coding/.env"
        set +a
    fi
fi

# Debug: Check Python and environment
echo "🐍 Using Python: $VENV_PYTHON" >&2
echo "   API keys present: ANTHROPIC=$([ -n "$ANTHROPIC_API_KEY" ] && echo "✅" || echo "❌"), OPENAI=$([ -n "$OPENAI_API_KEY" ] && echo "✅" || echo "❌")" >&2

# Run the MCP server with explicit venv Python
exec "$VENV_PYTHON" "$SCRIPT_DIR/working_mcp_server.py" "$@"