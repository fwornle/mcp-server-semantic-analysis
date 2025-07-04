#!/usr/bin/env python3
"""
Simple MCP server for semantic analysis functionality.
Replaces the complex multi-agent system with a basic working implementation.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional, Sequence
from mcp.server import Server
from mcp.types import (
    Tool,
    TextContent,
    CallToolRequest,
    CallToolResult,
    ListToolsResult,
    ServerCapabilities,
    ToolsCapability,
    InitializeResult,
)
from mcp.server.stdio import stdio_server
import sys
import json
from pathlib import Path

# Set up simple logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class SemanticAnalysisServer:
    """Simple MCP server for semantic analysis."""
    
    def __init__(self):
        self.server = Server("semantic-analysis")
        self.coding_tools_path = Path(__file__).parent.parent.parent
        self.knowledge_base_path = self.coding_tools_path / "shared-memory-coding.json"
        
        # Register handlers
        self.server.list_tools = self.list_tools
        self.server.call_tool = self.call_tool
        
    async def list_tools(self) -> ListToolsResult:
        """List available tools."""
        tools = [
            Tool(
                name="analyze_code",
                description="Analyze code for patterns and insights",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "code": {"type": "string", "description": "Code to analyze"},
                        "language": {"type": "string", "description": "Programming language"},
                        "context": {"type": "string", "description": "Additional context"}
                    },
                    "required": ["code"]
                }
            ),
            Tool(
                name="extract_patterns",
                description="Extract reusable patterns from code",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "source": {"type": "string", "description": "Source code or text"},
                        "pattern_type": {"type": "string", "description": "Type of pattern to extract"}
                    },
                    "required": ["source"]
                }
            ),
            Tool(
                name="search_knowledge",
                description="Search the knowledge base",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "entity_type": {"type": "string", "description": "Entity type to search for"}
                    },
                    "required": ["query"]
                }
            )
        ]
        
        return ListToolsResult(tools=tools)
    
    async def call_tool(self, request: CallToolRequest) -> CallToolResult:
        """Handle tool calls."""
        try:
            if request.name == "analyze_code":
                return await self._analyze_code(request.arguments)
            elif request.name == "extract_patterns":
                return await self._extract_patterns(request.arguments)
            elif request.name == "search_knowledge":
                return await self._search_knowledge(request.arguments)
            else:
                raise ValueError(f"Unknown tool: {request.name}")
                
        except Exception as e:
            logger.error(f"Error in tool call {request.name}: {e}")
            return CallToolResult(
                content=[TextContent(
                    type="text",
                    text=f"Error: {str(e)}"
                )]
            )
    
    async def _analyze_code(self, args: Dict[str, Any]) -> CallToolResult:
        """Analyze code for patterns and insights."""
        code = args.get("code", "")
        language = args.get("language", "unknown")
        context = args.get("context", "")
        
        # Simple analysis
        lines = code.split('\n')
        analysis = {
            "language": language,
            "lines_of_code": len(lines),
            "functions": len([line for line in lines if 'def ' in line or 'function ' in line]),
            "classes": len([line for line in lines if 'class ' in line]),
            "imports": len([line for line in lines if 'import ' in line or 'from ' in line]),
            "context": context
        }
        
        result = f"Code Analysis Results:\n"
        result += f"Language: {analysis['language']}\n"
        result += f"Lines of Code: {analysis['lines_of_code']}\n"
        result += f"Functions: {analysis['functions']}\n"
        result += f"Classes: {analysis['classes']}\n"
        result += f"Imports: {analysis['imports']}\n"
        
        if context:
            result += f"Context: {context}\n"
        
        return CallToolResult(
            content=[TextContent(type="text", text=result)]
        )
    
    async def _extract_patterns(self, args: Dict[str, Any]) -> CallToolResult:
        """Extract reusable patterns from code."""
        source = args.get("source", "")
        pattern_type = args.get("pattern_type", "general")
        
        # Simple pattern extraction
        patterns = []
        
        if "class " in source:
            patterns.append("Class Definition Pattern")
        if "def " in source:
            patterns.append("Function Definition Pattern")
        if "import " in source:
            patterns.append("Import Pattern")
        if "try:" in source and "except:" in source:
            patterns.append("Exception Handling Pattern")
        if "with " in source:
            patterns.append("Context Manager Pattern")
        
        result = f"Extracted Patterns ({pattern_type}):\n"
        for i, pattern in enumerate(patterns, 1):
            result += f"{i}. {pattern}\n"
        
        if not patterns:
            result += "No recognizable patterns found.\n"
        
        return CallToolResult(
            content=[TextContent(type="text", text=result)]
        )
    
    async def _search_knowledge(self, args: Dict[str, Any]) -> CallToolResult:
        """Search the knowledge base."""
        query = args.get("query", "")
        entity_type = args.get("entity_type", "")
        
        # Simple knowledge base search
        try:
            if self.knowledge_base_path.exists():
                with open(self.knowledge_base_path, 'r') as f:
                    knowledge_data = json.load(f)
                
                results = []
                entities = knowledge_data.get("entities", {})
                
                for entity_name, entity_data in entities.items():
                    if query.lower() in entity_name.lower():
                        results.append(f"Entity: {entity_name}")
                        if "observations" in entity_data:
                            for obs in entity_data["observations"][:2]:  # Limit to 2 observations
                                results.append(f"  - {obs}")
                
                if results:
                    result = f"Knowledge Base Search Results for '{query}':\n"
                    result += "\n".join(results)
                else:
                    result = f"No results found for '{query}' in knowledge base."
            else:
                result = "Knowledge base file not found."
                
        except Exception as e:
            result = f"Error searching knowledge base: {e}"
        
        return CallToolResult(
            content=[TextContent(type="text", text=result)]
        )

async def main():
    """Run the MCP server."""
    server_instance = SemanticAnalysisServer()
    
    logger.info("Starting Simple Semantic Analysis MCP Server...")
    
    # Run the server using stdio_server
    async with stdio_server(server_instance.server) as (read_stream, write_stream):
        await server_instance.server.run(
            read_stream, write_stream, server_instance.server.request_handlers, server_instance.server.notification_handlers
        )

if __name__ == "__main__":
    asyncio.run(main())