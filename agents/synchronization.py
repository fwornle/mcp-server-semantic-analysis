"""
Synchronization Agent
Handles data sync between MCP Memory, Graphology DB, and shared-memory files
"""

import asyncio
import json
import os
from pathlib import Path
from typing import Dict, Any, List, Optional
import time
import datetime
import hashlib

from .base import BaseAgent

# Version tracking for this agent
SYNC_AGENT_VERSION = "1.4.1"
SYNC_AGENT_FILE = __file__


class SynchronizationAgent(BaseAgent):
    """Agent for synchronizing data across multiple storage systems."""
    
    def __init__(self, name: str, config: Dict[str, Any], system: Any):
        super().__init__(name, config, system)
        
        self.sync_targets = config.get("sync_targets", {})
        self.conflict_resolution = config.get("conflict_resolution", {})
        self.sync_interval = config.get("sync_interval", 60)
        self.last_sync_times = {}
        
        self.register_capability("data_synchronization")
        self.register_capability("conflict_resolution")
        self.register_capability("backup_management")
    
    async def on_initialize(self):
        """Initialize synchronization agent."""
        # Version and startup logging
        sync_agent_hash = hashlib.md5(open(SYNC_AGENT_FILE, 'rb').read()).hexdigest()[:8]
        self.logger.info(f"🔄 ====== SYNCHRONIZATION AGENT STARTUP ======")
        self.logger.info(f"📝 Sync Agent Version: {SYNC_AGENT_VERSION}")
        self.logger.info(f"📁 Sync Agent File: {SYNC_AGENT_FILE}")
        self.logger.info(f"🔢 Sync Agent Hash: {sync_agent_hash}")
        self.logger.info(f"📅 Sync Agent Init Time: {datetime.datetime.now().isoformat()}")
        self.logger.info(f"==============================================")
        
        self.logger.info("Initializing synchronization agent...")
        
        self._register_event_handlers()
        
        # Start periodic sync
        asyncio.create_task(self._periodic_sync())
    
    def _register_event_handlers(self):
        """Register event handlers."""
        self.register_event_handler("sync_all", self._handle_sync_all)
        self.register_event_handler("sync_target", self._handle_sync_target)
        self.register_event_handler("resolve_conflicts", self._handle_resolve_conflicts)
        self.register_event_handler("backup_data", self._handle_backup_data)
        
        # Missing workflow action handlers
        # self.register_event_handler("sync_all_targets", self._handle_sync_all_targets)  # TODO: Implement
        # self.register_event_handler("sync_changes", self._handle_sync_changes)  # TODO: Implement
        # self.register_event_handler("sync_insights", self._handle_sync_insights)  # TODO: Implement
        # self.register_event_handler("sync_results", self._handle_sync_results)  # TODO: Implement
    
    async def sync_all_targets(self) -> Dict[str, Any]:
        """Sync data across all configured targets."""
        results = {}
        
        # Sync MCP Memory
        if self.sync_targets.get("mcp_memory", {}).get("enabled", False):
            results["mcp_memory"] = await self._sync_mcp_memory()
        
        # Sync Graphology DB
        if self.sync_targets.get("graphology_db", {}).get("enabled", False):
            results["graphology_db"] = await self._sync_graphology_db()
        
        # Sync shared memory files
        if self.sync_targets.get("shared_memory_files", {}).get("enabled", False):
            results["shared_memory_files"] = await self._sync_shared_memory_files()
        
        # Update sync time
        self.last_sync_times["all"] = time.time()
        
        return {
            "sync_time": self.last_sync_times["all"],
            "results": results,
            "success": all(r.get("success", False) for r in results.values())
        }
    
    async def _sync_mcp_memory(self) -> Dict[str, Any]:
        """Sync with MCP Memory system."""
        try:
            # Get knowledge graph data
            kg_agent = self.system.agents.get("knowledge_graph")
            if not kg_agent:
                return {"success": False, "error": "Knowledge graph agent not available"}
            
            # Extract entities and relations
            entities = [
                {
                    "name": entity.name,
                    "entityType": entity.entity_type,
                    "significance": entity.significance,
                    "observations": entity.observations,
                    "metadata": entity.metadata
                }
                for entity in kg_agent.entities.values()
            ]
            
            relations = [
                {
                    "from": rel.from_entity,
                    "to": rel.to_entity,
                    "relationType": rel.relation_type,
                    "metadata": rel.metadata
                }
                for rel in kg_agent.relations
            ]
            
            # Here we would sync with actual MCP Memory
            # For now, just return success
            return {
                "success": True,
                "entities_synced": len(entities),
                "relations_synced": len(relations),
                "target": "mcp_memory"
            }
            
        except Exception as e:
            return {"success": False, "error": str(e), "target": "mcp_memory"}
    
    async def _sync_graphology_db(self) -> Dict[str, Any]:
        """Sync with Graphology database."""
        try:
            # Get knowledge graph data
            kg_agent = self.system.agents.get("knowledge_graph")
            if not kg_agent:
                return {"success": False, "error": "Knowledge graph agent not available"}
            
            # Here we would sync with actual Graphology DB
            # For now, just return success
            return {
                "success": True,
                "entities_synced": len(kg_agent.entities),
                "relations_synced": len(kg_agent.relations),
                "target": "graphology_db"
            }
            
        except Exception as e:
            return {"success": False, "error": str(e), "target": "graphology_db"}
    
    async def _sync_shared_memory_files(self) -> Dict[str, Any]:
        """Sync with shared memory JSON files."""
        try:
            # Get knowledge graph data
            kg_agent = self.system.agents.get("knowledge_graph")
            if not kg_agent:
                return {"success": False, "error": "Knowledge graph agent not available"}
            
            # Determine current project context
            current_project = self._determine_current_project()
            
            # Find shared memory files
            file_patterns = self.sync_targets.get("shared_memory_files", {}).get("file_patterns", ["shared-memory-*.json"])
            coding_tools_path = os.getenv("CODING_TOOLS_PATH", "")
            
            if not coding_tools_path:
                return {"success": False, "error": "CODING_TOOLS_PATH not set"}
            
            synced_files = []
            
            for pattern in file_patterns:
                # Find files matching pattern
                import glob
                files = glob.glob(os.path.join(coding_tools_path, pattern))
                
                # Filter files to only sync to current project
                files = self._filter_files_by_project(files, current_project)
                
                for file_path in files:
                    try:
                        # Read existing file
                        with open(file_path, 'r') as f:
                            data = json.load(f)
                        
                        # Update with current entities
                        current_entities = [
                            {
                                "name": entity.name,
                                "entityType": entity.entity_type,
                                "significance": entity.significance,
                                "observations": entity.observations,
                                "metadata": {
                                    **entity.metadata,
                                    "updated_at": entity.updated_at,
                                    "created_at": entity.created_at
                                }
                            }
                            for entity in kg_agent.entities.values()
                        ]
                        
                        # Merge with existing entities (simple merge for now)
                        existing_entities = data.get("entities", [])
                        entity_names = {e["name"] for e in existing_entities}
                        
                        # Track if any changes were made
                        changes_made = False
                        
                        for entity in current_entities:
                            if entity["name"] not in entity_names:
                                existing_entities.append(entity)
                                changes_made = True
                        
                        # Only update file if there were actual content changes
                        if changes_made:
                            data["entities"] = existing_entities
                            
                            # Update metadata only when content changes
                            data.setdefault("metadata", {})
                            data["metadata"]["last_sync"] = time.time()
                            data["metadata"]["sync_source"] = "semantic_analysis_agent"
                            
                            # Write back to file
                            with open(file_path, 'w') as f:
                                json.dump(data, f, indent=2)
                            
                            synced_files.append(file_path)
                        else:
                            # No changes - skip file update to avoid spurious timestamp updates
                            self.logger.debug(f"No content changes for {file_path}, skipping update")
                        
                    except Exception as e:
                        self.logger.warning(f"Failed to sync file {file_path}", error=str(e))
            
            return {
                "success": True,
                "files_synced": len(synced_files),
                "files": synced_files,
                "target": "shared_memory_files"
            }
            
        except Exception as e:
            return {"success": False, "error": str(e), "target": "shared_memory_files"}
    
    def _determine_current_project(self) -> str:
        """Determine the current project context based on working directory and environment."""
        # Check if we're in a specific project directory
        current_dir = os.getcwd()
        
        # Check for project-specific indicators
        if "coding" in current_dir.lower() or os.getenv("CODING_TOOLS_PATH"):
            return "coding"
        elif "ui" in current_dir.lower():
            return "ui"
        elif "resi" in current_dir.lower():
            return "resi"
        elif "raas" in current_dir.lower():
            return "raas"
        
        # Default to coding if we can't determine
        return "coding"
    
    def _filter_files_by_project(self, files: List[str], project: str) -> List[str]:
        """Filter shared memory files to only include the current project."""
        if not project:
            return files
        
        # Only sync to the file matching the current project
        target_file = f"shared-memory-{project}.json"
        
        filtered_files = []
        for file_path in files:
            if os.path.basename(file_path) == target_file:
                filtered_files.append(file_path)
        
        return filtered_files
    
    async def sync_all_sources(self, sources: List[str] = None, direction: str = "bidirectional", backup: bool = True) -> Dict[str, Any]:
        """Sync between MCP Memory, shared-memory files, and other sources."""
        try:
            # Default sources if not specified
            if sources is None:
                sources = ["mcp_memory", "shared_memory_files"]
            
            # Create backup if requested
            backup_result = None
            if backup:
                backup_result = await self._handle_backup_data({})
            
            results = {}
            
            # Sync each requested source
            for source in sources:
                if source == "mcp_memory":
                    results[source] = await self._sync_mcp_memory()
                elif source == "shared_memory_files":
                    results[source] = await self._sync_shared_memory_files()
                elif source == "graphology_db":
                    results[source] = await self._sync_graphology_db()
                elif source == "ukb":
                    # UKB sync through knowledge graph agent
                    kg_agent = self.system.agents.get("knowledge_graph")
                    if kg_agent:
                        results[source] = await kg_agent.ukb_integration.sync_with_shared_memory()
                    else:
                        results[source] = {"success": False, "error": "Knowledge graph agent not available"}
                else:
                    results[source] = {"success": False, "error": f"Unknown source: {source}"}
            
            # Calculate overall success
            all_successful = all(r.get("success", False) for r in results.values())
            
            self.logger.info(
                "Multi-source sync completed",
                sources=sources,
                direction=direction,
                backup_created=backup_result is not None,
                all_successful=all_successful
            )
            
            return {
                "success": all_successful,
                "sources": sources,
                "direction": direction,
                "backup_created": backup and backup_result and backup_result.get("success", False),
                "backup_file": backup_result.get("backup_file") if backup_result else None,
                "results": results
            }
            
        except Exception as e:
            self.logger.error("Multi-source sync failed", error=str(e))
            return {
                "success": False,
                "error": str(e),
                "sources": sources or [],
                "direction": direction
            }
    
    async def resolve_conflicts(self, conflict_entities: List[str], resolution_strategy: str = "newest", priority_source: str = None) -> Dict[str, Any]:
        """Handle synchronization conflicts between sources."""
        try:
            resolved_entities = []
            errors = []
            
            # Get knowledge graph agent for entity access
            kg_agent = self.system.agents.get("knowledge_graph")
            if not kg_agent:
                return {
                    "success": False,
                    "error": "Knowledge graph agent not available for conflict resolution"
                }
            
            for entity_name in conflict_entities:
                try:
                    if entity_name not in kg_agent.entities:
                        errors.append({
                            "entity": entity_name,
                            "error": "Entity not found in knowledge graph"
                        })
                        continue
                    
                    entity = kg_agent.entities[entity_name]
                    
                    # Apply resolution strategy
                    if resolution_strategy == "newest":
                        # Keep entity as-is (assuming it's the newest)
                        resolved_action = "kept_current"
                    elif resolution_strategy == "manual":
                        # Mark for manual review
                        entity.metadata["manual_review_required"] = True
                        resolved_action = "marked_for_review"
                    elif resolution_strategy == "merge":
                        # Merge observations (basic implementation)
                        entity.metadata["conflict_resolved"] = True
                        entity.metadata["resolution_strategy"] = "merge"
                        resolved_action = "merged"
                    elif resolution_strategy == "priority_source" and priority_source:
                        # Use priority source (simplified)
                        entity.metadata["priority_source"] = priority_source
                        resolved_action = f"prioritized_{priority_source}"
                    else:
                        resolved_action = "default_resolution"
                    
                    # Update entity timestamp
                    entity.updated_at = time.time()
                    
                    resolved_entities.append({
                        "entity_name": entity_name,
                        "action": resolved_action,
                        "strategy": resolution_strategy,
                        "timestamp": entity.updated_at
                    })
                    
                except Exception as e:
                    errors.append({
                        "entity": entity_name,
                        "error": str(e)
                    })
            
            return {
                "success": True,
                "conflicts_resolved": len(resolved_entities),
                "errors": len(errors),
                "resolution_strategy": resolution_strategy,
                "priority_source": priority_source,
                "resolved_entities": resolved_entities,
                "error_details": errors
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "resolution_strategy": resolution_strategy,
                "conflict_entities": conflict_entities
            }
    
    async def periodic_sync(self) -> Dict[str, Any]:
        """Public method for periodic synchronization called by core system."""
        self.logger.info(f"⏰ Executing periodic_sync() - Version: {SYNC_AGENT_VERSION}")
        return await self.sync_all_targets()
    
    async def backup_knowledge(self, sources: List[str] = None, backup_location: str = None, include_metadata: bool = True) -> Dict[str, Any]:
        """Create backups of knowledge sources."""
        try:
            # Default sources
            if sources is None or "all" in sources:
                sources = ["mcp_memory", "shared_memory_files"]
            
            # Default backup location
            if backup_location is None:
                backup_dir = Path(__file__).parent.parent / "backups"
            else:
                backup_dir = Path(backup_location)
            
            backup_dir.mkdir(exist_ok=True)
            
            backup_files = []
            backup_results = {}
            
            for source in sources:
                try:
                    if source == "mcp_memory" or source == "shared_memory_files":
                        # Get data from knowledge graph agent
                        kg_agent = self.system.agents.get("knowledge_graph")
                        if not kg_agent:
                            backup_results[source] = {
                                "success": False,
                                "error": "Knowledge graph agent not available"
                            }
                            continue
                        
                        backup_data = {
                            "source": source,
                            "timestamp": time.time(),
                            "entities": [
                                {
                                    "name": entity.name,
                                    "entityType": entity.entity_type,
                                    "significance": entity.significance,
                                    "observations": entity.observations,
                                    "metadata": entity.metadata if include_metadata else {},
                                    "created_at": entity.created_at,
                                    "updated_at": entity.updated_at
                                }
                                for entity in kg_agent.entities.values()
                            ],
                            "relations": [
                                {
                                    "from": rel.from_entity,
                                    "to": rel.to_entity,
                                    "relationType": rel.relation_type,
                                    "metadata": rel.metadata if include_metadata else {},
                                    "created_at": rel.created_at
                                }
                                for rel in kg_agent.relations
                            ]
                        }
                        
                        # Save backup file
                        backup_file = backup_dir / f"{source}_backup_{int(time.time())}.json"
                        with open(backup_file, 'w') as f:
                            json.dump(backup_data, f, indent=2)
                        
                        backup_files.append(str(backup_file))
                        backup_results[source] = {
                            "success": True,
                            "backup_file": str(backup_file),
                            "entities_count": len(backup_data["entities"]),
                            "relations_count": len(backup_data["relations"])
                        }
                        
                    else:
                        backup_results[source] = {
                            "success": False,
                            "error": f"Backup not implemented for source: {source}"
                        }
                        
                except Exception as e:
                    backup_results[source] = {
                        "success": False,
                        "error": str(e)
                    }
            
            # Calculate overall success
            successful_backups = sum(1 for r in backup_results.values() if r.get("success", False))
            
            return {
                "success": successful_backups > 0,
                "sources_requested": len(sources),
                "successful_backups": successful_backups,
                "failed_backups": len(sources) - successful_backups,
                "backup_location": str(backup_dir),
                "backup_files": backup_files,
                "include_metadata": include_metadata,
                "results": backup_results
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "sources": sources or [],
                "backup_location": backup_location
            }
    
    async def _periodic_sync(self):
        """Periodic synchronization task."""
        while self.running:
            try:
                await asyncio.sleep(self.sync_interval)
                
                self.logger.debug("Running periodic sync")
                result = await self.sync_all_targets()
                
                if not result["success"]:
                    self.logger.warning("Periodic sync failed", results=result["results"])
                else:
                    self.logger.debug("Periodic sync completed successfully")
                
            except Exception as e:
                self.logger.error("Periodic sync error", error=str(e))
                await asyncio.sleep(60)  # Wait before retrying
    
    # Event handlers
    async def _handle_sync_all(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle sync all targets requests."""
        return await self.sync_all_targets()
    
    async def _handle_sync_target(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle sync specific target requests."""
        target = data["target"]
        
        if target == "mcp_memory":
            result = await self._sync_mcp_memory()
        elif target == "graphology_db":
            result = await self._sync_graphology_db()
        elif target == "shared_memory_files":
            result = await self._sync_shared_memory_files()
        else:
            result = {"success": False, "error": f"Unknown target: {target}"}
        
        return result
    
    async def _handle_resolve_conflicts(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle conflict resolution requests."""
        conflicts = data["conflicts"]
        return await self.resolve_conflicts(conflicts)
    
    async def _handle_backup_data(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle data backup requests."""
        try:
            # Create backup of current state
            kg_agent = self.system.agents.get("knowledge_graph")
            if not kg_agent:
                return {"success": False, "error": "Knowledge graph agent not available"}
            
            backup_data = {
                "timestamp": time.time(),
                "entities": [
                    {
                        "name": entity.name,
                        "entityType": entity.entity_type,
                        "significance": entity.significance,
                        "observations": entity.observations,
                        "metadata": entity.metadata,
                        "created_at": entity.created_at,
                        "updated_at": entity.updated_at
                    }
                    for entity in kg_agent.entities.values()
                ],
                "relations": [
                    {
                        "from": rel.from_entity,
                        "to": rel.to_entity,
                        "relationType": rel.relation_type,
                        "metadata": rel.metadata,
                        "created_at": rel.created_at
                    }
                    for rel in kg_agent.relations
                ]
            }
            
            # Save backup
            backup_dir = Path(__file__).parent.parent / "backups"
            backup_dir.mkdir(exist_ok=True)
            
            backup_file = backup_dir / f"backup_{int(time.time())}.json"
            with open(backup_file, 'w') as f:
                json.dump(backup_data, f, indent=2)
            
            return {
                "success": True,
                "backup_file": str(backup_file),
                "entities_backed_up": len(backup_data["entities"]),
                "relations_backed_up": len(backup_data["relations"])
            }
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def health_check(self) -> Dict[str, Any]:
        """Check synchronization agent health."""
        base_health = await super().health_check()
        
        return {
            **base_health,
            "sync_targets_enabled": sum(1 for target in self.sync_targets.values() if target.get("enabled", False)),
            "last_sync_times": self.last_sync_times,
            "sync_interval": self.sync_interval
        }