"""
Workflow Definitions for Semantic Analysis System
Graphite-based workflow definitions for different analysis types
"""

from typing import Dict, Any, Optional
from .complete_analysis import create_complete_analysis_workflow
from .incremental_analysis import create_incremental_analysis_workflow
from .conversation_analysis import create_conversation_analysis_workflow
from .repository_analysis import create_repository_analysis_workflow


class WorkflowRegistry:
    """Registry for all available workflows."""
    
    def __init__(self):
        self._workflows = {}
        self._parameter_schemas = {}
        self._validators = {}
        self._estimators = {}
        
        # Register all workflows
        self._register_workflows()
    
    def _register_workflows(self):
        """Register all workflow definitions."""
        # Complete analysis workflow
        from .complete_analysis import (
            create_complete_analysis_workflow,
            get_workflow_parameters_schema as get_complete_schema,
            validate_workflow_parameters as validate_complete,
            estimate_workflow_duration as estimate_complete
        )
        
        self._workflows["complete-analysis"] = create_complete_analysis_workflow()
        self._parameter_schemas["complete-analysis"] = get_complete_schema()
        self._validators["complete-analysis"] = validate_complete
        self._estimators["complete-analysis"] = estimate_complete
        
        # Incremental analysis workflow
        from .incremental_analysis import (
            create_incremental_analysis_workflow,
            get_workflow_parameters_schema as get_incremental_schema,
            validate_workflow_parameters as validate_incremental,
            estimate_workflow_duration as estimate_incremental
        )
        
        self._workflows["incremental-analysis"] = create_incremental_analysis_workflow()
        self._parameter_schemas["incremental-analysis"] = get_incremental_schema()
        self._validators["incremental-analysis"] = validate_incremental
        self._estimators["incremental-analysis"] = estimate_incremental
        
        # Conversation analysis workflow
        from .conversation_analysis import (
            create_conversation_analysis_workflow,
            get_workflow_parameters_schema as get_conversation_schema,
            validate_workflow_parameters as validate_conversation,
            estimate_workflow_duration as estimate_conversation
        )
        
        self._workflows["conversation-analysis"] = create_conversation_analysis_workflow()
        self._parameter_schemas["conversation-analysis"] = get_conversation_schema()
        self._validators["conversation-analysis"] = validate_conversation
        self._estimators["conversation-analysis"] = estimate_conversation
        
        # Repository analysis workflow
        from .repository_analysis import (
            create_repository_analysis_workflow,
            get_workflow_parameters_schema as get_repository_schema,
            validate_workflow_parameters as validate_repository,
            estimate_workflow_duration as estimate_repository
        )
        
        self._workflows["repository-analysis"] = create_repository_analysis_workflow()
        self._parameter_schemas["repository-analysis"] = get_repository_schema()
        self._validators["repository-analysis"] = validate_repository
        self._estimators["repository-analysis"] = estimate_repository
    
    def get_workflow(self, name: str) -> Optional[Any]:
        """Get workflow definition by name."""
        return self._workflows.get(name)
    
    def get_parameter_schema(self, name: str) -> Optional[Dict[str, Any]]:
        """Get parameter schema for workflow."""
        return self._parameter_schemas.get(name)
    
    def validate_parameters(self, name: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
        """Validate parameters for workflow."""
        validator = self._validators.get(name)
        if not validator:
            return {"valid": False, "errors": [f"Unknown workflow: {name}"], "warnings": []}
        
        return validator(parameters)
    
    def estimate_duration(self, name: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
        """Estimate duration for workflow execution."""
        estimator = self._estimators.get(name)
        if not estimator:
            return {"estimated_seconds": 60, "estimated_minutes": 1, "factors": {}}
        
        return estimator(parameters)
    
    def list_workflows(self) -> Dict[str, Any]:
        """List all available workflows with metadata."""
        workflows = {}
        
        for name, workflow_def in self._workflows.items():
            workflows[name] = {
                "name": workflow_def.name,
                "description": workflow_def.description,
                "steps": len(workflow_def.steps),
                "parameter_schema": self._parameter_schemas.get(name, {}),
                "config": workflow_def.config
            }
        
        return workflows
    
    def get_workflow_info(self, name: str) -> Optional[Dict[str, Any]]:
        """Get detailed information about a specific workflow."""
        workflow_def = self._workflows.get(name)
        if not workflow_def:
            return None
        
        return {
            "name": workflow_def.name,
            "description": workflow_def.description,
            "steps": [
                {
                    "agent": step["agent"],
                    "action": step["action"],
                    "timeout": step["timeout"],
                    "description": step["description"]
                }
                for step in workflow_def.steps
            ],
            "config": workflow_def.config,
            "parameter_schema": self._parameter_schemas.get(name, {}),
            "step_count": len(workflow_def.steps)
        }


# Global workflow registry instance
workflow_registry = WorkflowRegistry()


def get_workflow_registry() -> WorkflowRegistry:
    """Get the global workflow registry."""
    return workflow_registry


def get_workflow(name: str):
    """Convenience function to get a workflow by name."""
    return workflow_registry.get_workflow(name)


def list_available_workflows() -> Dict[str, Any]:
    """Convenience function to list all workflows."""
    return workflow_registry.list_workflows()


def validate_workflow_parameters(name: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
    """Convenience function to validate workflow parameters."""
    return workflow_registry.validate_parameters(name, parameters)


def estimate_workflow_duration(name: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
    """Convenience function to estimate workflow duration."""
    return workflow_registry.estimate_duration(name, parameters)


__all__ = [
    "WorkflowRegistry",
    "workflow_registry",
    "get_workflow_registry",
    "get_workflow",
    "list_available_workflows",
    "validate_workflow_parameters",
    "estimate_workflow_duration"
]