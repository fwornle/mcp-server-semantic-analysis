#!/usr/bin/env python3
"""
DEBUG SCRIPT FOR MCP INTEGRATION ISSUE
=====================================

This script tests the MCP integration issue that has been happening for 20+ sessions.

KEY FACTS (to remember across sessions):
- We use Python3 (not python)
- We use venv: ./venv/bin/python3
- Debug log is at: /tmp/mcp_debug.log
- DocumentationAgent works fine standalone
- MCP server starts correctly 
- Issue is MCP connection/tool calls

WHAT WE'VE TRIED:
- Direct agent testing ✅ (works)
- MCP server startup ✅ (works) 
- Manual tool calls ❌ (fails)

NEXT STEPS:
1. Call MCP tool directly
2. Check debug log immediately 
3. Fix based on actual debug output
"""

import sys
import os
import json
import asyncio
from pathlib import Path

# Add paths for imports
sys.path.insert(0, str(Path(__file__).parent / "agents"))
sys.path.insert(0, str(Path(__file__).parent / "config"))

def check_debug_log():
    """Check the debug log file for recent entries."""
    log_file = "/tmp/mcp_debug.log"
    if os.path.exists(log_file):
        with open(log_file, 'r') as f:
            lines = f.readlines()
            print(f"📋 Debug log has {len(lines)} lines")
            if lines:
                print("📋 Last 10 lines:")
                for line in lines[-10:]:
                    print(f"  {line.strip()}")
            return lines
    else:
        print(f"❌ Debug log file not found: {log_file}")
        return []

def clear_debug_log():
    """Clear the debug log for a fresh test."""
    log_file = "/tmp/mcp_debug.log"
    try:
        with open(log_file, 'w') as f:
            f.write(f"🔍 DEBUG LOG CLEARED AT {asyncio.get_event_loop().time()}\n")
        print(f"✅ Debug log cleared: {log_file}")
    except Exception as e:
        print(f"⚠️  Could not clear debug log: {e}")

async def test_direct_agent():
    """Test DocumentationAgent directly (we know this works)."""
    try:
        from agents.documentation import DocumentationAgent
        from config.agent_config import AgentConfig
        
        agent_config = AgentConfig()
        agent_defs = agent_config.get_agent_definitions()
        doc_def = agent_defs['documentation']
        
        doc_agent = DocumentationAgent(
            name=doc_def.name,
            config=doc_def.config,
            system=None
        )
        
        await doc_agent.initialize()
        print(f"✅ Direct agent test: {len(doc_agent._event_handlers)} handlers")
        
        result = await doc_agent.handle_event('generate_analysis_doc', {
            'analysis_result': {'test': 'integration_debug'},
            'metadata': {'debug': True}
        })
        
        print(f"✅ Direct event result: {result.get('success', False)}")
        return True
        
    except Exception as e:
        print(f"❌ Direct agent test failed: {e}")
        return False

def write_session_notes():
    """Write session notes for next restart."""
    notes = """
# MCP INTEGRATION DEBUG SESSION NOTES

## CURRENT STATUS (Session {})
- MCP server starts correctly 
- All agents initialize with proper event handlers
- DocumentationAgent has 10 event handlers when tested directly
- Issue: MCP tool calls don't reach the server properly

## DEBUG LOG LOCATION
/tmp/mcp_debug.log

## KEY COMMANDS FOR NEXT SESSION
```bash
# Check if MCP server is running
ps aux | grep working_mcp_server

# Test MCP tool call directly (in Claude Code)
# Look for: mcp__semantic-analysis__generate_documentation

# Check debug log immediately after
cat /tmp/mcp_debug.log | tail -20
```

## VIRTUAL ENV PATH
./venv/bin/python3

## PYTHON COMMAND
python3 (NOT python)

## REMEMBER: 
The agents work fine. The MCP server starts fine. 
The issue is specifically with MCP tool call routing.
""".format("CURRENT")
    
    with open("/Users/q284340/Agentic/coding/integrations/mcp-server-semantic-analysis/SESSION_DEBUG_NOTES.md", "w") as f:
        f.write(notes)
    
    print("✅ Session notes written to SESSION_DEBUG_NOTES.md")

if __name__ == "__main__":
    print("🔍 MCP INTEGRATION DEBUG SCRIPT")
    print("=" * 50)
    
    # Clear debug log for fresh test
    clear_debug_log()
    
    # Test direct agent (should work)
    print("\n1. Testing direct agent...")
    direct_result = asyncio.run(test_direct_agent())
    
    # Check current debug log
    print("\n2. Checking current debug log...")
    check_debug_log()
    
    # Write session notes
    print("\n3. Writing session notes...")
    write_session_notes()
    
    print("\n🔍 DEBUG COMPLETE")
    print("Next: Call MCP tool in Claude Code, then check debug log")
    print("Debug log: /tmp/mcp_debug.log")