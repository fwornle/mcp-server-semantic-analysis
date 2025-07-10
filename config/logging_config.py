"""
Unified logging configuration for the semantic analysis system.
Provides structured logging across all agents with proper formatting.
"""

import logging
import sys
from pathlib import Path
from typing import Optional, Dict, Any
import structlog
from rich.logging import RichHandler
from rich.console import Console


def setup_logging(
    level: str = "INFO",
    log_file: Optional[Path] = None,
    structured: bool = True,
    include_agent_id: bool = True,
    include_workflow_id: bool = True,
    console_output: bool = True
) -> None:
    """
    Setup unified logging for the semantic analysis system.
    
    Args:
        level: Logging level (DEBUG, INFO, WARNING, ERROR)
        log_file: Optional file path for log output
        structured: Use structured logging format
        include_agent_id: Include agent ID in log records
        include_workflow_id: Include workflow ID in log records
        console_output: Enable console output with Rich formatting
    """
    
    # Convert string level to logging constant
    log_level = getattr(logging, level.upper(), logging.INFO)
    
    # Configure standard library logging
    logging.basicConfig(
        level=log_level,
        format="%(message)s",
        handlers=[]
    )
    
    # Setup handlers
    handlers = []
    
    if console_output:
        # Rich console handler for beautiful terminal output
        console = Console(stderr=True)
        rich_handler = RichHandler(
            console=console,
            show_time=True,
            show_level=True,
            show_path=False,
            markup=True,
            rich_tracebacks=True
        )
        rich_handler.setLevel(log_level)
        handlers.append(rich_handler)
    
    if log_file:
        # File handler for persistent logging
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(log_level)
        
        # Use JSON format for file logs if structured
        if structured:
            file_formatter = structlog.stdlib.ProcessorFormatter(
                processor=structlog.dev.ConsoleRenderer(colors=False),
                foreign_pre_chain=[
                    structlog.stdlib.add_logger_name,
                    structlog.stdlib.add_log_level,
                    structlog.stdlib.PositionalArgumentsFormatter(),
                ],
            )
        else:
            file_formatter = logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
            )
        
        file_handler.setFormatter(file_formatter)
        handlers.append(file_handler)
    
    # Configure structlog
    processors = [
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]
    
    if include_agent_id:
        processors.append(add_agent_context)
    
    if include_workflow_id:
        processors.append(add_workflow_context)
    
    if structured:
        processors.extend([
            structlog.processors.UnicodeDecoder(),
            structlog.processors.JSONRenderer()
        ])
    else:
        processors.extend([
            structlog.dev.ConsoleRenderer(colors=console_output)
        ])
    
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )
    
    # Apply handlers to root logger
    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    for handler in handlers:
        root_logger.addHandler(handler)
    
    # Set up semantic analysis specific logger
    semantic_logger = structlog.get_logger("semantic_analysis")
    semantic_logger.info(
        "Logging configured",
        level=level,
        structured=structured,
        handlers=len(handlers),
        log_file=str(log_file) if log_file else None
    )


def add_agent_context(logger, method_name, event_dict):
    """Add agent context to log records."""
    # This will be populated by agents when they create loggers
    agent_id = getattr(logger, '_agent_id', None)
    if agent_id:
        event_dict['agent_id'] = agent_id
    return event_dict


def add_workflow_context(logger, method_name, event_dict):
    """Add workflow context to log records."""
    # This will be populated by workflow engine
    workflow_id = getattr(logger, '_workflow_id', None)
    if workflow_id:
        event_dict['workflow_id'] = workflow_id
    return event_dict


def get_agent_logger(agent_id: str, workflow_id: Optional[str] = None) -> structlog.BoundLogger:
    """
    Get a logger bound to specific agent and optionally workflow.
    
    Args:
        agent_id: Unique identifier for the agent
        workflow_id: Optional workflow identifier
        
    Returns:
        Configured logger with agent context
    """
    logger = structlog.get_logger(f"semantic_analysis.{agent_id}")
    
    # Bind agent and workflow context
    bound_logger = logger.bind(agent_id=agent_id)
    if workflow_id:
        bound_logger = bound_logger.bind(workflow_id=workflow_id)
    
    return bound_logger


def get_workflow_logger(workflow_id: str, agent_id: Optional[str] = None) -> structlog.BoundLogger:
    """
    Get a logger bound to specific workflow and optionally agent.
    
    Args:
        workflow_id: Unique identifier for the workflow
        agent_id: Optional agent identifier
        
    Returns:
        Configured logger with workflow context
    """
    logger = structlog.get_logger(f"semantic_analysis.workflow.{workflow_id}")
    
    # Bind workflow and agent context
    bound_logger = logger.bind(workflow_id=workflow_id)
    if agent_id:
        bound_logger = bound_logger.bind(agent_id=agent_id)
    
    return bound_logger


class LoggerMixin:
    """Mixin class to add logging capabilities to agents and workflows."""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._setup_logger()
    
    def _setup_logger(self):
        """Setup logger for this instance."""
        component_name = getattr(self, 'name', self.__class__.__name__)
        workflow_id = getattr(self, 'workflow_id', None)
        
        if hasattr(self, 'agent_id'):
            self.logger = get_agent_logger(self.agent_id, workflow_id)
        elif hasattr(self, 'workflow_id'):
            self.logger = get_workflow_logger(self.workflow_id)
        else:
            self.logger = structlog.get_logger(f"semantic_analysis.{component_name}")


# Default logging configuration for the system
def setup_default_logging():
    """Setup default logging configuration for development."""
    log_dir = Path(__file__).parent.parent / "logs"
    log_file = log_dir / "semantic_analysis.log"
    
    setup_logging(
        level="INFO",
        log_file=log_file,
        structured=True,
        console_output=True
    )


# Convenience function for quick logger setup
def get_logger(name: str = "semantic_analysis") -> structlog.BoundLogger:
    """Get a logger with the given name."""
    return structlog.get_logger(name)


if __name__ == "__main__":
    # Test logging setup
    setup_default_logging()
    
    logger = get_logger("test")
    agent_logger = get_agent_logger("test_agent", "test_workflow")
    workflow_logger = get_workflow_logger("test_workflow", "test_agent")
    
    logger.info("Testing main logger")
    agent_logger.info("Testing agent logger", action="test_action")
    workflow_logger.info("Testing workflow logger", step="test_step")
    
    logger.warning("Warning message")
    logger.error("Error message", error_code="TEST001")
    
    print("Logging test completed successfully!")