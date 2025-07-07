"""
Coordinator Agent
Orchestrates workflows between all agents and provides quality assurance
"""

import asyncio
import uuid
from typing import Dict, Any, Optional, List
from dataclasses import dataclass, field
from enum import Enum
import time

from .base import BaseAgent


class WorkflowStatus(Enum):
    """Workflow execution status."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class StepStatus(Enum):
    """Individual step status."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class WorkflowStep:
    """Individual step in a workflow."""
    agent: str
    action: str
    timeout: int = 60
    status: StepStatus = StepStatus.PENDING
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None


@dataclass
class WorkflowExecution:
    """Represents an executing workflow."""
    id: str
    name: str
    description: str
    steps: List[WorkflowStep] = field(default_factory=list)
    status: WorkflowStatus = WorkflowStatus.PENDING
    parameters: Dict[str, Any] = field(default_factory=dict)
    config: Dict[str, Any] = field(default_factory=dict)
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    current_step_index: int = 0
    results: Dict[str, Any] = field(default_factory=dict)
    qa_reports: List[Dict[str, Any]] = field(default_factory=list)


class QualityAssurance:
    """Quality assurance system for validating agent outputs."""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.validation_rules = self._setup_validation_rules()
    
    def _setup_validation_rules(self) -> Dict[str, Any]:
        """Setup validation rules for different types of outputs."""
        return {
            "semantic_analysis": {
                "required_fields": ["analysis", "significance"],
                "min_significance": self.config.get("min_significance", 5),
                "max_errors": self.config.get("max_errors", 3)
            },
            "knowledge_graph": {
                "required_fields": ["entities", "relations"],
                "min_entities": 1,
                "validate_entity_structure": True
            },
            "workflow": {
                "min_completeness": self.config.get("min_completeness", 0.8),
                "required_steps_completion": True
            }
        }
    
    async def validate_agent_output(self, agent_id: str, output: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """Validate output from a specific agent."""
        rules = self.validation_rules.get(agent_id, {})
        errors = []
        warnings = []
        corrected_output = None
        
        # Check required fields
        required_fields = rules.get("required_fields", [])
        for field in required_fields:
            if field not in output:
                errors.append(f"Missing required field: {field}")
        
        # Type-specific validation
        if agent_id == "semantic_analysis":
            significance = output.get("significance", 0)
            min_significance = rules.get("min_significance", 5)
            if significance < min_significance:
                warnings.append(f"Low significance score: {significance} < {min_significance}")
        
        elif agent_id == "knowledge_graph":
            entities = output.get("entities", [])
            min_entities = rules.get("min_entities", 1)
            if len(entities) < min_entities:
                errors.append(f"Insufficient entities: {len(entities)} < {min_entities}")
        
        # Auto-correction if enabled
        auto_correction_enabled = self.config.get("auto_correction_enabled", True)
        if auto_correction_enabled and errors and not self._is_critical_error(errors):
            corrected_output = await self._attempt_auto_correction(agent_id, output, errors, context)
        
        return {
            "passed": len(errors) == 0,
            "errors": errors,
            "warnings": warnings,
            "corrected": bool(corrected_output),
            "corrected_output": corrected_output,
            "validation_time": time.time()
        }
    
    def _is_critical_error(self, errors: List[str]) -> bool:
        """Check if errors are critical and cannot be auto-corrected."""
        critical_patterns = ["missing required field", "invalid format", "critical failure"]
        return any(any(pattern in error.lower() for pattern in critical_patterns) for error in errors)
    
    async def _attempt_auto_correction(self, agent_id: str, output: Dict[str, Any], errors: List[str], context: Dict[str, Any] = None) -> Optional[Dict[str, Any]]:
        """Attempt to auto-correct output based on validation errors."""
        corrected = output.copy()
        
        # Simple auto-corrections
        rules = self.validation_rules.get(agent_id, {})
        required_fields = rules.get("required_fields", [])
        
        for field in required_fields:
            if field not in corrected:
                # Provide default values for missing fields
                if field == "significance":
                    corrected[field] = 5  # Default significance
                elif field == "analysis":
                    corrected[field] = "Auto-generated analysis placeholder"
                elif field == "entities":
                    corrected[field] = []
                elif field == "relations":
                    corrected[field] = []
        
        return corrected
    
    async def validate_workflow(self, workflow: WorkflowExecution) -> Dict[str, Any]:
        """Validate entire workflow execution."""
        errors = []
        warnings = []
        
        # Check workflow completeness
        completed_steps = sum(1 for step in workflow.steps if step.status == StepStatus.COMPLETED)
        completeness = completed_steps / len(workflow.steps) if workflow.steps else 0
        
        min_completeness = self.validation_rules.get("workflow", {}).get("min_completeness", 0.8)
        if completeness < min_completeness:
            errors.append(f"Workflow incomplete: {completeness:.2f} < {min_completeness}")
        
        # Check for failed steps
        failed_steps = [step for step in workflow.steps if step.status == StepStatus.FAILED]
        if failed_steps:
            for step in failed_steps:
                errors.append(f"Step failed: {step.agent}.{step.action} - {step.error}")
        
        # Check timeout violations
        for step in workflow.steps:
            if step.start_time and step.end_time:
                duration = step.end_time - step.start_time
                if duration > step.timeout:
                    warnings.append(f"Step timeout exceeded: {step.agent}.{step.action} took {duration:.1f}s > {step.timeout}s")
        
        return {
            "passed": len(errors) == 0,
            "errors": errors,
            "warnings": warnings,
            "completeness": completeness,
            "failed_steps": len(failed_steps),
            "validation_time": time.time()
        }


class CoordinatorAgent(BaseAgent):
    """
    Coordinator agent that orchestrates workflows and provides quality assurance.
    """
    
    def __init__(self, name: str, config: Dict[str, Any], system: Any):
        super().__init__(name, config, system)
        
        self.active_workflows: Dict[str, WorkflowExecution] = {}
        self.workflow_history: List[WorkflowExecution] = []
        self.qa_system = QualityAssurance(config.get("quality_thresholds", {}))
        
        # Register capabilities
        self.register_capability("workflow_orchestration")
        self.register_capability("quality_assurance")
        self.register_capability("agent_coordination")
        self.register_capability("workflow_management")
    
    async def on_initialize(self):
        """Initialize the coordinator agent."""
        self.logger.info("Initializing coordinator agent...")
        
        # Register event handlers
        self._register_event_handlers()
        
        # Start background monitoring
        asyncio.create_task(self._workflow_monitor())
        
        self.logger.info("Coordinator agent initialized successfully")
    
    def _register_event_handlers(self):
        """Register event handlers for workflow management."""
        self.register_event_handler("execute_workflow", self._handle_execute_workflow)
        self.register_event_handler("get_workflow_status", self._handle_get_workflow_status)
        self.register_event_handler("cancel_workflow", self._handle_cancel_workflow)
        self.register_event_handler("validate_output", self._handle_validate_output)
    
    async def execute_workflow(self, workflow_name: str, workflow_def: Any = None, parameters: Dict[str, Any] = None) -> Dict[str, Any]:
        """Execute a workflow with the given definition and parameters."""
        parameters = parameters or {}
        
        # Handle missing workflow definition by creating a default one
        if workflow_def is None:
            workflow_def = self._create_default_workflow_def(workflow_name, parameters)
        
        # Create workflow execution
        workflow_id = str(uuid.uuid4())
        execution = WorkflowExecution(
            id=workflow_id,
            name=workflow_name,
            description=getattr(workflow_def, 'description', f"Auto-generated workflow: {workflow_name}"),
            parameters=parameters,
            config=getattr(workflow_def, 'config', {}),
            start_time=time.time()
        )
        
        # Convert workflow definition steps to execution steps
        steps = getattr(workflow_def, 'steps', [])
        execution.steps = [
            WorkflowStep(
                agent=step["agent"],
                action=step["action"],
                timeout=step.get("timeout", 60)
            )
            for step in steps
        ]
        
        # Add to active workflows
        self.active_workflows[workflow_id] = execution
        
        self.logger.info(
            "Starting workflow execution",
            workflow_id=workflow_id,
            workflow_name=workflow_name,
            steps=len(execution.steps)
        )
        
        # Start workflow execution
        asyncio.create_task(self._execute_workflow_steps(execution))
        
        return {
            "workflow_id": workflow_id,
            "status": execution.status.value,
            "steps": len(execution.steps)
        }
    
    async def _execute_workflow_steps(self, execution: WorkflowExecution):
        """Execute all steps in a workflow."""
        execution.status = WorkflowStatus.RUNNING
        
        try:
            for i, step in enumerate(execution.steps):
                execution.current_step_index = i
                
                self.logger.info(
                    "Executing workflow step",
                    workflow_id=execution.id,
                    step_index=i,
                    agent=step.agent,
                    action=step.action
                )
                
                # Execute step
                step_result = await self._execute_step(execution, step)
                
                # QA validation if enabled
                if execution.config.get("qa_validation", False):
                    qa_report = await self.qa_system.validate_agent_output(
                        step.agent,
                        step_result,
                        {"workflow_id": execution.id, "step_index": i}
                    )
                    
                    execution.qa_reports.append(qa_report)
                    
                    if not qa_report["passed"] and not qa_report["corrected"]:
                        self.logger.warning(
                            "QA validation failed for step",
                            workflow_id=execution.id,
                            step_index=i,
                            errors=qa_report["errors"]
                        )
                        
                        # Decide whether to continue or fail
                        if not execution.config.get("allow_partial_completion", False):
                            step.status = StepStatus.FAILED
                            step.error = f"QA validation failed: {qa_report['errors']}"
                            break
                    
                    # Use corrected output if available
                    if qa_report["corrected"]:
                        step_result = qa_report["corrected_output"]
                        self.logger.info("Using QA-corrected output for step")
                
                # Store step result
                execution.results[f"step_{i}_{step.agent}_{step.action}"] = step_result
                
                # Check if we should continue
                if step.status == StepStatus.FAILED:
                    if not execution.config.get("allow_partial_completion", False):
                        break
            
            # Complete workflow
            await self._complete_workflow(execution)
            
        except Exception as e:
            self.logger.error(
                "Workflow execution failed",
                workflow_id=execution.id,
                error=str(e)
            )
            execution.status = WorkflowStatus.FAILED
            execution.end_time = time.time()
    
    async def _execute_step(self, execution: WorkflowExecution, step: WorkflowStep) -> Dict[str, Any]:
        """Execute a single workflow step."""
        step.status = StepStatus.RUNNING
        step.start_time = time.time()
        
        try:
            # Get target agent
            target_agent = self.system.agents.get(step.agent)
            if not target_agent:
                raise ValueError(f"Agent not found: {step.agent}")
            
            # Prepare step data
            step_data = {
                "action": step.action,
                "workflow_id": execution.id,
                "parameters": execution.parameters,
                "previous_results": execution.results
            }
            
            # Execute with timeout
            result = await asyncio.wait_for(
                target_agent.handle_event(step.action, step_data),
                timeout=step.timeout
            )
            
            step.status = StepStatus.COMPLETED
            step.result = result
            step.end_time = time.time()
            
            self.logger.info(
                "Step completed successfully",
                workflow_id=execution.id,
                agent=step.agent,
                action=step.action,
                duration=step.end_time - step.start_time
            )
            
            return result
            
        except asyncio.TimeoutError:
            step.status = StepStatus.FAILED
            step.error = f"Step timeout after {step.timeout}s"
            step.end_time = time.time()
            raise
            
        except Exception as e:
            step.status = StepStatus.FAILED
            step.error = str(e)
            step.end_time = time.time()
            
            self.logger.error(
                "Step execution failed",
                workflow_id=execution.id,
                agent=step.agent,
                action=step.action,
                error=str(e)
            )
            raise
    
    async def _complete_workflow(self, execution: WorkflowExecution):
        """Complete workflow execution and perform final QA."""
        execution.end_time = time.time()
        
        # Perform final workflow validation
        final_qa = await self.qa_system.validate_workflow(execution)
        execution.qa_reports.append(final_qa)
        
        # Determine final status
        if final_qa["passed"]:
            execution.status = WorkflowStatus.COMPLETED
            self.logger.info(
                "Workflow completed successfully",
                workflow_id=execution.id,
                duration=execution.end_time - execution.start_time,
                completeness=final_qa["completeness"]
            )
        else:
            execution.status = WorkflowStatus.FAILED
            self.logger.warning(
                "Workflow completed with QA failures",
                workflow_id=execution.id,
                errors=final_qa["errors"]
            )
        
        # Move to history
        self.workflow_history.append(execution)
        if execution.id in self.active_workflows:
            del self.active_workflows[execution.id]
    
    async def get_workflow_status(self, workflow_id: str) -> Dict[str, Any]:
        """Get status of a workflow."""
        execution = self.active_workflows.get(workflow_id)
        if not execution:
            # Check history
            execution = next((w for w in self.workflow_history if w.id == workflow_id), None)
            if not execution:
                raise ValueError(f"Workflow not found: {workflow_id}")
        
        step_statuses = [
            {
                "agent": step.agent,
                "action": step.action,
                "status": step.status.value,
                "duration": (step.end_time - step.start_time) if step.start_time and step.end_time else None,
                "error": step.error
            }
            for step in execution.steps
        ]
        
        return {
            "workflow_id": workflow_id,
            "name": execution.name,
            "status": execution.status.value,
            "current_step": execution.current_step_index,
            "total_steps": len(execution.steps),
            "start_time": execution.start_time,
            "end_time": execution.end_time,
            "duration": (execution.end_time - execution.start_time) if execution.start_time and execution.end_time else None,
            "steps": step_statuses,
            "qa_reports": len(execution.qa_reports),
            "results_available": bool(execution.results)
        }
    
    async def _workflow_monitor(self):
        """Background task to monitor workflow execution."""
        while self.running:
            try:
                # Check for stuck workflows
                current_time = time.time()
                
                for workflow_id, execution in list(self.active_workflows.items()):
                    max_duration = execution.config.get("max_duration", 600)  # 10 minutes
                    
                    if execution.start_time and (current_time - execution.start_time) > max_duration:
                        self.logger.warning(
                            "Workflow timeout exceeded",
                            workflow_id=workflow_id,
                            duration=current_time - execution.start_time,
                            max_duration=max_duration
                        )
                        
                        execution.status = WorkflowStatus.FAILED
                        execution.end_time = current_time
                        
                        # Move to history
                        self.workflow_history.append(execution)
                        del self.active_workflows[workflow_id]
                
                # Cleanup old history
                max_history = 100
                if len(self.workflow_history) > max_history:
                    self.workflow_history = self.workflow_history[-max_history:]
                
                await asyncio.sleep(30)  # Check every 30 seconds
                
            except Exception as e:
                self.logger.error("Workflow monitor error", error=str(e))
                await asyncio.sleep(60)
    
    def _create_default_workflow_def(self, workflow_name: str, parameters: Dict[str, Any]):
        """Create a default workflow definition when none is provided."""
        class DefaultWorkflowDef:
            def __init__(self, name: str, params: Dict[str, Any]):
                self.description = f"Default workflow for {name}"
                self.config = {}
                
                # Create default steps based on workflow name
                if name in ["complete-analysis", "full-analysis"]:
                    self.steps = [
                        {"agent": "semantic_analysis", "action": "analyze", "timeout": 120},
                        {"agent": "knowledge_graph", "action": "update", "timeout": 60},
                        {"agent": "documentation", "action": "generate", "timeout": 60}
                    ]
                elif name in ["simple-analysis", "quick-analysis"]:
                    self.steps = [
                        {"agent": "semantic_analysis", "action": "analyze", "timeout": 60}
                    ]
                else:
                    # Generic workflow
                    self.steps = [
                        {"agent": "semantic_analysis", "action": "analyze", "timeout": 60}
                    ]
        
        return DefaultWorkflowDef(workflow_name, parameters)
    
    # Event handlers
    async def _handle_execute_workflow(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle workflow execution requests."""
        workflow_name = data.get("workflow_name")
        workflow_def = data.get("workflow_def")
        parameters = data.get("parameters", {})
        
        return await self.execute_workflow(workflow_name, workflow_def, parameters)
    
    async def _handle_get_workflow_status(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle workflow status requests."""
        workflow_id = data.get("workflow_id")
        return await self.get_workflow_status(workflow_id)
    
    async def _handle_cancel_workflow(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle workflow cancellation requests."""
        workflow_id = data.get("workflow_id")
        
        execution = self.active_workflows.get(workflow_id)
        if execution:
            execution.status = WorkflowStatus.CANCELLED
            execution.end_time = time.time()
            
            # Move to history
            self.workflow_history.append(execution)
            del self.active_workflows[workflow_id]
            
            return {"workflow_id": workflow_id, "status": "cancelled"}
        else:
            raise ValueError(f"Active workflow not found: {workflow_id}")
    
    async def _handle_validate_output(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle output validation requests."""
        agent_id = data.get("agent_id")
        output = data.get("output")
        context = data.get("context", {})
        
        return await self.qa_system.validate_agent_output(agent_id, output, context)
    
    async def health_check(self) -> Dict[str, Any]:
        """Check coordinator health."""
        base_health = await super().health_check()
        
        return {
            **base_health,
            "active_workflows": len(self.active_workflows),
            "workflow_history": len(self.workflow_history),
            "qa_enabled": bool(self.qa_system)
        }
    
    async def on_shutdown(self):
        """Cleanup on shutdown."""
        # Cancel all active workflows
        for workflow_id, execution in self.active_workflows.items():
            execution.status = WorkflowStatus.CANCELLED
            execution.end_time = time.time()
            
        # Clear state
        self.active_workflows.clear()