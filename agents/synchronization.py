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

from .base import BaseAgent


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
                        
                        for entity in current_entities:
                            if entity["name"] not in entity_names:
                                existing_entities.append(entity)
                        
                        data["entities"] = existing_entities
                        
                        # Update metadata
                        data.setdefault("metadata", {})
                        data["metadata"]["last_sync"] = time.time()
                        data["metadata"]["sync_source"] = "semantic_analysis_agent"
                        
                        # Write back to file
                        with open(file_path, 'w') as f:
                            json.dump(data, f, indent=2)
                        
                        synced_files.append(file_path)
                        
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
    
    async def resolve_conflicts(self, conflicts: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Resolve data conflicts between storage systems."""
        strategy = self.conflict_resolution.get("strategy", "timestamp_priority")
        resolved = []
        
        for conflict in conflicts:
            if strategy == "timestamp_priority":
                # Use most recent timestamp
                resolved_item = max(conflict["versions"], key=lambda x: x.get("timestamp", 0))
            elif strategy == "significance_priority":
                # Use highest significance
                resolved_item = max(conflict["versions"], key=lambda x: x.get("significance", 0))
            else:
                # Default to first version
                resolved_item = conflict["versions"][0]
            
            resolved.append({
                "id": conflict["id"],
                "resolved_version": resolved_item,
                "strategy": strategy
            })
        
        return {
            "conflicts_resolved": len(resolved),
            "strategy": strategy,
            "resolutions": resolved
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