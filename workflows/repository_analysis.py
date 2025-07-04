"""
Repository Analysis Workflow
Focused workflow for analyzing repository structure and codebase patterns
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


def create_repository_analysis_workflow() -> WorkflowDefinition:
    """Create repository analysis workflow definition."""
    
    return WorkflowDefinition(
        name="repository-analysis",
        description="Analyze repository structure, code patterns, and architecture",
        steps=[
            {
                "agent": "semantic_analysis",
                "action": "analyze_repository_structure",
                "timeout": 60,
                "description": "Analyze repository directory structure and organization"
            },
            {
                "agent": "semantic_analysis",
                "action": "analyze_code_patterns",
                "timeout": 90,
                "description": "Identify code patterns and architectural decisions"
            },
            {
                "agent": "semantic_analysis",
                "action": "analyze_dependencies",
                "timeout": 45,
                "description": "Analyze dependencies and technology stack"
            },
            {
                "agent": "knowledge_graph",
                "action": "create_architecture_entities",
                "timeout": 60,
                "description": "Create entities representing architectural components"
            },
            {
                "agent": "knowledge_graph",
                "action": "create_pattern_entities",
                "timeout": 60,
                "description": "Create entities for identified patterns"
            },
            {
                "agent": "deduplication",
                "action": "merge_similar_patterns",
                "timeout": 30,
                "description": "Merge similar patterns and components"
            },
            {
                "agent": "synchronization",
                "action": "sync_repository_insights",
                "timeout": 45,
                "description": "Sync repository insights to knowledge base"
            },
            {
                "agent": "documentation",
                "action": "generate_repository_report",
                "timeout": 45,
                "description": "Generate repository analysis report"
            }
        ],
        config={
            "qa_validation": True,
            "allow_partial_completion": True,
            "min_completeness": 0.75,
            "enable_parallel_steps": True,
            "retry_failed_steps": True,
            "max_retries": 2,
            "quality_thresholds": {
                "min_significance": 5,
                "max_errors": 2
            }
        }
    )


def get_workflow_parameters_schema() -> Dict[str, Any]:
    """Get parameter schema for repository analysis workflow."""
    return {
        "type": "object",
        "properties": {
            "repository": {
                "type": "string",
                "description": "Path to repository for analysis",
                "required": True
            },
            "analyze_structure": {
                "type": "boolean",
                "description": "Analyze directory structure and organization",
                "default": True
            },
            "analyze_patterns": {
                "type": "boolean",
                "description": "Identify code patterns and design principles",
                "default": True
            },
            "analyze_dependencies": {
                "type": "boolean",
                "description": "Analyze dependencies and technology stack",
                "default": True
            },
            "include_documentation": {
                "type": "boolean",
                "description": "Include documentation files in analysis",
                "default": True
            },
            "include_tests": {
                "type": "boolean",
                "description": "Include test files in analysis",
                "default": False
            },
            "significance_threshold": {
                "type": "integer",
                "description": "Minimum significance threshold (1-10)",
                "default": 5,
                "minimum": 1,
                "maximum": 10
            },
            "max_file_count": {
                "type": "integer",
                "description": "Maximum number of files to analyze",
                "default": 200,
                "minimum": 10,
                "maximum": 1000
            },
            "exclude_patterns": {
                "type": "array",
                "description": "File patterns to exclude from analysis",
                "items": {"type": "string"},
                "default": ["*.log", "*.tmp", "node_modules/*", ".git/*"]
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
    
    # Validate max_file_count
    max_file_count = parameters.get("max_file_count", 200)
    if not isinstance(max_file_count, int) or max_file_count < 10 or max_file_count > 1000:
        errors.append("Max file count must be an integer between 10 and 1000")
    
    # Validate significance threshold
    significance_threshold = parameters.get("significance_threshold", 5)
    if not isinstance(significance_threshold, int) or significance_threshold < 1 or significance_threshold > 10:
        errors.append("Significance threshold must be an integer between 1 and 10")
    
    # Validate exclude patterns
    exclude_patterns = parameters.get("exclude_patterns", [])
    if not isinstance(exclude_patterns, list):
        errors.append("Exclude patterns must be a list of strings")
    
    # Warnings
    if max_file_count > 500:
        warnings.append("High file count may result in long analysis times")
    
    if not parameters.get("analyze_structure", True) and not parameters.get("analyze_patterns", True):
        warnings.append("At least one analysis type should be enabled")
    
    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings
    }


def estimate_workflow_duration(parameters: Dict[str, Any]) -> Dict[str, Any]:
    """Estimate workflow execution duration."""
    base_time = 45  # Base time in seconds
    
    # Factor in file count
    max_file_count = parameters.get("max_file_count", 200)
    file_factor = min(max_file_count / 100, 5)  # Max 5x multiplier
    
    # Factor in analysis types
    analysis_factor = 1.0
    if parameters.get("analyze_structure", True):
        analysis_factor += 0.3
    if parameters.get("analyze_patterns", True):
        analysis_factor += 0.5
    if parameters.get("analyze_dependencies", True):
        analysis_factor += 0.2
    if parameters.get("include_documentation", True):
        analysis_factor += 0.3
    if parameters.get("include_tests", False):
        analysis_factor += 0.4
    
    estimated_seconds = base_time * file_factor * analysis_factor
    
    return {
        "estimated_seconds": int(estimated_seconds),
        "estimated_minutes": max(1, int(estimated_seconds / 60)),
        "factors": {
            "file_factor": file_factor,
            "analysis_factor": analysis_factor
        }
    }