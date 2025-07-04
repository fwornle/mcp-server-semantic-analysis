"""
Incremental Analysis Workflow
Lightweight analysis workflow for changes since last analysis
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


def create_incremental_analysis_workflow() -> WorkflowDefinition:
    """Create incremental analysis workflow definition."""
    
    return WorkflowDefinition(
        name="incremental-analysis",
        description="Lightweight analysis of changes since last analysis",
        steps=[
            {
                "agent": "semantic_analysis",
                "action": "analyze_recent_changes",
                "timeout": 60,
                "description": "Analyze recent changes and commits"
            },
            {
                "agent": "semantic_analysis",
                "action": "extract_change_insights",
                "timeout": 60,
                "description": "Extract insights from recent changes"
            },
            {
                "agent": "knowledge_graph",
                "action": "update_existing_entities",
                "timeout": 45,
                "description": "Update existing entities with new information"
            },
            {
                "agent": "deduplication",
                "action": "merge_new_entities",
                "timeout": 30,
                "description": "Merge new entities with existing ones"
            },
            {
                "agent": "synchronization",
                "action": "incremental_sync",
                "timeout": 30,
                "description": "Incrementally sync changes to knowledge base"
            }
        ],
        config={
            "qa_validation": True,
            "allow_partial_completion": True,
            "min_completeness": 0.6,
            "enable_parallel_steps": True,
            "retry_failed_steps": True,
            "max_retries": 1,
            "quality_thresholds": {
                "min_significance": 5,
                "max_errors": 3
            }
        }
    )


def get_workflow_parameters_schema() -> Dict[str, Any]:
    """Get parameter schema for incremental analysis workflow."""
    return {
        "type": "object",
        "properties": {
            "repository": {
                "type": "string",
                "description": "Path to repository for analysis",
                "required": True
            },
            "since": {
                "type": "string",
                "description": "Analyze changes since this timestamp/commit",
                "format": "datetime or commit-hash"
            },
            "significance_threshold": {
                "type": "integer",
                "description": "Minimum significance threshold (1-10)",
                "default": 5,
                "minimum": 1,
                "maximum": 10
            },
            "include_merge_commits": {
                "type": "boolean",
                "description": "Include merge commits in analysis",
                "default": False
            },
            "max_commits": {
                "type": "integer",
                "description": "Maximum number of commits to analyze",
                "default": 20,
                "minimum": 1,
                "maximum": 100
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
    
    # Validate max_commits
    max_commits = parameters.get("max_commits", 20)
    if not isinstance(max_commits, int) or max_commits < 1 or max_commits > 100:
        errors.append("Max commits must be an integer between 1 and 100")
    
    # Validate significance threshold
    significance_threshold = parameters.get("significance_threshold", 5)
    if not isinstance(significance_threshold, int) or significance_threshold < 1 or significance_threshold > 10:
        errors.append("Significance threshold must be an integer between 1 and 10")
    
    # Warnings
    if max_commits > 50:
        warnings.append("High commit count may result in longer analysis times")
    
    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings
    }


def estimate_workflow_duration(parameters: Dict[str, Any]) -> Dict[str, Any]:
    """Estimate workflow execution duration."""
    base_time = 20  # Base time in seconds for incremental analysis
    
    # Factor in commit count
    max_commits = parameters.get("max_commits", 20)
    commit_factor = min(max_commits / 10, 3)  # Max 3x multiplier
    
    # Factor in merge commits
    merge_factor = 1.2 if parameters.get("include_merge_commits", False) else 1.0
    
    estimated_seconds = base_time * commit_factor * merge_factor
    
    return {
        "estimated_seconds": int(estimated_seconds),
        "estimated_minutes": max(1, int(estimated_seconds / 60)),
        "factors": {
            "commit_factor": commit_factor,
            "merge_factor": merge_factor
        }
    }