"""
Deduplication Agent
Handles similarity detection and entity merging
"""

import asyncio
import numpy as np
from typing import Dict, Any, List, Tuple, Optional
import time

from .base import BaseAgent


class DeduplicationAgent(BaseAgent):
    """Agent for detecting and resolving duplicate entities."""
    
    def __init__(self, name: str, config: Dict[str, Any], system: Any):
        super().__init__(name, config, system)
        
        self.similarity_config = config.get("similarity_detection", {})
        self.merging_config = config.get("merging_strategy", {})
        self.similarity_threshold = self.similarity_config.get("similarity_threshold", 0.85)
        self.batch_size = self.similarity_config.get("batch_size", 100)
        
        self.embedding_model = None
        
        self.register_capability("similarity_detection")
        self.register_capability("entity_merging")
        self.register_capability("duplicate_resolution")
    
    async def on_initialize(self):
        """Initialize deduplication agent."""
        self.logger.info("Initializing deduplication agent...")
        
        # Initialize embedding model
        await self._initialize_embedding_model()
        
        self._register_event_handlers()
    
    async def _initialize_embedding_model(self):
        """Initialize the embedding model for similarity detection."""
        try:
            model_name = self.similarity_config.get("embedding_model", "sentence-transformers/all-MiniLM-L6-v2")
            
            # Import sentence-transformers
            from sentence_transformers import SentenceTransformer
            
            self.embedding_model = SentenceTransformer(model_name)
            self.logger.info(f"Initialized embedding model: {model_name}")
            
        except ImportError:
            self.logger.warning("sentence-transformers not available, using simple text similarity")
            self.embedding_model = None
        except Exception as e:
            self.logger.error(f"Failed to initialize embedding model: {e}")
            self.embedding_model = None
    
    def _register_event_handlers(self):
        """Register event handlers."""
        self.register_event_handler("detect_duplicates", self._handle_detect_duplicates)
        self.register_event_handler("merge_entities", self._handle_merge_entities)
        self.register_event_handler("calculate_similarity", self._handle_calculate_similarity)
        self.register_event_handler("resolve_duplicates", self._handle_resolve_duplicates)
    
    async def detect_duplicates(self, entity_types: List[str] = None, similarity_threshold: float = 0.85, comparison_method: str = "both") -> Dict[str, Any]:
        """Find similar/duplicate entities in the knowledge graph."""
        try:
            # Get entities from knowledge graph
            kg_agent = self.system.agents.get("knowledge_graph")
            if not kg_agent:
                return {"success": False, "error": "Knowledge graph agent not available"}
            
            # Filter entities by type if specified
            entities = []
            for entity in kg_agent.entities.values():
                if entity_types is None or entity.entity_type in entity_types:
                    entities.append({
                        "name": entity.name,
                        "type": entity.entity_type,
                        "observations": entity.observations,
                        "significance": entity.significance,
                        "metadata": entity.metadata
                    })
            
            if len(entities) < 2:
                return {
                    "success": True,
                    "duplicate_groups": [],
                    "total_entities": len(entities),
                    "message": "Not enough entities to compare"
                }
            
            # Override threshold if provided
            original_threshold = self.similarity_threshold
            self.similarity_threshold = similarity_threshold
            
            try:
                duplicates = []
                processed_entities = set()
                
                # Compare entities in batches
                for i, entity1 in enumerate(entities):
                    if entity1["name"] in processed_entities:
                        continue
                    
                    similar_group = [entity1]
                    
                    for j, entity2 in enumerate(entities[i+1:], i+1):
                        if entity2["name"] in processed_entities:
                            continue
                            
                        # Calculate similarity based on method
                        similarity = await self._calculate_similarity_by_method(entity1, entity2, comparison_method)
                        
                        if similarity >= similarity_threshold:
                            similar_group.append(entity2)
                            processed_entities.add(entity2["name"])
                    
                    # If we found similar entities, add to duplicates
                    if len(similar_group) > 1:
                        duplicates.append({
                            "primary_entity": similar_group[0],
                            "duplicate_entities": similar_group[1:],
                            "similarity_scores": [similarity_threshold] * (len(similar_group) - 1),  # Simplified
                            "group_size": len(similar_group)
                        })
                        
                        # Mark all as processed
                        for entity in similar_group:
                            processed_entities.add(entity["name"])
                
                return {
                    "success": True,
                    "duplicate_groups": duplicates,
                    "total_entities": len(entities),
                    "entities_with_duplicates": sum(group["group_size"] for group in duplicates),
                    "similarity_threshold": similarity_threshold,
                    "comparison_method": comparison_method,
                    "entity_types_filter": entity_types
                }
                
            finally:
                # Restore original threshold
                self.similarity_threshold = original_threshold
                
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "entity_types": entity_types,
                "similarity_threshold": similarity_threshold,
                "comparison_method": comparison_method
            }
    
    async def _calculate_similarity_by_method(self, entity1: Dict[str, Any], entity2: Dict[str, Any], method: str) -> float:
        """Calculate similarity using specified method."""
        if method == "semantic":
            return await self._semantic_similarity(
                self._entity_to_text(entity1),
                self._entity_to_text(entity2)
            )
        elif method == "text":
            return self._simple_text_similarity(
                self._entity_to_text(entity1),
                self._entity_to_text(entity2)
            )
        else:  # "both" - use average
            semantic_sim = await self._semantic_similarity(
                self._entity_to_text(entity1),
                self._entity_to_text(entity2)
            )
            text_sim = self._simple_text_similarity(
                self._entity_to_text(entity1),
                self._entity_to_text(entity2)
            )
            return (semantic_sim + text_sim) / 2.0
    
    async def merge_entities(self, entity_groups: List[Dict[str, Any]], preserve_history: bool = True) -> Dict[str, Any]:
        """Merge duplicate entities into single entities."""
        try:
            kg_agent = self.system.agents.get("knowledge_graph")
            if not kg_agent:
                return {"success": False, "error": "Knowledge graph agent not available"}
            
            merged_results = []
            total_merged = 0
            errors = []
            
            for group in entity_groups:
                try:
                    # Extract entities and target name from group
                    entities = group["entities"]
                    target_name = group["target_name"]
                    merge_strategy = group.get("merge_strategy", "combine")
                    
                    # Verify target exists and get secondary entities
                    if target_name not in kg_agent.entities:
                        errors.append({
                            "group": group,
                            "error": f"Target entity not found: {target_name}"
                        })
                        continue
                    
                    secondary_names = [name for name in entities if name != target_name]
                    
                    if not secondary_names:
                        continue  # Nothing to merge
                    
                    # Preserve history if requested
                    if preserve_history:
                        primary_entity = kg_agent.entities[target_name]
                        if "merge_history" not in primary_entity.metadata:
                            primary_entity.metadata["merge_history"] = []
                        
                        primary_entity.metadata["merge_history"].append({
                            "merged_entities": secondary_names,
                            "merge_strategy": merge_strategy,
                            "timestamp": time.time()
                        })
                    
                    # Perform the merge
                    merge_result = await kg_agent.merge_entities(target_name, secondary_names)
                    
                    if merge_result.get("merged_count", 0) > 0:
                        total_merged += merge_result["merged_count"]
                        merged_results.append({
                            "target_entity": target_name,
                            "merged_entities": secondary_names,
                            "merge_strategy": merge_strategy,
                            "merged_count": merge_result["merged_count"]
                        })
                    
                    if merge_result.get("errors"):
                        errors.extend([{"group": group, "error": err} for err in merge_result["errors"]])
                        
                except Exception as e:
                    errors.append({
                        "group": group,
                        "error": str(e)
                    })
            
            return {
                "success": len(errors) == 0,
                "groups_processed": len(entity_groups),
                "entities_merged": total_merged,
                "merge_results": merged_results,
                "preserve_history": preserve_history,
                "errors": errors
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "entity_groups": entity_groups,
                "preserve_history": preserve_history
            }
    
    async def deduplicate_insights(self, scope: str = "global", entity_filter: List[str] = None, type_filter: List[str] = None, similarity_threshold: float = 0.9) -> Dict[str, Any]:
        """Remove duplicate insights and observations."""
        try:
            kg_agent = self.system.agents.get("knowledge_graph")
            if not kg_agent:
                return {"success": False, "error": "Knowledge graph agent not available"}
            
            # Get entities based on scope and filters
            target_entities = []
            
            for entity in kg_agent.entities.values():
                # Apply filters based on scope
                if scope == "entity_specific" and entity_filter:
                    if entity.name not in entity_filter:
                        continue
                elif scope == "type_specific" and type_filter:
                    if entity.entity_type not in type_filter:
                        continue
                # For "global" scope, include all entities
                
                target_entities.append(entity)
            
            deduplicated_count = 0
            processed_entities = 0
            
            for entity in target_entities:
                if not entity.observations:
                    continue
                
                # Find duplicate observations within this entity
                unique_observations = []
                seen_observations = set()
                
                for obs in entity.observations:
                    # Simple deduplication based on text similarity
                    is_duplicate = False
                    
                    for existing_obs in unique_observations:
                        similarity = self._simple_text_similarity(obs, existing_obs)
                        if similarity >= similarity_threshold:
                            is_duplicate = True
                            deduplicated_count += 1
                            break
                    
                    if not is_duplicate:
                        unique_observations.append(obs)
                        seen_observations.add(obs.lower().strip())
                
                # Update entity observations if we removed duplicates
                if len(unique_observations) < len(entity.observations):
                    entity.observations = unique_observations
                    entity.updated_at = time.time()
                
                processed_entities += 1
            
            return {
                "success": True,
                "scope": scope,
                "entity_filter": entity_filter,
                "type_filter": type_filter,
                "similarity_threshold": similarity_threshold,
                "entities_processed": processed_entities,
                "duplicate_insights_removed": deduplicated_count,
                "target_entity_count": len(target_entities)
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "scope": scope,
                "entity_filter": entity_filter,
                "type_filter": type_filter
            }
    
    async def _find_duplicates_in_batch(self, batch: List[Dict[str, Any]], all_entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Find duplicates within a batch of entities."""
        duplicates = []
        
        for i, entity1 in enumerate(batch):
            similar_entities = []
            
            for j, entity2 in enumerate(all_entities):
                if entity1["name"] == entity2["name"]:
                    continue  # Skip self-comparison
                
                similarity = await self._calculate_similarity(entity1, entity2)
                
                if similarity >= self.similarity_threshold:
                    similar_entities.append({
                        "entity": entity2,
                        "similarity": similarity
                    })
            
            if similar_entities:
                duplicates.append({
                    "primary_entity": entity1,
                    "similar_entities": similar_entities,
                    "group_size": len(similar_entities) + 1
                })
        
        return duplicates
    
    async def _calculate_similarity(self, entity1: Dict[str, Any], entity2: Dict[str, Any]) -> float:
        """Calculate similarity between two entities."""
        # Combine text from name and observations
        text1 = self._entity_to_text(entity1)
        text2 = self._entity_to_text(entity2)
        
        if self.embedding_model:
            return await self._semantic_similarity(text1, text2)
        else:
            return self._simple_text_similarity(text1, text2)
    
    def _entity_to_text(self, entity: Dict[str, Any]) -> str:
        """Convert entity to text representation."""
        text_parts = [entity["name"]]
        
        if entity.get("observations"):
            text_parts.extend(entity["observations"][:3])  # Limit to first 3 observations
        
        return " ".join(text_parts)
    
    async def _semantic_similarity(self, text1: str, text2: str) -> float:
        """Calculate semantic similarity using embeddings."""
        try:
            # Generate embeddings
            embeddings = await asyncio.to_thread(
                self.embedding_model.encode,
                [text1, text2]
            )
            
            # Calculate cosine similarity
            from sklearn.metrics.pairwise import cosine_similarity
            similarity = cosine_similarity([embeddings[0]], [embeddings[1]])[0][0]
            
            return float(similarity)
            
        except Exception as e:
            self.logger.warning(f"Semantic similarity calculation failed: {e}")
            return self._simple_text_similarity(text1, text2)
    
    def _simple_text_similarity(self, text1: str, text2: str) -> float:
        """Calculate simple text similarity using character overlap."""
        # Normalize texts
        text1 = text1.lower().strip()
        text2 = text2.lower().strip()
        
        if not text1 or not text2:
            return 0.0
        
        # Calculate Jaccard similarity on words
        words1 = set(text1.split())
        words2 = set(text2.split())
        
        intersection = len(words1.intersection(words2))
        union = len(words1.union(words2))
        
        return intersection / union if union > 0 else 0.0
    
    async def merge_similar_entities(self, duplicate_groups: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Merge similar entities based on deduplication strategy."""
        kg_agent = self.system.agents.get("knowledge_graph")
        if not kg_agent:
            return {"success": False, "error": "Knowledge graph agent not available"}
        
        merged_count = 0
        errors = []
        
        for group in duplicate_groups:
            try:
                primary_entity = group["primary_entity"]
                similar_entities = group["similar_entities"]
                
                # Collect entity names to merge
                entity_names_to_merge = [e["entity"]["name"] for e in similar_entities]
                
                # Perform merge using knowledge graph agent
                result = await kg_agent.merge_entities(
                    primary_name=primary_entity["name"],
                    secondary_names=entity_names_to_merge
                )
                
                if result.get("merged_count", 0) > 0:
                    merged_count += result["merged_count"]
                
                if result.get("errors"):
                    errors.extend(result["errors"])
                
            except Exception as e:
                errors.append(f"Failed to merge group with primary {group['primary_entity']['name']}: {str(e)}")
        
        return {
            "success": len(errors) == 0,
            "merged_count": merged_count,
            "errors": errors,
            "groups_processed": len(duplicate_groups)
        }
    
    async def resolve_all_duplicates(self) -> Dict[str, Any]:
        """Detect and resolve all duplicates in one operation."""
        # First, detect duplicates
        detection_result = await self.detect_duplicates()
        
        if not detection_result["success"]:
            return detection_result
        
        duplicate_groups = detection_result["duplicates"]
        
        if not duplicate_groups:
            return {
                "success": True,
                "message": "No duplicates found",
                "duplicates_detected": 0,
                "entities_merged": 0
            }
        
        # Then, merge duplicates
        merge_result = await self.merge_similar_entities(duplicate_groups)
        
        return {
            "success": merge_result["success"],
            "duplicates_detected": len(duplicate_groups),
            "entities_merged": merge_result["merged_count"],
            "errors": merge_result.get("errors", []),
            "groups_processed": merge_result["groups_processed"]
        }
    
    # Event handlers
    async def _handle_detect_duplicates(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle duplicate detection requests."""
        entities = data.get("entities")
        return await self.detect_duplicates(entities)
    
    async def _handle_merge_entities(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle entity merging requests."""
        duplicate_groups = data["duplicate_groups"]
        return await self.merge_similar_entities(duplicate_groups)
    
    async def _handle_calculate_similarity(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle similarity calculation requests."""
        entity1 = data["entity1"]
        entity2 = data["entity2"]
        
        similarity = await self._calculate_similarity(entity1, entity2)
        
        return {
            "similarity": similarity,
            "entity1": entity1["name"],
            "entity2": entity2["name"],
            "threshold": self.similarity_threshold,
            "is_duplicate": similarity >= self.similarity_threshold
        }
    
    async def _handle_resolve_duplicates(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle complete duplicate resolution requests."""
        return await self.resolve_all_duplicates()
    
    async def health_check(self) -> Dict[str, Any]:
        """Check deduplication agent health."""
        base_health = await super().health_check()
        
        return {
            **base_health,
            "embedding_model_available": self.embedding_model is not None,
            "similarity_threshold": self.similarity_threshold,
            "batch_size": self.batch_size
        }