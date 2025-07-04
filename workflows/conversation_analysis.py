"""
Conversation Analysis Workflow
Specialized workflow for analyzing conversation files and extracting insights
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


def create_conversation_analysis_workflow() -> WorkflowDefinition:
    """Create conversation analysis workflow definition."""
    
    return WorkflowDefinition(
        name="conversation-analysis",
        description="Analyze conversation files for insights and patterns",
        steps=[
            {
                "agent": "semantic_analysis",
                "action": "parse_conversation_structure",
                "timeout": 30,
                "description": "Parse conversation structure and identify participants"
            },
            {
                "agent": "semantic_analysis",
                "action": "extract_conversation_insights",
                "timeout": 90,
                "description": "Extract key insights and decisions from conversation"
            },
            {
                "agent": "semantic_analysis",
                "action": "identify_patterns",
                "timeout": 60,
                "description": "Identify patterns and recurring themes"
            },
            {
                "agent": "knowledge_graph",
                "action": "create_conversation_entities",
                "timeout": 60,
                "description": "Create entities from conversation insights"
            },
            {
                "agent": "deduplication",
                "action": "deduplicate_conversation_entities",
                "timeout": 30,
                "description": "Remove duplicate entities from conversation"
            },
            {
                "agent": "synchronization",
                "action": "sync_conversation_insights",
                "timeout": 30,
                "description": "Sync conversation insights to knowledge base"
            },
            {
                "agent": "documentation",
                "action": "generate_conversation_summary",
                "timeout": 30,
                "description": "Generate conversation summary and key takeaways"
            }
        ],
        config={
            "qa_validation": True,
            "allow_partial_completion": True,
            "min_completeness": 0.7,
            "enable_parallel_steps": False,
            "retry_failed_steps": True,
            "max_retries": 2,
            "quality_thresholds": {
                "min_significance": 4,
                "max_errors": 3
            }
        }
    )


def get_workflow_parameters_schema() -> Dict[str, Any]:
    """Get parameter schema for conversation analysis workflow."""
    return {
        "type": "object",
        "properties": {
            "conversation_file": {
                "type": "string",
                "description": "Path to conversation file",
                "required": True
            },
            "conversation_format": {
                "type": "string",
                "description": "Format of conversation file",
                "enum": ["markdown", "json", "txt", "auto"],
                "default": "auto"
            },
            "extract_insights": {
                "type": "boolean",
                "description": "Extract actionable insights",
                "default": True
            },
            "identify_decisions": {
                "type": "boolean",
                "description": "Identify key decisions made",
                "default": True
            },
            "extract_patterns": {
                "type": "boolean",
                "description": "Extract recurring patterns",
                "default": True
            },
            "significance_threshold": {
                "type": "integer",
                "description": "Minimum significance threshold (1-10)",
                "default": 4,
                "minimum": 1,
                "maximum": 10
            },
            "participant_analysis": {
                "type": "boolean",
                "description": "Analyze participant contributions",
                "default": False
            }
        },
        "required": ["conversation_file"]
    }


def validate_workflow_parameters(parameters: Dict[str, Any]) -> Dict[str, Any]:
    """Validate workflow parameters."""
    errors = []
    warnings = []
    
    # Check required parameters
    if "conversation_file" not in parameters:
        errors.append("Conversation file path is required")
    
    # Validate conversation format
    conversation_format = parameters.get("conversation_format", "auto")
    valid_formats = ["markdown", "json", "txt", "auto"]
    if conversation_format not in valid_formats:
        errors.append(f"Conversation format must be one of: {valid_formats}")
    
    # Validate significance threshold
    significance_threshold = parameters.get("significance_threshold", 4)
    if not isinstance(significance_threshold, int) or significance_threshold < 1 or significance_threshold > 10:
        errors.append("Significance threshold must be an integer between 1 and 10")
    
    # Check file existence warning
    conversation_file = parameters.get("conversation_file", "")
    if conversation_file and not conversation_file.endswith(('.md', '.txt', '.json')):
        warnings.append("Conversation file extension may not be supported")
    
    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings
    }


def estimate_workflow_duration(parameters: Dict[str, Any]) -> Dict[str, Any]:
    """Estimate workflow execution duration."""
    base_time = 30  # Base time in seconds
    
    # Factor in analysis options
    analysis_factor = 1.0
    if parameters.get("extract_insights", True):
        analysis_factor += 0.3
    if parameters.get("identify_decisions", True):
        analysis_factor += 0.2
    if parameters.get("extract_patterns", True):
        analysis_factor += 0.3
    if parameters.get("participant_analysis", False):
        analysis_factor += 0.4
    
    estimated_seconds = base_time * analysis_factor
    
    return {
        "estimated_seconds": int(estimated_seconds),
        "estimated_minutes": max(1, int(estimated_seconds / 60)),
        "factors": {
            "analysis_factor": analysis_factor
        }
    }