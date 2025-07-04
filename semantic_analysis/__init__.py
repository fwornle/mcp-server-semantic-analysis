"""
Semantic Analysis MCP Server

A powerful multi-agent semantic analysis system built with the Graphite framework.
Provides comprehensive code and conversation analysis through MCP, HTTP, and CLI interfaces.
"""

__version__ = "1.0.0"
__author__ = "Agentic Coding Team"
__email__ = "team@agentic.dev"

from .core import SemanticAnalysisSystem
from .config import Config

__all__ = ["SemanticAnalysisSystem", "Config"]