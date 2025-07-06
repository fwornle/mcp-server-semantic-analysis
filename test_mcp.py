#!/usr/bin/env python3
"""Test the enhanced MCP server via JSON-RPC"""

import json
import subprocess
import time

def test_mcp_server():
    # Start the MCP server process
    process = subprocess.Popen(
        ['./venv/bin/python', 'working_mcp_server.py'],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd='/Users/q284340/Agentic/coding/integrations/mcp-server-semantic-analysis'
    )
    
    try:
        # Initialize
        init_msg = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1.0.0"}
            }
        }
        
        process.stdin.write(json.dumps(init_msg) + '\n')
        process.stdin.flush()
        
        # Read response
        response = process.stdout.readline()
        print("Initialize response:", response.strip())
        
        # Send initialized notification
        initialized_msg = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }
        
        process.stdin.write(json.dumps(initialized_msg) + '\n')
        process.stdin.flush()
        
        # Test connection
        test_msg = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "test_connection",
                "arguments": {}
            }
        }
        
        process.stdin.write(json.dumps(test_msg) + '\n')
        process.stdin.flush()
        
        # Read response
        response = process.stdout.readline()
        print("Test connection response:", response.strip())
        
        # Test enhanced analyze_code
        analyze_msg = {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "analyze_code",
                "arguments": {
                    "code": "function test() { return 42; }",
                    "language": "javascript"
                }
            }
        }
        
        process.stdin.write(json.dumps(analyze_msg) + '\n')
        process.stdin.flush()
        
        # Read response
        response = process.stdout.readline()
        print("Analyze code response:", response.strip())
        
    finally:
        process.terminate()
        process.wait()

if __name__ == "__main__":
    test_mcp_server()