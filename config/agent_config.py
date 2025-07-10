"""
Agent Configuration Management
Defines the 7-agent architecture and their configurations
"""

from typing import Dict, Any, List
from dataclasses import dataclass, field
from pathlib import Path
import os


@dataclass
class AgentDefinition:
    """Definition of a single agent in the system."""
    name: str
    class_name: str
    module_path: str
    dependencies: List[str] = field(default_factory=list)
    config: Dict[str, Any] = field(default_factory=dict)
    enabled: bool = True
    priority: int = 1


@dataclass
class WorkflowDefinition:
    """Definition of a workflow in the system."""
    name: str
    description: str
    agents: List[str]
    steps: List[Dict[str, Any]]
    config: Dict[str, Any] = field(default_factory=dict)


class AgentConfig:
    """Configuration manager for the 7-agent semantic analysis system."""
    
    def __init__(self, config_path: Path = None):
        self.config_path = config_path
        self.base_path = Path(__file__).parent.parent
        self.coding_tools_path = Path(os.getenv("CODING_TOOLS_PATH", self.base_path.parent.parent))
        
    def get_agent_definitions(self) -> Dict[str, AgentDefinition]:
        """Get definitions for all 7 agents in the system."""
        return {
            "coordinator": AgentDefinition(
                name="coordinator",
                class_name="CoordinatorAgent",
                module_path="agents.coordinator",
                dependencies=[],  # Coordinator has no dependencies
                config={
                    "max_concurrent_workflows": 5,
                    "qa_validation_enabled": True,
                    "auto_correction_enabled": True,
                    "workflow_timeout": 300,  # 5 minutes
                    "quality_thresholds": {
                        "min_significance": 5,
                        "min_completeness": 0.8,
                        "max_errors": 3
                    }
                },
                priority=1
            ),
            
            "semantic_analysis": AgentDefinition(
                name="semantic_analysis",
                class_name="SemanticAnalysisAgent", 
                module_path="agents.semantic_analysis",
                dependencies=["coordinator"],
                config={
                    "llm_providers": {
                        "primary": "auto",  # Auto-detect from API keys
                        "fallback_enabled": True,
                        "cache_enabled": True,
                        "cache_ttl": 300,  # 5 minutes
                        "max_tokens": 4096,
                        "temperature": 0.3
                    },
                    "analysis": {
                        "significance_threshold": 7,
                        "max_depth": 10,
                        "include_patterns": True,
                        "include_metrics": True
                    }
                },
                priority=2
            ),
            
            "knowledge_graph": AgentDefinition(
                name="knowledge_graph",
                class_name="KnowledgeGraphAgent",
                module_path="agents.knowledge_graph",
                dependencies=["coordinator"],
                config={
                    "ukb_integration": {
                        "ukb_path": str(self.coding_tools_path / "bin" / "ukb"),
                        "shared_memory_path": str(self.coding_tools_path / "shared-memory-coding.json"),
                        "auto_sync": True,
                        "batch_size": 10
                    },
                    "entity_processing": {
                        "merge_similar": True,
                        "similarity_threshold": 0.85,
                        "max_entities_per_batch": 50
                    }
                },
                priority=3
            ),
            
            "web_search": AgentDefinition(
                name="web_search",
                class_name="WebSearchAgent",
                module_path="agents.web_search", 
                dependencies=["coordinator"],
                config={
                    "search_providers": ["duckduckgo", "google"],  # Fallback chain
                    "max_results": 10,
                    "timeout": 30,
                    "content_extraction": {
                        "max_content_length": 10000,
                        "extract_code": True,
                        "extract_links": True
                    }
                },
                priority=4
            ),
            
            "synchronization": AgentDefinition(
                name="synchronization", 
                class_name="SynchronizationAgent",
                module_path="agents.synchronization",
                dependencies=["coordinator", "knowledge_graph"],
                config={
                    "sync_targets": {
                        "mcp_memory": {
                            "enabled": True,
                            "bidirectional": True
                        },
                        "graphology_db": {
                            "enabled": True,
                            "bidirectional": True
                        },
                        "shared_memory_files": {
                            "enabled": True,
                            "bidirectional": True,
                            "file_patterns": ["shared-memory-*.json"]
                        }
                    },
                    "conflict_resolution": {
                        "strategy": "timestamp_priority",  # latest wins
                        "manual_review_threshold": 0.5
                    },
                    "sync_interval": 60  # seconds
                },
                priority=5
            ),
            
            "deduplication": AgentDefinition(
                name="deduplication",
                class_name="DeduplicationAgent", 
                module_path="agents.deduplication",
                dependencies=["coordinator", "knowledge_graph"],
                config={
                    "similarity_detection": {
                        "embedding_model": "sentence-transformers/all-MiniLM-L6-v2",
                        "similarity_threshold": 0.85,
                        "batch_size": 100
                    },
                    "merging_strategy": {
                        "preserve_references": True,
                        "merge_observations": True,
                        "keep_most_significant": True
                    }
                },
                priority=6
            ),
            
            "documentation": AgentDefinition(
                name="documentation",
                class_name="DocumentationAgent",
                module_path="agents.documentation",
                dependencies=["coordinator", "semantic_analysis"],
                config={
                    "generation": {
                        "template_dir": str(self.base_path / "templates"),
                        "output_format": "markdown",
                        "include_code_examples": True,
                        "include_diagrams": False  # Can be enabled later
                    },
                    "auto_generation": {
                        "on_workflow_completion": True,
                        "on_significant_insights": True,
                        "significance_threshold": 8
                    }
                },
                priority=7
            )
        }
    
    def get_workflow_definitions(self) -> Dict[str, WorkflowDefinition]:
        """Get definitions for standard workflows."""
        return {
            "complete_semantic_analysis": WorkflowDefinition(
                name="complete_semantic_analysis",
                description="Complete semantic analysis with all agents",
                agents=["coordinator", "semantic_analysis", "knowledge_graph", "web_search", "synchronization", "deduplication", "documentation"],
                steps=[
                    {"agent": "coordinator", "action": "initialize_workflow", "timeout": 30},
                    {"agent": "semantic_analysis", "action": "analyze_repository", "timeout": 180},
                    {"agent": "web_search", "action": "gather_context", "timeout": 60},
                    {"agent": "knowledge_graph", "action": "process_entities", "timeout": 120},
                    {"agent": "deduplication", "action": "merge_similar_entities", "timeout": 60},
                    {"agent": "synchronization", "action": "sync_all_targets", "timeout": 60},
                    {"agent": "documentation", "action": "generate_report", "timeout": 120},
                    {"agent": "coordinator", "action": "validate_and_complete", "timeout": 30}
                ],
                config={
                    "max_duration": 600,  # 10 minutes
                    "allow_partial_completion": True,
                    "qa_validation": True
                }
            ),
            
            "incremental_analysis": WorkflowDefinition(
                name="incremental_analysis", 
                description="Incremental analysis since last run",
                agents=["coordinator", "semantic_analysis", "knowledge_graph", "synchronization"],
                steps=[
                    {"agent": "coordinator", "action": "detect_changes", "timeout": 30},
                    {"agent": "semantic_analysis", "action": "analyze_changes", "timeout": 120},
                    {"agent": "knowledge_graph", "action": "update_entities", "timeout": 60},
                    {"agent": "synchronization", "action": "sync_changes", "timeout": 30},
                    {"agent": "coordinator", "action": "complete_incremental", "timeout": 15}
                ],
                config={
                    "max_duration": 300,  # 5 minutes
                    "skip_if_no_changes": True
                }
            ),
            
            "conversation_analysis": WorkflowDefinition(
                name="conversation_analysis",
                description="Analyze conversation for insights",
                agents=["coordinator", "semantic_analysis", "knowledge_graph", "synchronization"],
                steps=[
                    {"agent": "coordinator", "action": "prepare_conversation", "timeout": 15},
                    {"agent": "semantic_analysis", "action": "extract_insights", "timeout": 120},
                    {"agent": "knowledge_graph", "action": "create_entities", "timeout": 60},
                    {"agent": "synchronization", "action": "sync_insights", "timeout": 30},
                    {"agent": "coordinator", "action": "validate_insights", "timeout": 30}
                ],
                config={
                    "max_duration": 300,  # 5 minutes
                    "extract_code_patterns": True
                }
            ),
            
            "repository_analysis": WorkflowDefinition(
                name="repository_analysis",
                description="Focused repository pattern analysis",
                agents=["coordinator", "semantic_analysis", "web_search", "knowledge_graph", "deduplication"],
                steps=[
                    {"agent": "coordinator", "action": "scan_repository", "timeout": 30},
                    {"agent": "semantic_analysis", "action": "analyze_patterns", "timeout": 180},
                    {"agent": "web_search", "action": "research_technologies", "timeout": 90},
                    {"agent": "knowledge_graph", "action": "map_architecture", "timeout": 120},
                    {"agent": "deduplication", "action": "consolidate_patterns", "timeout": 60},
                    {"agent": "coordinator", "action": "generate_summary", "timeout": 30}
                ],
                config={
                    "max_duration": 600,  # 10 minutes
                    "include_dependencies": True,
                    "analyze_architecture": True
                }
            ),
            
            "code-analysis": WorkflowDefinition(
                name="code-analysis",
                description="Analyze code for patterns, issues, and architectural insights",
                agents=["coordinator", "semantic_analysis", "knowledge_graph", "synchronization"],
                steps=[
                    {"agent": "semantic_analysis", "action": "analyze_code", "timeout": 60},
                    {"agent": "knowledge_graph", "action": "extract_patterns", "timeout": 30},
                    {"agent": "synchronization", "action": "sync_results", "timeout": 30}
                ],
                config={
                    "qa_validation": True,
                    "min_significance": 5,
                    "max_duration": 120
                }
            ),
            
            "insight-generation": WorkflowDefinition(
                name="insight-generation",
                description="Generate actionable insights from analysis context",
                agents=["coordinator", "semantic_analysis", "knowledge_graph", "synchronization"],
                steps=[
                    {"agent": "semantic_analysis", "action": "analyze_insights", "timeout": 60},
                    {"agent": "knowledge_graph", "action": "create_insight_entities", "timeout": 30},
                    {"agent": "synchronization", "action": "sync_insights", "timeout": 30}
                ],
                config={
                    "qa_validation": True,
                    "min_significance": 5,
                    "max_duration": 120
                }
            )
        }
    
    def get_system_config(self) -> Dict[str, Any]:
        """Get overall system configuration."""
        return {
            "system": {
                "max_concurrent_agents": 7,
                "max_concurrent_workflows": 3,
                "health_check_interval": 30,
                "agent_timeout": 300,
                "workflow_timeout": 600
            },
            "logging": {
                "level": "INFO",
                "structured": True,
                "include_agent_id": True,
                "include_workflow_id": True
            },
            "storage": {
                "event_store_path": str(self.base_path / "event_store"),
                "cache_dir": str(self.base_path / "cache"),
                "temp_dir": str(self.base_path / "tmp")
            },
            "apis": {
                "mcp_server": {
                    "enabled": True,
                    "stdio": True
                },
                "http_server": {
                    "enabled": True,
                    "host": "localhost",
                    "port": 8765
                },
                "cli": {
                    "enabled": True,
                    "command_name": "sal"
                }
            }
        }
    
    def validate_config(self) -> List[str]:
        """Validate the configuration and return any errors."""
        errors = []
        
        agents = self.get_agent_definitions()
        workflows = self.get_workflow_definitions()
        
        # Validate agent dependencies
        for agent_name, agent_def in agents.items():
            for dep in agent_def.dependencies:
                if dep not in agents:
                    errors.append(f"Agent {agent_name} depends on unknown agent {dep}")
        
        # Validate workflow agents
        for workflow_name, workflow_def in workflows.items():
            for agent_name in workflow_def.agents:
                if agent_name not in agents:
                    errors.append(f"Workflow {workflow_name} references unknown agent {agent_name}")
        
        # Validate paths
        if not self.coding_tools_path.exists():
            errors.append(f"Coding tools path does not exist: {self.coding_tools_path}")
        
        return errors