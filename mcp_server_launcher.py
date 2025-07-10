#!/usr/bin/env python3
"""
Robust MCP Server Launcher
This ensures we always use venv Python and have all dependencies available
"""

import os
import sys
import subprocess
from pathlib import Path

def main():
    # Get paths
    script_dir = Path(__file__).parent
    venv_python = script_dir / "venv" / "bin" / "python"
    mcp_server = script_dir / "working_mcp_server.py"
    
    # Check if we need to use venv Python
    if sys.executable != str(venv_python) and venv_python.exists():
        print(f"🔄 Switching to venv Python: {venv_python}", file=sys.stderr)
        
        # Preserve all environment variables
        env = os.environ.copy()
        
        # Execute with venv Python
        result = subprocess.run(
            [str(venv_python), str(mcp_server)] + sys.argv[1:],
            env=env
        )
        sys.exit(result.returncode)
    
    # We're already in the right Python, just import and run
    print(f"✅ Running with Python: {sys.executable}", file=sys.stderr)
    
    # Change to script directory and run
    os.chdir(script_dir)
    sys.path.insert(0, str(script_dir))
    
    # Import and run the MCP server
    import asyncio
    from working_mcp_server import main as mcp_main
    
    asyncio.run(mcp_main())

if __name__ == "__main__":
    main()