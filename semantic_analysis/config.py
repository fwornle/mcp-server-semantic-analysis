"""
Configuration management for the semantic analysis system.
Provides a unified interface to all configuration components.
"""

from pathlib import Path
from typing import Optional
from config.api_keys import APIKeyManager
from config.agent_config import AgentConfig
from config.logging_config import setup_logging


class Config:
    """Unified configuration manager for the semantic analysis system."""
    
    def __init__(self, config_path: Optional[Path] = None):
        self.config_path = config_path
        self.agent_config = AgentConfig(config_path)
        self.api_key_manager = APIKeyManager()
        
    def initialize_logging(self):
        """Initialize logging with system configuration."""
        system_config = self.agent_config.get_system_config()
        log_config = system_config.get("logging", {})
        
        log_dir = Path(__file__).parent.parent / "logs"
        setup_logging(
            level=log_config.get("level", "INFO"),
            log_file=log_dir / "semantic_analysis.log",
            structured=log_config.get("structured", True),
            include_agent_id=log_config.get("include_agent_id", True),
            include_workflow_id=log_config.get("include_workflow_id", True)
        )
    
    def get_agent_definitions(self):
        """Get agent definitions."""
        return self.agent_config.get_agent_definitions()
    
    def get_workflow_definitions(self):
        """Get workflow definitions."""
        return self.agent_config.get_workflow_definitions()
    
    def get_system_config(self):
        """Get system configuration."""
        return self.agent_config.get_system_config()
    
    def get_api_status(self):
        """Get API key status."""
        return self.api_key_manager.get_status_report()
    
    def validate(self):
        """Validate entire configuration."""
        return self.agent_config.validate_config()