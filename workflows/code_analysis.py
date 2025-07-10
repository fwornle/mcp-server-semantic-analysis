"""
Code Analysis Workflow
Simple workflow for analyzing code through semantic analysis agent
"""

from typing import Dict, Any, List
from dataclasses import dataclass


@dataclass
class WorkflowDefinition:
    """Workflow definition structure."""
    name: str
    description: str
    steps: List[Dict[str, Any]]
    config: Dict[str, Any]


def create_code_analysis_workflow() -> WorkflowDefinition:
    """Create code analysis workflow definition."""
    
    return WorkflowDefinition(
        name="code-analysis",
        description="Analyze code for patterns, issues, and architectural insights",
        steps=[
            {
                "agent": "semantic_analysis",
                "action": "analyze_code",
                "timeout": 60,
                "description": "Analyze code structure and patterns"
            },
            {
                "agent": "knowledge_graph",
                "action": "extract_patterns",
                "timeout": 30,
                "description": "Extract patterns from analysis"
            },
            {
                "agent": "synchronization",
                "action": "sync_results",
                "timeout": 30,
                "description": "Sync results to persistent storage"
            }
        ],
        config={
            "qa_validation": True,
            "min_significance": 5,
            "timeout": 120
        }
    )


def create_insight_generation_workflow() -> WorkflowDefinition:
    """Create insight generation workflow definition."""
    
    return WorkflowDefinition(
        name="insight-generation",
        description="Generate actionable insights from analysis context",
        steps=[
            {
                "agent": "semantic_analysis",
                "action": "analyze_insights",
                "timeout": 60,
                "description": "Generate insights from context"
            },
            {
                "agent": "knowledge_graph",
                "action": "create_insight_entities",
                "timeout": 30,
                "description": "Create knowledge graph entities"
            },
            {
                "agent": "synchronization",
                "action": "sync_insights",
                "timeout": 30,
                "description": "Sync insights to persistent storage"
            }
        ],
        config={
            "qa_validation": True,
            "min_significance": 5,
            "timeout": 120
        }
    )