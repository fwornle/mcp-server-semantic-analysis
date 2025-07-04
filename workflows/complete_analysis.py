"""
Complete Analysis Workflow
Comprehensive semantic analysis workflow using all agents
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


def create_complete_analysis_workflow() -> WorkflowDefinition:
    """Create complete semantic analysis workflow definition."""
    
    return WorkflowDefinition(
        name="complete-analysis",
        description="Comprehensive semantic analysis with all agents",
        steps=[
            {
                "agent": "semantic_analysis",
                "action": "analyze_repository_structure",
                "timeout": 120,
                "description": "Analyze repository structure and identify patterns"
            },
            {
                "agent": "web_search",
                "action": "search_related_patterns",
                "timeout": 60,
                "description": "Search for related patterns and best practices"
            },
            {
                "agent": "semantic_analysis",
                "action": "deep_semantic_analysis",
                "timeout": 180,
                "description": "Perform deep semantic analysis of code and documentation"
            },
            {
                "agent": "knowledge_graph",
                "action": "create_semantic_entities",
                "timeout": 90,
                "description": "Create entities and relationships from analysis"
            },
            {
                "agent": "deduplication",
                "action": "deduplicate_entities",
                "timeout": 60,
                "description": "Remove duplicate entities and merge similar ones"
            },
            {
                "agent": "synchronization",
                "action": "sync_with_mcp_memory",
                "timeout": 60,
                "description": "Synchronize entities with MCP memory system"
            },
            {
                "agent": "synchronization",
                "action": "sync_with_ukb",
                "timeout": 60,
                "description": "Synchronize insights with UKB knowledge base"
            },
            {
                "agent": "documentation",
                "action": "generate_analysis_report",
                "timeout": 60,
                "description": "Generate comprehensive analysis report"
            }
        ],
        config={
            "qa_validation": True,
            "allow_partial_completion": False,
            "min_completeness": 0.8,
            "enable_parallel_steps": False,
            "retry_failed_steps": True,
            "max_retries": 2,
            "quality_thresholds": {
                "min_significance": 6,
                "max_errors": 2
            }
        }
    )


def get_workflow_parameters_schema() -> Dict[str, Any]:
    """Get parameter schema for complete analysis workflow."""
    return {
        "type": "object",
        "properties": {
            "repository": {
                "type": "string",
                "description": "Path to repository for analysis",
                "required": True
            },
            "depth": {
                "type": "integer",
                "description": "Analysis depth (number of commits/items)",
                "default": 10,
                "minimum": 1,
                "maximum": 100
            },
            "significance_threshold": {
                "type": "integer",
                "description": "Minimum significance threshold (1-10)",
                "default": 6,
                "minimum": 1,
                "maximum": 10
            },
            "include_files": {
                "type": "boolean",
                "description": "Include file-level analysis",
                "default": True
            },
            "enable_web_search": {
                "type": "boolean",
                "description": "Enable web search for related patterns",
                "default": True
            },
            "generate_documentation": {
                "type": "boolean",
                "description": "Generate analysis documentation",
                "default": True
            }
        },
        "required": ["repository"]
    }


def validate_workflow_parameters(parameters: Dict[str, Any]) -> Dict[str, Any]:
    """Validate workflow parameters."""
    errors = []
    warnings = []
    
    # Check required parameters
    if "repository" not in parameters:
        errors.append("Repository path is required")
    
    # Validate depth
    depth = parameters.get("depth", 10)
    if not isinstance(depth, int) or depth < 1 or depth > 100:
        errors.append("Depth must be an integer between 1 and 100")
    
    # Validate significance threshold
    significance_threshold = parameters.get("significance_threshold", 6)
    if not isinstance(significance_threshold, int) or significance_threshold < 1 or significance_threshold > 10:
        errors.append("Significance threshold must be an integer between 1 and 10")
    
    # Warnings for potentially problematic values
    if depth > 50:
        warnings.append("High depth values may result in long analysis times")
    
    if significance_threshold < 3:
        warnings.append("Low significance threshold may result in many low-quality entities")
    
    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings
    }


def estimate_workflow_duration(parameters: Dict[str, Any]) -> Dict[str, Any]:
    """Estimate workflow execution duration."""
    base_time = 60  # Base time in seconds
    
    # Factor in depth
    depth = parameters.get("depth", 10)
    depth_factor = min(depth / 10, 5)  # Max 5x multiplier
    
    # Factor in file analysis
    file_analysis_factor = 1.5 if parameters.get("include_files", True) else 1.0
    
    # Factor in web search
    web_search_factor = 1.3 if parameters.get("enable_web_search", True) else 1.0
    
    estimated_seconds = base_time * depth_factor * file_analysis_factor * web_search_factor
    
    return {
        "estimated_seconds": int(estimated_seconds),
        "estimated_minutes": int(estimated_seconds / 60),
        "factors": {
            "depth_factor": depth_factor,
            "file_analysis_factor": file_analysis_factor,
            "web_search_factor": web_search_factor
        }
    }