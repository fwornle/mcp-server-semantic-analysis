#!/usr/bin/env python3
"""
Debug MCP server agent initialization.
"""

import asyncio
import sys
from pathlib import Path
import json

# Add the project root to path
sys.path.insert(0, str(Path(__file__).parent))

from working_mcp_server import AgentManager
from config.agent_config import AgentConfig


async def debug_mcp_agents():
    """Debug MCP server agent initialization."""
    print("🔍 Debugging MCP server agent initialization...")
    
    # Create agent manager
    agent_manager = AgentManager()
    
    try:
        await agent_manager.initialize()
        print("✅ Agent manager initialized successfully")
        
        # Check which agents are loaded
        print(f"📋 Loaded agents: {list(agent_manager.agents.keys())}")
        
        # Check if documentation agent is loaded
        if 'documentation' in agent_manager.agents:
            print("✅ DocumentationAgent is loaded")
            doc_agent = agent_manager.agents['documentation']
            print(f"📋 DocumentationAgent capabilities: {doc_agent.capabilities}")
            print(f"📋 DocumentationAgent event handlers: {list(doc_agent._event_handlers.keys())}")
            
            # Test the event handler
            test_data = {
                "analysis_result": {
                    "test": "simple test",
                    "timestamp": "2025-07-06",
                    "findings": ["Test finding 1", "Test finding 2"]
                },
                "metadata": {
                    "repository": "test-repo",
                    "analysis_type": "test"
                }
            }
            
            try:
                result = await doc_agent.handle_event("generate_analysis_doc", test_data)
                print(f"✅ Event handler result type: {type(result)}")
                print(f"✅ Event handler result: {json.dumps(result, indent=2)[:500]}...")
                return result is not None
            except Exception as e:
                print(f"❌ Event handler failed: {e}")
                import traceback
                traceback.print_exc()
                return False
                
        else:
            print("❌ DocumentationAgent not loaded")
            return False
            
    except Exception as e:
        print(f"❌ Failed to initialize agent manager: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(debug_mcp_agents())
    sys.exit(0 if success else 1)