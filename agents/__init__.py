"""
Agents package for the semantic analysis system.
Contains all 7 agents implementing the multi-agent architecture.
"""

from .base import BaseAgent
from .coordinator import CoordinatorAgent
from .semantic_analysis import SemanticAnalysisAgent
from .knowledge_graph import KnowledgeGraphAgent
from .web_search import WebSearchAgent
from .synchronization import SynchronizationAgent
from .deduplication import DeduplicationAgent
from .documentation import DocumentationAgent

__all__ = [
    "BaseAgent",
    "CoordinatorAgent", 
    "SemanticAnalysisAgent",
    "KnowledgeGraphAgent",
    "WebSearchAgent",
    "SynchronizationAgent",
    "DeduplicationAgent",
    "DocumentationAgent"
]