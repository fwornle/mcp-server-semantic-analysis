"""
Base agent class for the semantic analysis system.
Provides common functionality and interface for all agents.
"""

import asyncio
from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, List
import structlog
from config.logging_config import get_agent_logger


class BaseAgent(ABC):
    """
    Base class for all agents in the semantic analysis system.
    Provides common functionality and enforces interface contracts.
    """
    
    def __init__(self, name: str, config: Dict[str, Any], system: Any):
        self.name = name
        self.config = config
        self.system = system
        self.running = False
        self.capabilities = []
        
        # Setup logging
        self.logger = get_agent_logger(name)
        
        # Event handling
        self._event_handlers = {}
        
    async def initialize(self):
        """Initialize the agent."""
        self.logger.info(f"Initializing {self.name} agent...")
        
        try:
            await self.on_initialize()
            self.running = True
            self.logger.info(f"{self.name} agent initialized successfully")
            
        except Exception as e:
            self.logger.error(f"Failed to initialize {self.name} agent", error=str(e))
            raise
    
    @abstractmethod
    async def on_initialize(self):
        """Agent-specific initialization logic."""
        pass
    
    async def shutdown(self):
        """Shutdown the agent gracefully."""
        self.logger.info(f"Shutting down {self.name} agent...")
        
        try:
            await self.on_shutdown()
            self.running = False
            self.logger.info(f"{self.name} agent shut down successfully")
            
        except Exception as e:
            self.logger.error(f"Error shutting down {self.name} agent", error=str(e))
    
    async def on_shutdown(self):
        """Agent-specific shutdown logic."""
        pass
    
    async def health_check(self) -> Dict[str, Any]:
        """Check agent health and return status."""
        return {
            "healthy": self.running,
            "name": self.name,
            "capabilities": self.capabilities
        }
    
    def register_capability(self, capability: str):
        """Register a capability this agent provides."""
        if capability not in self.capabilities:
            self.capabilities.append(capability)
            self.logger.debug(f"Registered capability: {capability}")
    
    def has_capability(self, capability: str) -> bool:
        """Check if agent has a specific capability."""
        return capability in self.capabilities
    
    async def handle_event(self, event_type: str, data: Dict[str, Any]) -> Optional[Any]:
        """Handle an event sent to this agent."""
        handler = self._event_handlers.get(event_type)
        if handler:
            try:
                return await handler(data)
            except Exception as e:
                self.logger.error(
                    "Event handler failed",
                    event_type=event_type,
                    error=str(e)
                )
                raise
        else:
            self.logger.debug(f"No handler for event type: {event_type}")
            return None
    
    def register_event_handler(self, event_type: str, handler):
        """Register an event handler for a specific event type."""
        self._event_handlers[event_type] = handler
        self.logger.debug(f"Registered handler for event: {event_type}")
    
    async def send_event(self, target_agent: str, event_type: str, data: Dict[str, Any]) -> Optional[Any]:
        """Send an event to another agent."""
        if target_agent in self.system.agents:
            agent = self.system.agents[target_agent]
            self.logger.debug(
                "Sending event",
                target=target_agent,
                event_type=event_type
            )
            return await agent.handle_event(event_type, data)
        else:
            self.logger.warning(f"Target agent not found: {target_agent}")
            return None
    
    async def broadcast_event(self, event_type: str, data: Dict[str, Any], exclude_self: bool = True) -> Dict[str, Any]:
        """Broadcast an event to all agents."""
        results = {}
        
        for agent_name, agent in self.system.agents.items():
            if exclude_self and agent_name == self.name:
                continue
                
            try:
                result = await agent.handle_event(event_type, data)
                results[agent_name] = result
            except Exception as e:
                self.logger.error(
                    "Broadcast event failed",
                    target=agent_name,
                    event_type=event_type,
                    error=str(e)
                )
                results[agent_name] = {"error": str(e)}
        
        return results
    
    def get_agent_info(self) -> Dict[str, Any]:
        """Get information about this agent."""
        return {
            "name": self.name,
            "running": self.running,
            "capabilities": self.capabilities,
            "config": self.config
        }
    
    def __str__(self):
        return f"{self.__class__.__name__}({self.name})"
    
    def __repr__(self):
        return f"{self.__class__.__name__}(name='{self.name}', running={self.running})"