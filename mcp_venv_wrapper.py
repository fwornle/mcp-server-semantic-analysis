#!/usr/bin/env python3
"""
MCP Server Wrapper that ensures venv Python is used
This wrapper activates the venv and then imports the actual MCP server
"""

import os
import sys
import subprocess
from pathlib import Path

# Get the directory of this script
SCRIPT_DIR = Path(__file__).parent
VENV_PYTHON = SCRIPT_DIR / "venv" / "bin" / "python"

# Check if we're already running in the venv
if sys.executable != str(VENV_PYTHON):
    print(f"🔄 Re-executing with venv Python: {VENV_PYTHON}", file=sys.stderr)
    
    # Re-execute this script with venv Python, preserving all arguments and environment
    os.execv(str(VENV_PYTHON), [str(VENV_PYTHON)] + sys.argv)
    # This line should never be reached
    sys.exit(1)

# Now we're definitely in venv, import and run the actual MCP server
print(f"✅ Running with venv Python: {sys.executable}", file=sys.stderr)

# Add the directory to sys.path so imports work
sys.path.insert(0, str(SCRIPT_DIR))

# Import and run the actual MCP server
import asyncio
from working_mcp_server import main

if __name__ == "__main__":
    asyncio.run(main())