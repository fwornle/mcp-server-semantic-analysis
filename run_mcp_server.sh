#!/bin/bash

# MCP Server Python Wrapper Script
# This ensures the correct Python executable is used

# Log to a file to prove this script is running
LOG_FILE="/tmp/mcp_wrapper_execution.log"
echo "$(date): MCP wrapper script started" >> "$LOG_FILE"
echo "$(date): Called with args: $@" >> "$LOG_FILE"
echo "$(date): Process ID: $$" >> "$LOG_FILE"

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODING_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "$(date): SCRIPT_DIR=$SCRIPT_DIR" >> "$LOG_FILE"
echo "$(date): CODING_ROOT=$CODING_ROOT" >> "$LOG_FILE"

# Load environment variables from .env file
if [ -f "$CODING_ROOT/.env" ]; then
    # Use set -a to automatically export all variables
    set -a
    source "$CODING_ROOT/.env"
    set +a
    echo "✅ Loaded environment variables from .env file"
else
    echo "❌ Warning: .env file not found at $CODING_ROOT/.env"
    exit 1
fi

# Activate virtual environment
echo "$(date): Activating virtual environment..." >> "$LOG_FILE"
source "$SCRIPT_DIR/venv/bin/activate"
echo "$(date): Virtual environment activated" >> "$LOG_FILE"

# Export additional environment variables
export CODING_TOOLS_PATH="$CODING_ROOT"
export PYTHONPATH="$SCRIPT_DIR"

# Verify at least one API key is loaded
if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ] && [ -z "$CUSTOM_API_KEY" ]; then
    echo "❌ Error: No API keys found in .env file"
    echo "❌ Please set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, or CUSTOM_API_KEY"
    echo "❌ For custom endpoints, also set OPENAI_BASE_URL"
    exit 1
fi

# Log which API keys are available
if [ ! -z "$ANTHROPIC_API_KEY" ]; then
    echo "✅ ANTHROPIC_API_KEY detected"
    echo "$(date): ANTHROPIC_API_KEY available" >> "$LOG_FILE"
fi

if [ ! -z "$OPENAI_API_KEY" ]; then
    echo "✅ OPENAI_API_KEY detected"
    echo "$(date): OPENAI_API_KEY available" >> "$LOG_FILE"
fi

if [ ! -z "$CUSTOM_API_KEY" ]; then
    echo "✅ CUSTOM_API_KEY detected"
    echo "$(date): CUSTOM_API_KEY available" >> "$LOG_FILE"
fi

if [ ! -z "$OPENAI_BASE_URL" ]; then
    echo "✅ OPENAI_BASE_URL detected: $OPENAI_BASE_URL"
    echo "$(date): OPENAI_BASE_URL: $OPENAI_BASE_URL" >> "$LOG_FILE"
fi

echo "✅ API keys loaded from .env file"
echo "🐍 Using Python: $(which python)"
echo "📁 Working directory: $SCRIPT_DIR"

# Log which Python is being used
echo "$(date): Python executable: $(which python)" >> "$LOG_FILE"
echo "$(date): Python version: $(python --version 2>&1)" >> "$LOG_FILE"
echo "$(date): About to exec: $SCRIPT_DIR/venv/bin/python $SCRIPT_DIR/working_mcp_server.py" >> "$LOG_FILE"

# Run the MCP server with venv Python
exec "$SCRIPT_DIR/venv/bin/python" "$SCRIPT_DIR/working_mcp_server.py"