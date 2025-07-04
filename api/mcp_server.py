"""
MCP Server Implementation for Semantic Analysis
Preserves exact tool interface compatibility for Claude integration
"""

import asyncio
import json
import os
import sys
from typing import Dict, Any, List, Optional, Sequence
from pathlib import Path

# MCP imports
from mcp.server import Server
from mcp.types import (
    Resource,
    Tool,
    TextContent,
    ImageContent,
    EmbeddedResource,
    LoggingLevel,
)
import mcp.server.stdio
import mcp.types as types

# Import our system
from semantic_analysis.core import get_system, initialize_system
from config.logging_config import get_logger

logger = get_logger("mcp_server")


class SemanticAnalysisMCPServer:
    """
    MCP Server for Semantic Analysis System.
    Preserves exact tool interface from the original system.
    """
    
    def __init__(self):
        self.server = Server("semantic-analysis")
        self.system = None
        
        # Register MCP tools with exact same interface as original
        self._register_tools()
        self._register_resources()
    
    def _register_tools(self):
        """Register MCP tools with preserved interface."""
        
        @self.server.list_tools()
        async def handle_list_tools() -> List[Tool]:
            """List available semantic analysis tools."""
            return [
                Tool(
                    name="determine_insights",
                    description="Determine insights from repository or conversation analysis",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "repository": {
                                "type": "string",
                                "description": "Path to repository for analysis"
                            },
                            "conversationContext": {
                                "type": "string", 
                                "description": "Path to conversation file for analysis"
                            },
                            "depth": {
                                "type": "integer",
                                "description": "Analysis depth (number of commits/items to analyze)",
                                "default": 10
                            },
                            "significanceThreshold": {
                                "type": "integer",
                                "description": "Minimum significance threshold (1-10)",
                                "default": 7
                            }
                        },
                        "anyOf": [
                            {"required": ["repository"]},
                            {"required": ["conversationContext"]}
                        ]
                    }
                ),
                
                Tool(
                    name="analyze_repository",
                    description="Analyze repository for patterns and insights",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "repository": {
                                "type": "string",
                                "description": "Path to repository for analysis"
                            },
                            "depth": {
                                "type": "integer",
                                "description": "Number of commits to analyze",
                                "default": 10
                            },
                            "significanceThreshold": {
                                "type": "integer", 
                                "description": "Minimum significance threshold (1-10)",
                                "default": 7
                            },
                            "includeFiles": {
                                "type": "boolean",
                                "description": "Include file-level analysis",
                                "default": False
                            }
                        },
                        "required": ["repository"]
                    }
                ),
                
                Tool(
                    name="update_knowledge_base",
                    description="Update knowledge base with insights",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "insights": {
                                "type": "array",
                                "description": "Array of insights to add to knowledge base",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": {"type": "string"},
                                        "type": {"type": "string"},
                                        "significance": {"type": "integer"},
                                        "observations": {
                                            "type": "array",
                                            "items": {"type": "string"}
                                        }
                                    }
                                }
                            },
                            "source": {
                                "type": "string",
                                "description": "Source of the insights",
                                "default": "manual"
                            },
                            "priority": {
                                "type": "string",
                                "description": "Priority level",
                                "enum": ["low", "normal", "high"],
                                "default": "normal"
                            }
                        },
                        "required": ["insights"]
                    }
                ),
                
                Tool(
                    name="lessons_learned",
                    description="Extract lessons learned from conversations or code",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "Content to analyze for lessons"
                            },
                            "source": {
                                "type": "string",
                                "description": "Source path or identifier"
                            },
                            "extractPatterns": {
                                "type": "boolean",
                                "description": "Extract patterns from lessons",
                                "default": True
                            }
                        },
                        "required": ["content"]
                    }
                ),
                
                Tool(
                    name="get_workflow_status",
                    description="Get status of running workflows",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "workflowId": {
                                "type": "string",
                                "description": "Specific workflow ID to check (optional)"
                            }
                        }
                    }
                ),
                
                Tool(
                    name="search_knowledge",
                    description="Search the knowledge base for entities and insights",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "Search query"
                            },
                            "entityType": {
                                "type": "string",
                                "description": "Filter by entity type (optional)"
                            },
                            "minSignificance": {
                                "type": "integer",
                                "description": "Minimum significance level",
                                "default": 5
                            },
                            "limit": {
                                "type": "integer",
                                "description": "Maximum number of results",
                                "default": 10
                            }
                        },
                        "required": ["query"]
                    }
                )
            ]
        
        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> Sequence[types.TextContent | types.ImageContent | types.EmbeddedResource]:
            """Handle tool calls with preserved interface."""
            try:
                # Ensure system is initialized
                if not self.system:
                    self.system = await initialize_system()
                
                logger.info(f"MCP tool called: {name}", arguments=arguments)
                
                # Route to appropriate handler
                if name == "determine_insights":
                    result = await self._handle_determine_insights(arguments)
                elif name == "analyze_repository":
                    result = await self._handle_analyze_repository(arguments)
                elif name == "update_knowledge_base":
                    result = await self._handle_update_knowledge_base(arguments)
                elif name == "lessons_learned":
                    result = await self._handle_lessons_learned(arguments)
                elif name == "get_workflow_status":
                    result = await self._handle_get_workflow_status(arguments)
                elif name == "search_knowledge":
                    result = await self._handle_search_knowledge(arguments)
                else:
                    result = {"error": f"Unknown tool: {name}"}
                
                # Format result for MCP
                return [TextContent(type="text", text=self._format_result(result))]
                
            except Exception as e:
                logger.error(f"Tool {name} failed", error=str(e))
                error_result = {"error": str(e), "tool": name}
                return [TextContent(type="text", text=self._format_result(error_result))]
    
    def _register_resources(self):
        """Register MCP resources."""
        
        @self.server.list_resources()
        async def handle_list_resources() -> List[Resource]:
            """List available resources."""
            return [
                Resource(
                    uri="semantic-analysis://status",
                    name="System Status",
                    description="Current status of the semantic analysis system",
                    mimeType="application/json"
                ),
                Resource(
                    uri="semantic-analysis://agents",
                    name="Agent Information", 
                    description="Information about available agents",
                    mimeType="application/json"
                ),
                Resource(
                    uri="semantic-analysis://workflows",
                    name="Workflow Definitions",
                    description="Available workflow definitions",
                    mimeType="application/json"
                )
            ]
        
        @self.server.read_resource()
        async def handle_read_resource(uri: str) -> str:
            """Handle resource read requests."""
            try:
                if not self.system:
                    self.system = await initialize_system()
                
                if uri == "semantic-analysis://status":
                    status = self.system.get_system_status()
                    return json.dumps(status, indent=2)
                
                elif uri == "semantic-analysis://agents":
                    agent_info = {}
                    for agent_name, agent in self.system.agents.items():
                        agent_info[agent_name] = {
                            "running": agent.running,
                            "capabilities": agent.capabilities
                        }
                    return json.dumps(agent_info, indent=2)
                
                elif uri == "semantic-analysis://workflows":
                    workflows = list(self.system.workflows.keys())
                    return json.dumps({"workflows": workflows}, indent=2)
                
                else:
                    return json.dumps({"error": f"Unknown resource: {uri}"})
                    
            except Exception as e:
                return json.dumps({"error": str(e)})
    
    async def _handle_determine_insights(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Handle determine_insights tool calls."""
        try:
            repository = params.get("repository")
            conversation_context = params.get("conversationContext")
            depth = params.get("depth", 10)
            significance_threshold = params.get("significanceThreshold", 7)
            
            if repository:
                # Repository analysis
                result = await self.system.analyze_repository(
                    repository, 
                    depth=depth,
                    significance_threshold=significance_threshold
                )
            elif conversation_context:
                # Conversation analysis
                result = await self.system.analyze_conversation(
                    conversation_context,
                    extract_insights=True
                )
            else:
                return {"error": "Either repository or conversationContext must be provided"}
            
            # Extract insights from result
            insights = self._extract_insights_from_result(result)
            
            return {
                "success": True,
                "insights": insights,
                "source": repository or conversation_context,
                "parameters": {
                    "depth": depth,
                    "significance_threshold": significance_threshold
                }
            }
            
        except Exception as e:
            return {"error": str(e)}
    
    async def _handle_analyze_repository(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Handle analyze_repository tool calls."""
        try:
            repository = params["repository"]
            depth = params.get("depth", 10)
            significance_threshold = params.get("significanceThreshold", 7)
            include_files = params.get("includeFiles", False)
            
            result = await self.system.analyze_repository(
                repository,
                depth=depth,
                significance_threshold=significance_threshold,
                include_files=include_files
            )
            
            return {
                "success": True,
                "analysis": result,
                "repository": repository,
                "parameters": {
                    "depth": depth,
                    "significance_threshold": significance_threshold,
                    "include_files": include_files
                }
            }
            
        except Exception as e:
            return {"error": str(e)}
    
    async def _handle_update_knowledge_base(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Handle update_knowledge_base tool calls."""
        try:
            insights = params["insights"]
            source = params.get("source", "manual")
            priority = params.get("priority", "normal")
            
            # Convert insights to entities
            entities_data = []
            for insight in insights:
                entities_data.append({
                    "name": insight["name"],
                    "entity_type": insight.get("type", "Insight"),
                    "significance": insight.get("significance", 5),
                    "observations": insight.get("observations", []),
                    "metadata": {
                        "source": source,
                        "priority": priority
                    }
                })
            
            # Create entities through knowledge graph agent
            kg_agent = self.system.agents.get("knowledge_graph")
            if not kg_agent:
                return {"error": "Knowledge graph agent not available"}
            
            result = await kg_agent.handle_event("create_entities", {
                "entities": entities_data
            })
            
            return {
                "success": True,
                "summary": f"Added {result.get('created', 0)} entities to knowledge base",
                "details": result,
                "source": source
            }
            
        except Exception as e:
            return {"error": str(e)}
    
    async def _handle_lessons_learned(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Handle lessons_learned tool calls."""
        try:
            content = params["content"]
            source = params.get("source", "manual")
            extract_patterns = params.get("extractPatterns", True)
            
            # Analyze content for lessons
            semantic_agent = self.system.agents.get("semantic_analysis")
            if not semantic_agent:
                return {"error": "Semantic analysis agent not available"}
            
            # Perform lesson extraction analysis
            result = await semantic_agent.analyze(
                "insight_generation",
                content,
                {
                    "extract_patterns": extract_patterns,
                    "focus": "lessons_learned"
                }
            )
            
            # Extract structured lessons
            lessons = self._extract_lessons_from_result(result)
            
            return {
                "success": True,
                "lessons": lessons,
                "source": source,
                "patterns_extracted": extract_patterns
            }
            
        except Exception as e:
            return {"error": str(e)}
    
    async def _handle_get_workflow_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Handle get_workflow_status tool calls."""
        try:
            workflow_id = params.get("workflowId")
            
            coordinator = self.system.agents.get("coordinator")
            if not coordinator:
                return {"error": "Coordinator agent not available"}
            
            if workflow_id:
                # Get specific workflow status
                status = await coordinator.get_workflow_status(workflow_id)
                return {"success": True, "workflow": status}
            else:
                # Get all active workflows
                active_workflows = {}
                for wf_id, execution in coordinator.active_workflows.items():
                    active_workflows[wf_id] = {
                        "name": execution.name,
                        "status": execution.status.value,
                        "current_step": execution.current_step_index,
                        "total_steps": len(execution.steps)
                    }
                
                return {
                    "success": True,
                    "active_workflows": active_workflows,
                    "count": len(active_workflows)
                }
            
        except Exception as e:
            return {"error": str(e)}
    
    async def _handle_search_knowledge(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Handle search_knowledge tool calls."""
        try:
            query = params["query"]
            entity_type = params.get("entityType")
            min_significance = params.get("minSignificance", 5)
            limit = params.get("limit", 10)
            
            kg_agent = self.system.agents.get("knowledge_graph")
            if not kg_agent:
                return {"error": "Knowledge graph agent not available"}
            
            # Perform search
            result = await kg_agent.search_entities(query, "local")
            
            if not result["success"]:
                return result
            
            # Filter results
            entities = result["entities"]
            
            # Filter by entity type if specified
            if entity_type:
                entities = [e for e in entities if e["type"] == entity_type]
            
            # Filter by significance
            entities = [e for e in entities if e["significance"] >= min_significance]
            
            # Limit results
            entities = entities[:limit]
            
            return {
                "success": True,
                "query": query,
                "entities": entities,
                "count": len(entities),
                "filters": {
                    "entity_type": entity_type,
                    "min_significance": min_significance,
                    "limit": limit
                }
            }
            
        except Exception as e:
            return {"error": str(e)}
    
    def _extract_insights_from_result(self, result: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Extract insights from analysis result."""
        insights = []
        
        if result.get("success") and "result" in result:
            analysis_result = result["result"]
            
            # Try to extract structured insights
            if isinstance(analysis_result, dict):
                if "insights" in analysis_result:
                    insights = analysis_result["insights"]
                elif "structured" in analysis_result and analysis_result["structured"]:
                    # Convert structured data to insights
                    for key, value in analysis_result["structured"].items():
                        insights.append({
                            "title": key.replace("_", " ").title(),
                            "description": str(value),
                            "type": "pattern",
                            "significance": 6
                        })
                else:
                    # Create a general insight from the analysis
                    insights.append({
                        "title": "Analysis Result",
                        "description": str(analysis_result.get("analysis", "Analysis completed")),
                        "type": "general",
                        "significance": 5
                    })
        
        return insights
    
    def _extract_lessons_from_result(self, result: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Extract lessons from analysis result."""
        lessons = []
        
        if result.get("success") and "result" in result:
            analysis_result = result["result"]
            
            if isinstance(analysis_result, dict):
                if "insights" in analysis_result:
                    # Convert insights to lessons format
                    for insight in analysis_result["insights"]:
                        lessons.append({
                            "lesson": insight.get("title", "Untitled"),
                            "description": insight.get("description", ""),
                            "context": insight.get("applicability", "General"),
                            "significance": insight.get("significance", 5)
                        })
                else:
                    # Create a general lesson
                    lessons.append({
                        "lesson": "Analysis completed",
                        "description": str(analysis_result.get("analysis", "Content analyzed for lessons")),
                        "context": "General",
                        "significance": 5
                    })
        
        return lessons
    
    def _format_result(self, result: Dict[str, Any]) -> str:
        """Format result for MCP response."""
        try:
            return json.dumps(result, indent=2)
        except:
            return str(result)
    
    async def run_stdio(self):
        """Run the MCP server with stdio transport."""
        try:
            logger.info("Starting Semantic Analysis MCP Server...")
            
            # Initialize system
            self.system = await initialize_system()
            
            logger.info("MCP Server initialized successfully")
            
            # Run server
            async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
                await self.server.run(
                    read_stream,
                    write_stream,
                    self.server.create_initialization_options()
                )
                
        except Exception as e:
            logger.error("MCP Server failed", error=str(e))
            raise
        finally:
            # Cleanup
            if self.system:
                await self.system.shutdown()


async def main():
    """Main entry point for the MCP server."""
    server = SemanticAnalysisMCPServer()
    await server.run_stdio()


if __name__ == "__main__":
    asyncio.run(main())