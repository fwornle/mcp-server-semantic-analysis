"""
HTTP API Server for Semantic Analysis System
Provides REST API for CoPilot VSCode extension integration
"""

import asyncio
import json
import logging
from typing import Dict, Any, List, Optional
from fastapi import FastAPI, HTTPException, Request, BackgroundTasks
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from pathlib import Path
import os

# Import our system
from semantic_analysis.core import get_system, initialize_system
from config.logging_config import get_logger

logger = get_logger("http_server")


# Pydantic models for request/response
class AnalysisRequest(BaseModel):
    repository: Optional[str] = None
    conversation_context: Optional[str] = None
    depth: int = 10
    significance_threshold: int = 7
    include_files: bool = False
    extract_insights: bool = True


class InsightRequest(BaseModel):
    insights: List[Dict[str, Any]]
    source: str = "manual"
    priority: str = "normal"


class LessonsRequest(BaseModel):
    content: str
    source: Optional[str] = None
    extract_patterns: bool = True


class SearchRequest(BaseModel):
    query: str
    entity_type: Optional[str] = None
    min_significance: int = 5
    limit: int = 10


class WorkflowStatusRequest(BaseModel):
    workflow_id: Optional[str] = None


class SemanticAnalysisHTTPServer:
    """HTTP API server for the semantic analysis system."""
    
    def __init__(self, host: str = "0.0.0.0", port: int = 8081):
        self.host = host
        self.port = port
        self.app = FastAPI(
            title="Semantic Analysis API",
            description="Multi-agent semantic analysis system HTTP API",
            version="1.0.0",
            docs_url="/docs",
            redoc_url="/redoc"
        )
        self.system = None
        
        # Configure CORS for VSCode extension
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],  # In production, restrict to specific origins
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
        
        self._setup_routes()
        self._setup_error_handlers()
    
    def _setup_routes(self):
        """Setup API routes."""
        
        @self.app.on_event("startup")
        async def startup_event():
            """Initialize system on startup."""
            try:
                self.system = await initialize_system()
                logger.info("HTTP API server initialized successfully")
            except Exception as e:
                logger.error(f"Failed to initialize system: {e}")
                raise
        
        @self.app.on_event("shutdown")
        async def shutdown_event():
            """Cleanup on shutdown."""
            if self.system:
                await self.system.shutdown()
                logger.info("HTTP API server shutdown complete")
        
        @self.app.get("/health")
        async def health_check():
            """Health check endpoint."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            try:
                status = self.system.get_system_status()
                return {
                    "status": "healthy",
                    "system_running": status.get("system_running", False),
                    "agents": len(status.get("agents", {})),
                    "api_keys": status.get("api_keys", {}).get("has_ai_providers", False)
                }
            except Exception as e:
                logger.error(f"Health check failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.get("/status")
        async def get_system_status():
            """Get detailed system status."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            try:
                status = self.system.get_system_status()
                return {"success": True, "status": status}
            except Exception as e:
                logger.error(f"Status check failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.post("/analyze/repository")
        async def analyze_repository(request: AnalysisRequest):
            """Analyze a repository."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            if not request.repository:
                raise HTTPException(status_code=400, detail="Repository path required")
            
            try:
                result = await self.system.analyze_repository(
                    request.repository,
                    depth=request.depth,
                    significance_threshold=request.significance_threshold,
                    include_files=request.include_files
                )
                
                return {
                    "success": True,
                    "analysis": result,
                    "repository": request.repository,
                    "parameters": {
                        "depth": request.depth,
                        "significance_threshold": request.significance_threshold,
                        "include_files": request.include_files
                    }
                }
            except Exception as e:
                logger.error(f"Repository analysis failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.post("/analyze/conversation")
        async def analyze_conversation(request: AnalysisRequest):
            """Analyze a conversation."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            if not request.conversation_context:
                raise HTTPException(status_code=400, detail="Conversation context required")
            
            try:
                result = await self.system.analyze_conversation(
                    request.conversation_context,
                    extract_insights=request.extract_insights
                )
                
                return {
                    "success": True,
                    "analysis": result,
                    "conversation": request.conversation_context,
                    "parameters": {
                        "extract_insights": request.extract_insights
                    }
                }
            except Exception as e:
                logger.error(f"Conversation analysis failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.post("/analyze/incremental")
        async def incremental_analysis(request: AnalysisRequest):
            """Perform incremental analysis."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            repository = request.repository or os.getcwd()
            
            try:
                result = await self.system.incremental_analysis(
                    repository,
                    significance_threshold=request.significance_threshold
                )
                
                return {
                    "success": True,
                    "analysis": result,
                    "repository": repository,
                    "parameters": {
                        "significance_threshold": request.significance_threshold
                    }
                }
            except Exception as e:
                logger.error(f"Incremental analysis failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.post("/analyze/complete")
        async def complete_analysis(request: AnalysisRequest):
            """Perform complete semantic analysis."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            repository = request.repository or os.getcwd()
            
            try:
                result = await self.system.complete_semantic_analysis(
                    repository,
                    depth=request.depth,
                    significance_threshold=request.significance_threshold
                )
                
                return {
                    "success": True,
                    "analysis": result,
                    "repository": repository,
                    "parameters": {
                        "depth": request.depth,
                        "significance_threshold": request.significance_threshold
                    }
                }
            except Exception as e:
                logger.error(f"Complete analysis failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.post("/insights/determine")
        async def determine_insights(request: AnalysisRequest):
            """Determine insights from repository or conversation."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            if not request.repository and not request.conversation_context:
                raise HTTPException(status_code=400, detail="Either repository or conversation_context required")
            
            try:
                if request.repository:
                    result = await self.system.analyze_repository(
                        request.repository,
                        depth=request.depth,
                        significance_threshold=request.significance_threshold
                    )
                else:
                    result = await self.system.analyze_conversation(
                        request.conversation_context,
                        extract_insights=True
                    )
                
                # Extract insights from result
                insights = self._extract_insights_from_result(result)
                
                return {
                    "success": True,
                    "insights": insights,
                    "source": request.repository or request.conversation_context,
                    "parameters": {
                        "depth": request.depth,
                        "significance_threshold": request.significance_threshold
                    }
                }
            except Exception as e:
                logger.error(f"Insight determination failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.post("/knowledge/update")
        async def update_knowledge_base(request: InsightRequest):
            """Update knowledge base with insights."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            try:
                # Convert insights to entities
                entities_data = []
                for insight in request.insights:
                    entities_data.append({
                        "name": insight["name"],
                        "entity_type": insight.get("type", "Insight"),
                        "significance": insight.get("significance", 5),
                        "observations": insight.get("observations", []),
                        "metadata": {
                            "source": request.source,
                            "priority": request.priority
                        }
                    })
                
                # Create entities through knowledge graph agent
                kg_agent = self.system.agents.get("knowledge_graph")
                if not kg_agent:
                    raise HTTPException(status_code=503, detail="Knowledge graph agent not available")
                
                result = await kg_agent.handle_event("create_entities", {
                    "entities": entities_data
                })
                
                return {
                    "success": True,
                    "summary": f"Added {result.get('created', 0)} entities to knowledge base",
                    "details": result,
                    "source": request.source
                }
            except Exception as e:
                logger.error(f"Knowledge base update failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.post("/lessons/extract")
        async def extract_lessons(request: LessonsRequest):
            """Extract lessons learned from content."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            try:
                semantic_agent = self.system.agents.get("semantic_analysis")
                if not semantic_agent:
                    raise HTTPException(status_code=503, detail="Semantic analysis agent not available")
                
                # Perform lesson extraction analysis
                result = await semantic_agent.analyze(
                    "insight_generation",
                    request.content,
                    {
                        "extract_patterns": request.extract_patterns,
                        "focus": "lessons_learned"
                    }
                )
                
                # Extract structured lessons
                lessons = self._extract_lessons_from_result(result)
                
                return {
                    "success": True,
                    "lessons": lessons,
                    "source": request.source,
                    "patterns_extracted": request.extract_patterns
                }
            except Exception as e:
                logger.error(f"Lesson extraction failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.post("/workflow/status")
        async def get_workflow_status(request: WorkflowStatusRequest):
            """Get workflow status."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            try:
                coordinator = self.system.agents.get("coordinator")
                if not coordinator:
                    raise HTTPException(status_code=503, detail="Coordinator agent not available")
                
                if request.workflow_id:
                    # Get specific workflow status
                    status = await coordinator.get_workflow_status(request.workflow_id)
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
                logger.error(f"Workflow status check failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.post("/knowledge/search")
        async def search_knowledge(request: SearchRequest):
            """Search the knowledge base."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            try:
                kg_agent = self.system.agents.get("knowledge_graph")
                if not kg_agent:
                    raise HTTPException(status_code=503, detail="Knowledge graph agent not available")
                
                # Perform search
                result = await kg_agent.search_entities(request.query, "local")
                
                if not result["success"]:
                    raise HTTPException(status_code=500, detail=result.get("error", "Search failed"))
                
                # Filter results
                entities = result["entities"]
                
                # Filter by entity type if specified
                if request.entity_type:
                    entities = [e for e in entities if e["type"] == request.entity_type]
                
                # Filter by significance
                entities = [e for e in entities if e["significance"] >= request.min_significance]
                
                # Limit results
                entities = entities[:request.limit]
                
                return {
                    "success": True,
                    "query": request.query,
                    "entities": entities,
                    "count": len(entities),
                    "filters": {
                        "entity_type": request.entity_type,
                        "min_significance": request.min_significance,
                        "limit": request.limit
                    }
                }
            except Exception as e:
                logger.error(f"Knowledge search failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.get("/agents")
        async def get_agents():
            """Get information about available agents."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            try:
                agent_info = {}
                for agent_name, agent in self.system.agents.items():
                    agent_info[agent_name] = {
                        "running": agent.running,
                        "capabilities": agent.capabilities,
                        "health": await agent.health_check()
                    }
                
                return {
                    "success": True,
                    "agents": agent_info,
                    "count": len(agent_info)
                }
            except Exception as e:
                logger.error(f"Agent info retrieval failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        
        @self.app.get("/workflows")
        async def get_workflows():
            """Get available workflow definitions."""
            if not self.system:
                raise HTTPException(status_code=503, detail="System not initialized")
            
            try:
                workflows = list(self.system.workflows.keys())
                return {
                    "success": True,
                    "workflows": workflows,
                    "count": len(workflows)
                }
            except Exception as e:
                logger.error(f"Workflow retrieval failed: {e}")
                raise HTTPException(status_code=500, detail=str(e))
    
    def _setup_error_handlers(self):
        """Setup error handlers."""
        
        @self.app.exception_handler(HTTPException)
        async def http_exception_handler(request: Request, exc: HTTPException):
            """Handle HTTP exceptions."""
            logger.error(f"HTTP {exc.status_code}: {exc.detail}")
            return JSONResponse(
                status_code=exc.status_code,
                content={"error": exc.detail, "success": False}
            )
        
        @self.app.exception_handler(Exception)
        async def general_exception_handler(request: Request, exc: Exception):
            """Handle general exceptions."""
            logger.error(f"Unhandled exception: {exc}")
            return JSONResponse(
                status_code=500,
                content={"error": "Internal server error", "success": False}
            )
    
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
    
    async def run_server(self):
        """Run the HTTP server."""
        logger.info(f"Starting HTTP API server on {self.host}:{self.port}")
        
        config = uvicorn.Config(
            self.app,
            host=self.host,
            port=self.port,
            log_level="info"
        )
        
        server = uvicorn.Server(config)
        await server.serve()


async def main():
    """Main entry point for the HTTP server."""
    import argparse
    
    parser = argparse.ArgumentParser(description="Semantic Analysis HTTP API Server")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8081, help="Port to bind to")
    args = parser.parse_args()
    
    server = SemanticAnalysisHTTPServer(host=args.host, port=args.port)
    await server.run_server()


if __name__ == "__main__":
    asyncio.run(main())