"""
Knowledge Graph Agent
Manages entities, relationships, and integrates with UKB system
"""

import asyncio
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, Any, Optional, List, Set
from dataclasses import dataclass, field
import time

from .base import BaseAgent


@dataclass
class Entity:
    """Represents a knowledge graph entity."""
    name: str
    entity_type: str
    significance: int = 5
    observations: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


@dataclass
class Relation:
    """Represents a relationship between entities."""
    from_entity: str
    to_entity: str
    relation_type: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)


class UKBIntegration:
    """Integration with the UKB (Universal Knowledge Base) system."""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.ukb_path = config.get("ukb_path", "ukb")
        self.shared_memory_path = config.get("shared_memory_path")
        self.auto_sync = config.get("auto_sync", True)
        self.batch_size = config.get("batch_size", 10)
        
    async def add_entity(self, entity: Entity) -> Dict[str, Any]:
        """Add an entity to the UKB system."""
        entity_data = {
            "name": entity.name,
            "entityType": entity.entity_type,
            "significance": entity.significance,
            "observations": entity.observations,
            "metadata": entity.metadata
        }
        
        try:
            # Create temporary file for entity data
            with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
                json.dump(entity_data, f, indent=2)
                temp_file = f.name
            
            try:
                # Execute UKB command
                cmd = [self.ukb_path, "--add-entity", "--file", temp_file]
                result = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                
                stdout, stderr = await result.communicate()
                
                if result.returncode == 0:
                    return {
                        "success": True,
                        "entity": entity_data,
                        "ukb_output": stdout.decode() if stdout else ""
                    }
                else:
                    return {
                        "success": False,
                        "error": stderr.decode() if stderr else "Unknown UKB error",
                        "entity": entity_data
                    }
                    
            finally:
                # Clean up temp file
                try:
                    os.unlink(temp_file)
                except:
                    pass
                    
        except Exception as e:
            return {
                "success": False,
                "error": f"UKB integration failed: {str(e)}",
                "entity": entity_data
            }
    
    async def batch_add_entities(self, entities: List[Entity]) -> Dict[str, Any]:
        """Add multiple entities to UKB in batches."""
        results = []
        
        # Process in batches
        for i in range(0, len(entities), self.batch_size):
            batch = entities[i:i + self.batch_size]
            
            # Process batch
            batch_results = []
            for entity in batch:
                result = await self.add_entity(entity)
                batch_results.append(result)
            
            results.extend(batch_results)
            
            # Brief pause between batches
            if i + self.batch_size < len(entities):
                await asyncio.sleep(0.1)
        
        # Calculate summary
        successful = sum(1 for r in results if r.get("success", False))
        failed = len(results) - successful
        
        return {
            "total_entities": len(entities),
            "successful": successful,
            "failed": failed,
            "results": results
        }
    
    async def search_entities(self, query: str, limit: int = 10) -> Dict[str, Any]:
        """Search for entities in the UKB system."""
        try:
            cmd = [self.ukb_path, "--search", query, "--limit", str(limit)]
            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await result.communicate()
            
            if result.returncode == 0:
                # Parse UKB output
                output = stdout.decode() if stdout else ""
                entities = self._parse_ukb_search_output(output)
                
                return {
                    "success": True,
                    "query": query,
                    "entities": entities,
                    "count": len(entities)
                }
            else:
                return {
                    "success": False,
                    "error": stderr.decode() if stderr else "Search failed",
                    "query": query
                }
                
        except Exception as e:
            return {
                "success": False,
                "error": f"UKB search failed: {str(e)}",
                "query": query
            }
    
    def _parse_ukb_search_output(self, output: str) -> List[Dict[str, Any]]:
        """Parse UKB search output into entity structures."""
        entities = []
        
        try:
            # Try to parse as JSON first
            data = json.loads(output)
            if isinstance(data, list):
                entities = data
            elif isinstance(data, dict) and "entities" in data:
                entities = data["entities"]
        except json.JSONDecodeError:
            # Parse text output
            lines = output.strip().split('\n')
            for line in lines:
                if line.strip():
                    # Simple parsing - could be enhanced
                    parts = line.split('\t')
                    if len(parts) >= 2:
                        entities.append({
                            "name": parts[0],
                            "type": parts[1] if len(parts) > 1 else "Unknown",
                            "significance": int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 5
                        })
        
        return entities
    
    async def sync_with_shared_memory(self) -> Dict[str, Any]:
        """Synchronize with shared memory files."""
        if not self.shared_memory_path or not os.path.exists(self.shared_memory_path):
            return {"success": False, "error": "Shared memory path not available"}
        
        try:
            # Read current shared memory
            with open(self.shared_memory_path, 'r') as f:
                shared_data = json.load(f)
            
            # Extract entities and relations
            entities = shared_data.get("entities", [])
            relations = shared_data.get("relations", [])
            
            return {
                "success": True,
                "entities_count": len(entities),
                "relations_count": len(relations),
                "shared_memory_path": self.shared_memory_path
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"Shared memory sync failed: {str(e)}"
            }


class KnowledgeGraphAgent(BaseAgent):
    """
    Knowledge graph agent that manages entities, relationships, and UKB integration.
    """
    
    def __init__(self, name: str, config: Dict[str, Any], system: Any):
        super().__init__(name, config, system)
        
        self.entities: Dict[str, Entity] = {}
        self.relations: List[Relation] = []
        self.ukb_integration = UKBIntegration(config.get("ukb_integration", {}))
        self.entity_processor_config = config.get("entity_processing", {})
        
        # Register capabilities
        self.register_capability("entity_management")
        self.register_capability("relationship_management")
        self.register_capability("ukb_integration")
        self.register_capability("knowledge_search")
        self.register_capability("entity_merging")
    
    async def on_initialize(self):
        """Initialize the knowledge graph agent."""
        self.logger.info("Initializing knowledge graph agent...")
        
        # Register event handlers
        self._register_event_handlers()
        
        # Load existing entities if available
        await self._load_existing_entities()
        
        # Start periodic sync if enabled
        if self.ukb_integration.auto_sync:
            asyncio.create_task(self._periodic_sync())
        
        self.logger.info(
            "Knowledge graph agent initialized",
            entities_loaded=len(self.entities),
            ukb_enabled=bool(self.ukb_integration.ukb_path)
        )
    
    def _register_event_handlers(self):
        """Register event handlers for knowledge graph operations."""
        self.register_event_handler("create_entity", self._handle_create_entity)
        self.register_event_handler("create_entities", self._handle_create_entities)
        self.register_event_handler("create_relation", self._handle_create_relation)
        self.register_event_handler("search_entities", self._handle_search_entities)
        self.register_event_handler("merge_entities", self._handle_merge_entities)
        self.register_event_handler("sync_with_ukb", self._handle_sync_with_ukb)
        self.register_event_handler("get_entity", self._handle_get_entity)
        self.register_event_handler("update_entity", self._handle_update_entity)
    
    async def create_entity(self, name: str, entity_type: str, significance: int = 5, 
                          observations: List[str] = None, metadata: Dict[str, Any] = None) -> Entity:
        """Create a new entity in the knowledge graph."""
        observations = observations or []
        metadata = metadata or {}
        
        # Check for duplicates
        if name in self.entities:
            existing = self.entities[name]
            self.logger.info(f"Entity already exists: {name}, updating instead")
            return await self.update_entity(name, observations=observations, metadata=metadata)
        
        # Create new entity
        entity = Entity(
            name=name,
            entity_type=entity_type,
            significance=significance,
            observations=observations,
            metadata=metadata
        )
        
        self.entities[name] = entity
        
        self.logger.info(
            "Created entity",
            name=name,
            type=entity_type,
            significance=significance,
            observations_count=len(observations)
        )
        
        # Sync with UKB if enabled
        if self.ukb_integration.auto_sync:
            asyncio.create_task(self._sync_entity_to_ukb(entity))
        
        return entity
    
    async def create_entities(self, entities_data: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Create multiple entities."""
        created_entities = []
        errors = []
        
        for entity_data in entities_data:
            try:
                entity = await self.create_entity(
                    name=entity_data["name"],
                    entity_type=entity_data["entity_type"],
                    significance=entity_data.get("significance", 5),
                    observations=entity_data.get("observations", []),
                    metadata=entity_data.get("metadata", {})
                )
                created_entities.append(entity)
                
            except Exception as e:
                errors.append({
                    "entity_name": entity_data.get("name", "unknown"),
                    "error": str(e)
                })
        
        # Batch sync with UKB
        if created_entities and self.ukb_integration.auto_sync:
            asyncio.create_task(self._batch_sync_entities_to_ukb(created_entities))
        
        return {
            "created": len(created_entities),
            "errors": len(errors),
            "entities": [e.name for e in created_entities],
            "error_details": errors
        }
    
    async def update_entity(self, name: str, observations: List[str] = None, 
                          metadata: Dict[str, Any] = None, significance: int = None) -> Entity:
        """Update an existing entity."""
        if name not in self.entities:
            raise ValueError(f"Entity not found: {name}")
        
        entity = self.entities[name]
        entity.updated_at = time.time()
        
        if observations:
            entity.observations.extend(observations)
        
        if metadata:
            entity.metadata.update(metadata)
        
        if significance is not None:
            entity.significance = significance
        
        self.logger.info(f"Updated entity: {name}")
        
        # Sync with UKB if enabled
        if self.ukb_integration.auto_sync:
            asyncio.create_task(self._sync_entity_to_ukb(entity))
        
        return entity
    
    async def create_relation(self, from_entity: str, to_entity: str, relation_type: str, 
                            metadata: Dict[str, Any] = None) -> Relation:
        """Create a relationship between entities."""
        metadata = metadata or {}
        
        # Verify entities exist
        if from_entity not in self.entities:
            raise ValueError(f"From entity not found: {from_entity}")
        if to_entity not in self.entities:
            raise ValueError(f"To entity not found: {to_entity}")
        
        relation = Relation(
            from_entity=from_entity,
            to_entity=to_entity,
            relation_type=relation_type,
            metadata=metadata
        )
        
        self.relations.append(relation)
        
        self.logger.info(
            "Created relation",
            from_entity=from_entity,
            to_entity=to_entity,
            relation_type=relation_type
        )
        
        return relation
    
    async def search_entities(self, query: str, entity_type: str = None, limit: int = 10) -> Dict[str, Any]:
        """Search for entities in the knowledge graph."""
        # Local search
        matching_entities = []
        query_lower = query.lower()
        
        for entity in self.entities.values():
            # Apply entity type filter if specified
            if entity_type and entity.entity_type != entity_type:
                continue
                
            # Search in name, type, and observations
            if (query_lower in entity.name.lower() or 
                query_lower in entity.entity_type.lower() or
                any(query_lower in obs.lower() for obs in entity.observations)):
                
                matching_entities.append({
                    "name": entity.name,
                    "type": entity.entity_type,
                    "significance": entity.significance,
                    "observations_count": len(entity.observations),
                    "created_at": entity.created_at,
                    "updated_at": entity.updated_at
                })
        
        # Apply limit
        matching_entities = matching_entities[:limit]
        
        return {
            "success": True,
            "query": query,
            "entity_type": entity_type,
            "entities": matching_entities,
            "count": len(matching_entities)
        }
    
    async def update_knowledge_graph(self, entities: List[Dict[str, Any]] = None, relations: List[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Update the knowledge graph with new entities and relations."""
        results = {
            "entities_created": 0,
            "entities_updated": 0,
            "relations_created": 0,
            "errors": []
        }
        
        # Process entities
        if entities:
            for entity_data in entities:
                try:
                    name = entity_data["name"]
                    entity_type = entity_data["entity_type"]
                    significance = entity_data.get("significance", 5)
                    observations = entity_data.get("observations", [])
                    metadata = entity_data.get("metadata", {})
                    
                    if name in self.entities:
                        # Update existing entity
                        await self.update_entity(name, observations=observations, metadata=metadata, significance=significance)
                        results["entities_updated"] += 1
                    else:
                        # Create new entity
                        await self.create_entity(name, entity_type, significance, observations, metadata)
                        results["entities_created"] += 1
                        
                except Exception as e:
                    results["errors"].append({
                        "type": "entity",
                        "data": entity_data,
                        "error": str(e)
                    })
        
        # Process relations
        if relations:
            for relation_data in relations:
                try:
                    from_entity = relation_data["from_entity"]
                    to_entity = relation_data["to_entity"]
                    relation_type = relation_data["relation_type"]
                    metadata = relation_data.get("metadata", {})
                    
                    await self.create_relation(from_entity, to_entity, relation_type, metadata)
                    results["relations_created"] += 1
                    
                except Exception as e:
                    results["errors"].append({
                        "type": "relation",
                        "data": relation_data,
                        "error": str(e)
                    })
        
        self.logger.info(
            "Knowledge graph updated",
            entities_created=results["entities_created"],
            entities_updated=results["entities_updated"],
            relations_created=results["relations_created"],
            errors=len(results["errors"])
        )
        
        return {
            "success": True,
            **results
        }
    
    async def sync_knowledge_sources(self, source_files: List[str] = None, direction: str = "bidirectional") -> Dict[str, Any]:
        """Sync knowledge graph with external sources."""
        try:
            # Use UKB integration for syncing
            result = await self.ukb_integration.sync_with_shared_memory()
            
            if result.get("success"):
                self.logger.info(
                    "Knowledge sources synced",
                    direction=direction,
                    source_files=source_files,
                    entities_synced=result.get("entities_count", 0)
                )
                
                return {
                    "success": True,
                    "direction": direction,
                    "source_files": source_files or ["shared-memory"],
                    "entities_synced": result.get("entities_count", 0),
                    "relations_synced": result.get("relations_count", 0)
                }
            else:
                return {
                    "success": False,
                    "error": result.get("error", "Sync failed"),
                    "direction": direction
                }
                
        except Exception as e:
            self.logger.error("Knowledge source sync failed", error=str(e))
            return {
                "success": False,
                "error": str(e),
                "direction": direction
            }
    
    async def get_entity_relations(self, entity_names: List[str], relation_types: List[str] = None, depth: int = 1) -> Dict[str, Any]:
        """Get relationships for specific entities."""
        entity_relations = {}
        
        for entity_name in entity_names:
            if entity_name not in self.entities:
                entity_relations[entity_name] = {
                    "error": f"Entity not found: {entity_name}"
                }
                continue
            
            # Find direct relations
            outgoing_relations = []
            incoming_relations = []
            
            for relation in self.relations:
                # Apply relation type filter if specified
                if relation_types and relation.relation_type not in relation_types:
                    continue
                    
                if relation.from_entity == entity_name:
                    outgoing_relations.append({
                        "to_entity": relation.to_entity,
                        "relation_type": relation.relation_type,
                        "metadata": relation.metadata,
                        "created_at": relation.created_at
                    })
                    
                if relation.to_entity == entity_name:
                    incoming_relations.append({
                        "from_entity": relation.from_entity,
                        "relation_type": relation.relation_type,
                        "metadata": relation.metadata,
                        "created_at": relation.created_at
                    })
            
            entity_relations[entity_name] = {
                "entity": {
                    "name": entity_name,
                    "type": self.entities[entity_name].entity_type,
                    "significance": self.entities[entity_name].significance
                },
                "outgoing_relations": outgoing_relations,
                "incoming_relations": incoming_relations,
                "total_relations": len(outgoing_relations) + len(incoming_relations)
            }
            
            # TODO: Implement multi-level depth traversal if depth > 1
            if depth > 1:
                self.logger.warning(f"Multi-level relation traversal not yet implemented (depth={depth})")
        
        return {
            "success": True,
            "entity_relations": entity_relations,
            "entities_processed": len(entity_names),
            "depth": depth,
            "relation_types_filter": relation_types
        }
    
    async def merge_entities(self, primary_name: str, secondary_names: List[str]) -> Dict[str, Any]:
        """Merge multiple entities into a primary entity."""
        if primary_name not in self.entities:
            raise ValueError(f"Primary entity not found: {primary_name}")
        
        primary_entity = self.entities[primary_name]
        merged_count = 0
        errors = []
        
        for secondary_name in secondary_names:
            if secondary_name not in self.entities:
                errors.append(f"Entity not found: {secondary_name}")
                continue
            
            secondary_entity = self.entities[secondary_name]
            
            # Merge observations
            primary_entity.observations.extend(secondary_entity.observations)
            
            # Merge metadata
            primary_entity.metadata.update(secondary_entity.metadata)
            
            # Update significance (use maximum)
            primary_entity.significance = max(primary_entity.significance, secondary_entity.significance)
            
            # Update relations to point to primary entity
            for relation in self.relations:
                if relation.from_entity == secondary_name:
                    relation.from_entity = primary_name
                if relation.to_entity == secondary_name:
                    relation.to_entity = primary_name
            
            # Remove secondary entity
            del self.entities[secondary_name]
            merged_count += 1
        
        primary_entity.updated_at = time.time()
        
        self.logger.info(
            "Merged entities",
            primary=primary_name,
            merged_count=merged_count,
            errors=len(errors)
        )
        
        # Sync with UKB if enabled
        if self.ukb_integration.auto_sync:
            asyncio.create_task(self._sync_entity_to_ukb(primary_entity))
        
        return {
            "primary_entity": primary_name,
            "merged_count": merged_count,
            "errors": errors,
            "new_significance": primary_entity.significance,
            "total_observations": len(primary_entity.observations)
        }
    
    async def _sync_entity_to_ukb(self, entity: Entity):
        """Sync a single entity to UKB."""
        try:
            result = await self.ukb_integration.add_entity(entity)
            
            if result.get("success"):
                self.logger.debug(f"Synced entity to UKB: {entity.name}")
            else:
                self.logger.warning(f"Failed to sync entity to UKB: {entity.name}", error=result.get("error"))
                
        except Exception as e:
            self.logger.error(f"Error syncing entity to UKB: {entity.name}", error=str(e))
    
    async def _batch_sync_entities_to_ukb(self, entities: List[Entity]):
        """Sync multiple entities to UKB in batches."""
        try:
            result = await self.ukb_integration.batch_add_entities(entities)
            
            self.logger.info(
                "Batch synced entities to UKB",
                total=result["total_entities"],
                successful=result["successful"],
                failed=result["failed"]
            )
            
        except Exception as e:
            self.logger.error("Error batch syncing entities to UKB", error=str(e))
    
    async def _load_existing_entities(self):
        """Load existing entities from shared memory or other sources."""
        try:
            result = await self.ukb_integration.sync_with_shared_memory()
            if result.get("success"):
                self.logger.info(
                    "Loaded entities from shared memory",
                    entities=result.get("entities_count", 0),
                    relations=result.get("relations_count", 0)
                )
            
        except Exception as e:
            self.logger.warning("Failed to load existing entities", error=str(e))
    
    async def _periodic_sync(self):
        """Periodic synchronization with UKB and shared memory."""
        while self.running:
            try:
                # Sync with shared memory
                await self.ukb_integration.sync_with_shared_memory()
                
                # Wait for next sync
                await asyncio.sleep(300)  # 5 minutes
                
            except Exception as e:
                self.logger.error("Periodic sync error", error=str(e))
                await asyncio.sleep(60)  # Retry after 1 minute
    
    # Event handlers
    async def _handle_create_entity(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle entity creation requests."""
        entity = await self.create_entity(
            name=data["name"],
            entity_type=data["entity_type"],
            significance=data.get("significance", 5),
            observations=data.get("observations", []),
            metadata=data.get("metadata", {})
        )
        
        return {
            "entity": {
                "name": entity.name,
                "type": entity.entity_type,
                "significance": entity.significance,
                "observations_count": len(entity.observations),
                "created_at": entity.created_at
            }
        }
    
    async def _handle_create_entities(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle multiple entity creation requests."""
        entities_data = data.get("entities", [])
        return await self.create_entities(entities_data)
    
    async def _handle_create_relation(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle relation creation requests."""
        relation = await self.create_relation(
            from_entity=data["from_entity"],
            to_entity=data["to_entity"],
            relation_type=data["relation_type"],
            metadata=data.get("metadata", {})
        )
        
        return {
            "relation": {
                "from_entity": relation.from_entity,
                "to_entity": relation.to_entity,
                "relation_type": relation.relation_type,
                "created_at": relation.created_at
            }
        }
    
    async def _handle_search_entities(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle entity search requests."""
        query = data["query"]
        search_type = data.get("search_type", "local")
        
        return await self.search_entities(query, search_type)
    
    async def _handle_merge_entities(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle entity merging requests."""
        primary_name = data["primary_name"]
        secondary_names = data["secondary_names"]
        
        return await self.merge_entities(primary_name, secondary_names)
    
    async def _handle_sync_with_ukb(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle UKB synchronization requests."""
        # Sync all entities
        entities = list(self.entities.values())
        result = await self.ukb_integration.batch_add_entities(entities)
        
        return result
    
    async def _handle_get_entity(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle entity retrieval requests."""
        name = data["name"]
        
        if name not in self.entities:
            raise ValueError(f"Entity not found: {name}")
        
        entity = self.entities[name]
        
        return {
            "entity": {
                "name": entity.name,
                "type": entity.entity_type,
                "significance": entity.significance,
                "observations": entity.observations,
                "metadata": entity.metadata,
                "created_at": entity.created_at,
                "updated_at": entity.updated_at
            }
        }
    
    async def _handle_update_entity(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle entity update requests."""
        entity = await self.update_entity(
            name=data["name"],
            observations=data.get("observations"),
            metadata=data.get("metadata"),
            significance=data.get("significance")
        )
        
        return {
            "entity": {
                "name": entity.name,
                "type": entity.entity_type,
                "significance": entity.significance,
                "observations_count": len(entity.observations),
                "updated_at": entity.updated_at
            }
        }
    
    async def health_check(self) -> Dict[str, Any]:
        """Check knowledge graph agent health."""
        base_health = await super().health_check()
        
        # Check UKB connectivity
        ukb_health = False
        try:
            result = await self.ukb_integration.search_entities("test", limit=1)
            ukb_health = result.get("success", False)
        except:
            pass
        
        return {
            **base_health,
            "entities_count": len(self.entities),
            "relations_count": len(self.relations),
            "ukb_integration": ukb_health,
            "auto_sync_enabled": self.ukb_integration.auto_sync
        }
    
    async def on_shutdown(self):
        """Cleanup on shutdown."""
        # Final sync if enabled
        if self.ukb_integration.auto_sync and self.entities:
            try:
                entities = list(self.entities.values())
                await self.ukb_integration.batch_add_entities(entities)
                self.logger.info("Final sync to UKB completed")
            except Exception as e:
                self.logger.error("Failed final sync to UKB", error=str(e))
        
        # Clear state
        self.entities.clear()
        self.relations.clear()