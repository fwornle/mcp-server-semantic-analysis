"""
Core Semantic Analysis System
Orchestrates the 7-agent architecture using the Graphite framework
"""

import asyncio
from pathlib import Path
from typing import Dict, Any, Optional, List
import structlog

from config.api_keys import APIKeyManager, get_api_key_manager
from config.agent_config import AgentConfig
from config.logging_config import setup_logging, get_logger


class SemanticAnalysisSystem:
    """
    Main orchestrator for the semantic analysis system.
    Manages the 7-agent architecture and provides unified access.
    """
    
    def __init__(self, config_path: Optional[Path] = None):
        self.config_path = config_path
        self.config = AgentConfig(config_path)
        self.api_key_manager = get_api_key_manager()
        self.agents: Dict[str, Any] = {}
        self.workflows: Dict[str, Any] = {}
        self.running = False
        
        # Setup logging first
        self._setup_logging()
        self.logger = get_logger("core")
        
        # Validate configuration
        self._validate_system()
    
    def _setup_logging(self):
        """Initialize logging for the system."""
        system_config = self.config.get_system_config()
        log_config = system_config.get("logging", {})
        
        log_dir = Path(__file__).parent.parent / "logs"
        setup_logging(
            level=log_config.get("level", "INFO"),
            log_file=log_dir / "semantic_analysis.log",
            structured=log_config.get("structured", True),
            include_agent_id=log_config.get("include_agent_id", True),
            include_workflow_id=log_config.get("include_workflow_id", True)
        )
    
    def _validate_system(self):
        """Validate system configuration and API keys."""
        self.logger.info("Validating system configuration...")
        
        # Validate configuration
        config_errors = self.config.validate_config()
        if config_errors:
            self.logger.error("Configuration validation failed", errors=config_errors)
            raise ValueError(f"Configuration errors: {config_errors}")
        
        # Check API key status
        api_status = self.api_key_manager.get_status_report()
        self.logger.info(
            "API key status",
            primary=api_status["primary_provider"],
            has_ai=api_status["has_ai_providers"],
            chain=api_status["fallback_chain"]
        )
        
        if not api_status["has_ai_providers"]:
            self.logger.warning(
                "No AI providers available - will use UKB-CLI fallback mode"
            )
    
    async def initialize(self):
        """Initialize all agents and workflows."""
        self.logger.info("Initializing semantic analysis system...")
        
        try:
            # Initialize agents in dependency order
            await self._initialize_agents()
            
            # Initialize workflows
            await self._initialize_workflows()
            
            # Start background tasks
            await self._start_background_tasks()
            
            self.running = True
            self.logger.info(
                "System initialized successfully",
                agents=len(self.agents),
                workflows=len(self.workflows)
            )
            
        except Exception as e:
            self.logger.error("Failed to initialize system", error=str(e))
            await self.shutdown()
            raise
    
    async def _initialize_agents(self):
        """Initialize all 7 agents in dependency order."""
        agent_definitions = self.config.get_agent_definitions()
        
        # Sort agents by priority and dependencies
        sorted_agents = self._sort_agents_by_dependencies(agent_definitions)
        
        for agent_name in sorted_agents:
            agent_def = agent_definitions[agent_name]
            
            if not agent_def.enabled:
                self.logger.info(f"Skipping disabled agent: {agent_name}")
                continue
            
            self.logger.info(f"Initializing agent: {agent_name}")
            
            try:
                # Import agent class dynamically
                module = __import__(agent_def.module_path, fromlist=[agent_def.class_name])
                agent_class = getattr(module, agent_def.class_name)
                
                # Create agent instance
                agent = agent_class(
                    name=agent_name,
                    config=agent_def.config,
                    system=self
                )
                
                # Initialize agent
                await agent.initialize()
                
                self.agents[agent_name] = agent
                self.logger.info(f"Agent {agent_name} initialized successfully")
                
            except Exception as e:
                self.logger.error(f"Failed to initialize agent {agent_name}", error=str(e))
                raise
    
    async def _initialize_workflows(self):
        """Initialize workflow definitions."""
        workflow_definitions = self.config.get_workflow_definitions()
        
        for workflow_name, workflow_def in workflow_definitions.items():
            self.logger.info(f"Registering workflow: {workflow_name}")
            self.workflows[workflow_name] = workflow_def
    
    async def _start_background_tasks(self):
        """Start background tasks for system monitoring."""
        # Start health monitoring
        asyncio.create_task(self._health_monitor())
        
        # Start synchronization if enabled
        if "synchronization" in self.agents:
            asyncio.create_task(self._sync_monitor())
    
    def _sort_agents_by_dependencies(self, agent_definitions: Dict) -> List[str]:
        """Sort agents by their dependencies (topological sort)."""
        # Simple dependency resolution - coordinator first, then others
        sorted_agents = []
        remaining = set(agent_definitions.keys())
        
        # Add coordinator first (no dependencies)
        if "coordinator" in remaining:
            sorted_agents.append("coordinator")
            remaining.remove("coordinator")
        
        # Add remaining agents (they all depend on coordinator)
        sorted_agents.extend(sorted(remaining))
        
        return sorted_agents
    
    async def execute_workflow(self, workflow_name: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a workflow with the given parameters."""
        if not self.running:
            raise RuntimeError("System not initialized")
        
        if workflow_name not in self.workflows:
            raise ValueError(f"Unknown workflow: {workflow_name}")
        
        workflow_def = self.workflows[workflow_name]
        
        self.logger.info(
            "Starting workflow",
            workflow=workflow_name,
            parameters=parameters
        )
        
        # Delegate to coordinator agent
        coordinator = self.agents.get("coordinator")
        if not coordinator:
            raise RuntimeError("Coordinator agent not available")
        
        try:
            result = await coordinator.execute_workflow(workflow_name, workflow_def, parameters)
            
            self.logger.info(
                "Workflow completed",
                workflow=workflow_name,
                success=True
            )
            
            return result
            
        except Exception as e:
            self.logger.error(
                "Workflow failed",
                workflow=workflow_name,
                error=str(e)
            )
            raise
    
    async def get_workflow_status(self, workflow_id: str) -> Dict[str, Any]:
        """Get status of a running workflow."""
        coordinator = self.agents.get("coordinator")
        if not coordinator:
            raise RuntimeError("Coordinator agent not available")
        
        return await coordinator.get_workflow_status(workflow_id)
    
    async def analyze_repository(self, repository_path: str, **kwargs) -> Dict[str, Any]:
        """Convenience method for repository analysis."""
        return await self.execute_workflow("repository_analysis", {
            "repository": repository_path,
            **kwargs
        })
    
    async def analyze_conversation(self, conversation_path: str, **kwargs) -> Dict[str, Any]:
        """Convenience method for conversation analysis.""" 
        return await self.execute_workflow("conversation_analysis", {
            "conversation_path": conversation_path,
            **kwargs
        })
    
    async def complete_semantic_analysis(self, repository_path: str, **kwargs) -> Dict[str, Any]:
        """Convenience method for complete semantic analysis."""
        return await self.execute_workflow("complete_semantic_analysis", {
            "repository": repository_path,
            **kwargs
        })
    
    async def incremental_analysis(self, repository_path: str, **kwargs) -> Dict[str, Any]:
        """Convenience method for incremental analysis."""
        return await self.execute_workflow("incremental_analysis", {
            "repository": repository_path,
            **kwargs
        })
    
    def get_system_status(self) -> Dict[str, Any]:
        """Get comprehensive system status."""
        agent_status = {}
        for agent_name, agent in self.agents.items():
            try:
                agent_status[agent_name] = {
                    "running": hasattr(agent, "running") and agent.running,
                    "health": "healthy",  # Could implement health checks
                    "capabilities": getattr(agent, "capabilities", [])
                }
            except Exception as e:
                agent_status[agent_name] = {
                    "running": False,
                    "health": "error",
                    "error": str(e)
                }
        
        return {
            "system_running": self.running,
            "agents": agent_status,
            "workflows": list(self.workflows.keys()),
            "api_keys": self.api_key_manager.get_status_report()
        }
    
    async def _health_monitor(self):
        """Background task to monitor agent health."""
        while self.running:
            try:
                # Check agent health
                for agent_name, agent in self.agents.items():
                    if hasattr(agent, "health_check"):
                        health = await agent.health_check()
                        if not health.get("healthy", True):
                            self.logger.warning(
                                "Agent health check failed",
                                agent=agent_name,
                                health=health
                            )
                
                # Wait before next check
                await asyncio.sleep(30)
                
            except Exception as e:
                self.logger.error("Health monitor error", error=str(e))
                await asyncio.sleep(10)
    
    async def _sync_monitor(self):
        """Background task to monitor synchronization."""
        sync_agent = self.agents.get("synchronization")
        if not sync_agent:
            return
        
        while self.running:
            try:
                await sync_agent.periodic_sync()
                await asyncio.sleep(60)  # Sync every minute
                
            except Exception as e:
                self.logger.error("Sync monitor error", error=str(e))
                await asyncio.sleep(30)
    
    async def shutdown(self):
        """Gracefully shutdown the system."""
        self.logger.info("Shutting down semantic analysis system...")
        self.running = False
        
        # Shutdown agents in reverse order
        agent_names = list(self.agents.keys())
        for agent_name in reversed(agent_names):
            agent = self.agents[agent_name]
            try:
                if hasattr(agent, "shutdown"):
                    await agent.shutdown()
                self.logger.info(f"Agent {agent_name} shut down")
            except Exception as e:
                self.logger.error(f"Error shutting down agent {agent_name}", error=str(e))
        
        self.agents.clear()
        self.workflows.clear()
        
        self.logger.info("System shutdown complete")


# Global system instance
_system_instance: Optional[SemanticAnalysisSystem] = None


def get_system(config_path: Optional[Path] = None) -> SemanticAnalysisSystem:
    """Get or create the global system instance."""
    global _system_instance
    
    if _system_instance is None:
        _system_instance = SemanticAnalysisSystem(config_path)
    
    return _system_instance


async def initialize_system(config_path: Optional[Path] = None) -> SemanticAnalysisSystem:
    """Initialize and return the global system instance."""
    system = get_system(config_path)
    
    if not system.running:
        await system.initialize()
    
    return system


if __name__ == "__main__":
    # CLI test for the system
    async def main():
        system = await initialize_system()
        status = system.get_system_status()
        
        print("🤖 Semantic Analysis System Status")
        print("=" * 40)
        print(f"System Running: {status['system_running']}")
        print(f"Agents: {len(status['agents'])}")
        print(f"Workflows: {len(status['workflows'])}")
        print(f"AI Providers: {status['api_keys']['has_ai_providers']}")
        
        print("\n📋 Agent Status:")
        for agent_name, agent_status in status['agents'].items():
            health_icon = "✅" if agent_status['health'] == 'healthy' else "❌"
            print(f"  {health_icon} {agent_name}: {agent_status['health']}")
        
        print(f"\n🔄 Available Workflows:")
        for workflow in status['workflows']:
            print(f"  • {workflow}")
        
        await system.shutdown()
    
    asyncio.run(main())