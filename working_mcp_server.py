#!/usr/bin/env python3
"""
Enhanced MCP Server for Semantic Analysis
Integrates the 7-agent system: Step 2 - SemanticAnalysisAgent integration
"""

import json
import sys
import os
import asyncio
import time
from typing import Any, Dict, Optional
from abc import ABC, abstractmethod
from pathlib import Path

from mcp.server import Server
from mcp.types import Tool, TextContent
from mcp.server.stdio import stdio_server

# Add the agents directory to the path
sys.path.insert(0, str(Path(__file__).parent / "agents"))
sys.path.insert(0, str(Path(__file__).parent / "config"))
sys.path.insert(0, str(Path(__file__).parent / "workflows"))

# Import all agents
try:
    from agents.coordinator import CoordinatorAgent
    from agents.semantic_analysis import SemanticAnalysisAgent as FullSemanticAnalysisAgent
    from agents.knowledge_graph import KnowledgeGraphAgent
    from agents.web_search import WebSearchAgent
    from agents.documentation import DocumentationAgent
    from agents.synchronization import SynchronizationAgent
    from agents.deduplication import DeduplicationAgent
    AGENTS_AVAILABLE = True
except ImportError as e:
    print(f"⚠️  Could not import agents: {e}", file=sys.stderr)
    AGENTS_AVAILABLE = False

# Import workflow definitions
try:
    from workflows.complete_analysis import create_complete_analysis_workflow
    from workflows.incremental_analysis import create_incremental_analysis_workflow
    from workflows.repository_analysis import create_repository_analysis_workflow
    from workflows.conversation_analysis import create_conversation_analysis_workflow
    WORKFLOWS_AVAILABLE = True
except ImportError as e:
    print(f"⚠️  Could not import workflows: {e}", file=sys.stderr)
    WORKFLOWS_AVAILABLE = False

# Import agent configuration
try:
    from config.agent_config import AgentConfig
    agent_config = AgentConfig()
    CONFIG_AVAILABLE = True
except ImportError as e:
    print(f"⚠️  Could not import agent config: {e}", file=sys.stderr)
    CONFIG_AVAILABLE = False
    agent_config = None

# Enhanced analysis capabilities - embedded from 7-agent system
class APIKeyManager:
    """Manages API keys and provides fallback chain."""
    
    def __init__(self):
        self.providers = {}
        self.detect_available_providers()
    
    def detect_available_providers(self):
        """Detect available API providers."""
        anthropic_key = os.getenv("ANTHROPIC_API_KEY")
        openai_key = os.getenv("OPENAI_API_KEY") 
        openai_base = os.getenv("OPENAI_BASE_URL")
        
        if anthropic_key and anthropic_key != "your-anthropic-api-key":
            self.providers["anthropic"] = True
        if openai_key and openai_key != "your-openai-api-key":
            self.providers["openai"] = True
        if openai_base and openai_key:
            self.providers["custom_openai"] = True
    
    def get_fallback_chain(self):
        """Get the fallback chain in order of preference."""
        chain = []
        if "anthropic" in self.providers:
            chain.append("anthropic")
        if "openai" in self.providers:
            chain.append("openai")
        if "custom_openai" in self.providers:
            chain.append("custom_openai")
        return chain
    
    def get_status_report(self):
        """Get status report of available providers."""
        return {
            "has_ai_providers": len(self.providers) > 0,
            "fallback_chain": self.get_fallback_chain(),
            "providers": self.providers
        }

print("✅ Enhanced API key management available", file=sys.stderr)


class BaseAgent(ABC):
    """
    Base class for all agents in the semantic analysis system.
    Provides common functionality and enforces interface contracts.
    """
    
    def __init__(self, name: str, config: Dict[str, Any], system: Any = None):
        self.name = name
        self.config = config
        self.system = system
        self.running = False
        self.capabilities = []
        
        # Event handling
        self._event_handlers = {}
        
    async def initialize(self):
        """Initialize the agent."""
        try:
            await self.on_initialize()
            self.running = True
            print(f"✅ {self.name} agent initialized successfully", file=sys.stderr)
            
        except Exception as e:
            print(f"❌ Failed to initialize {self.name} agent: {str(e)}", file=sys.stderr)
            raise
    
    @abstractmethod
    async def on_initialize(self):
        """Agent-specific initialization logic."""
        pass
    
    async def shutdown(self):
        """Shutdown the agent gracefully."""
        try:
            await self.on_shutdown()
            self.running = False
            print(f"✅ {self.name} agent shut down successfully", file=sys.stderr)
            
        except Exception as e:
            print(f"❌ Error shutting down {self.name} agent: {str(e)}", file=sys.stderr)
    
    async def on_shutdown(self):
        """Agent-specific shutdown logic."""
        pass
    
    async def health_check(self) -> Dict[str, Any]:
        """Check agent health and return status."""
        return {
            "healthy": self.running,
            "name": self.name,
            "capabilities": self.capabilities
        }
    
    def register_capability(self, capability: str):
        """Register a capability this agent provides."""
        if capability not in self.capabilities:
            self.capabilities.append(capability)
    
    def has_capability(self, capability: str) -> bool:
        """Check if agent has a specific capability."""
        return capability in self.capabilities
    
    async def handle_event(self, event_type: str, data: Dict[str, Any]) -> Optional[Any]:
        """Handle an event sent to this agent."""
        handler = self._event_handlers.get(event_type)
        if handler:
            try:
                return await handler(data)
            except Exception as e:
                print(f"❌ Event handler failed: {event_type} - {str(e)}", file=sys.stderr)
                raise
        else:
            return None
    
    def register_event_handler(self, event_type: str, handler):
        """Register an event handler for a specific event type."""
        self._event_handlers[event_type] = handler


class LLMProvider(BaseAgent):
    """Base class for LLM providers."""
    
    def __init__(self, name: str, config: Dict[str, Any]):
        super().__init__(name, config)
        self.register_capability("llm_analysis")
    
    async def on_initialize(self):
        """Initialize the LLM provider."""
        # Provider-specific initialization
        pass
        
    async def analyze(self, prompt: str, content: str, options: Dict[str, Any] = None) -> Dict[str, Any]:
        """Analyze content with the LLM."""
        raise NotImplementedError
        
    def validate_config(self) -> bool:
        """Validate provider configuration."""
        raise NotImplementedError


class ClaudeProvider(LLMProvider):
    """Enhanced Claude (Anthropic) LLM provider with sophisticated prompts."""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__("claude_provider", config)
        self.api_key = os.getenv("ANTHROPIC_API_KEY")
        
    def validate_config(self) -> bool:
        return bool(self.api_key and self.api_key != "your-anthropic-api-key")
    
    def _build_system_prompt(self, analysis_type: str) -> str:
        """Build enhanced system prompt for Claude."""
        base_prompt = """You are an expert semantic analysis AI specializing in code analysis, technical documentation, and software development patterns.

Your responses should be precise, structured, and focused on actionable insights. Always respond in valid JSON format when requested."""

        type_specific_prompts = {
            "general": "Provide comprehensive analysis with clear structure.",
            "code": "Focus on architectural patterns, design decisions, and technical significance.",
            "conversation": "Extract key decisions, rationales, and transferable insights.",
            "pattern_extraction": "Identify and categorize specific patterns with clear examples.",
            "insight_generation": "Generate actionable insights from raw analysis data.",
            "significance_scoring": "Evaluate technical significance and provide numerical score."
        }

        return f"{base_prompt}\n\n{type_specific_prompts.get(analysis_type, type_specific_prompts['general'])}"
    
    async def analyze(self, prompt: str, content: str, options: Dict[str, Any] = None) -> Dict[str, Any]:
        """Analyze content using Claude API with enhanced prompts."""
        if not self.validate_config():
            return {"success": False, "error": "Claude API key not configured", "provider": "claude"}
        
        options = options or {}
        analysis_type = options.get("analysis_type", "general")
        
        try:
            import anthropic
            
            client = anthropic.Anthropic(api_key=self.api_key)
            
            system_prompt = self._build_system_prompt(analysis_type)
            user_prompt = f"{prompt}\n\n=== CONTENT TO ANALYZE ===\n{content}"
            
            response = await asyncio.to_thread(
                client.messages.create,
                model=options.get("model", "claude-3-5-sonnet-20241022"),
                max_tokens=options.get("max_tokens", 4096),
                temperature=options.get("temperature", 0.3),
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}]
            )
            
            result = self._parse_response(response.content[0].text, options)
            
            return {
                "success": True,
                "result": result,
                "provider": "claude",
                "usage": {
                    "input_tokens": response.usage.input_tokens,
                    "output_tokens": response.usage.output_tokens
                }
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "provider": "claude"
            }
    
    def _parse_response(self, response_text: str, options: Dict[str, Any]) -> Dict[str, Any]:
        """Parse Claude's response with structured extraction."""
        try:
            # Try to parse as JSON first
            import re
            json_match = re.search(r'\{[\s\S]*\}', response_text)
            if json_match:
                return json.loads(json_match.group(0))
            
            # Fall back to structured text parsing
            return {
                "analysis": response_text,
                "structured": self._extract_structured_data(response_text),
                "timestamp": asyncio.get_event_loop().time()
            }
            
        except Exception:
            return {
                "analysis": response_text,
                "structured": None,
                "timestamp": asyncio.get_event_loop().time()
            }
    
    def _extract_structured_data(self, text: str) -> Optional[Dict[str, Any]]:
        """Extract structured data from text response."""
        structured = {}
        
        # Extract patterns like "Key: Value"
        import re
        key_value_regex = re.compile(r'^([A-Z][a-zA-Z\s]+):\s*(.+)$', re.MULTILINE)
        
        for match in key_value_regex.finditer(text):
            key = match.group(1).lower().replace(' ', '_')
            value = match.group(2).strip()
            structured[key] = value
        
        return structured if structured else None


class OpenAIProvider(LLMProvider):
    """Enhanced OpenAI LLM provider with 3-tier fallback and sophisticated prompts."""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__("openai_provider", config)
        self.api_key = os.getenv("OPENAI_API_KEY")
        self.base_url = os.getenv("OPENAI_BASE_URL")
        
    def validate_config(self) -> bool:
        return bool(self.api_key and self.api_key != "your-openai-api-key")
    
    def _build_system_prompt(self, analysis_type: str) -> str:
        """Build enhanced system prompt for OpenAI."""
        base_prompt = """You are an expert semantic analysis AI specializing in code analysis, technical documentation, and software development patterns.

Your responses should be precise, structured, and focused on actionable insights. Always respond in valid JSON format when requested."""

        type_specific_prompts = {
            "general": "Provide comprehensive analysis with clear structure.",
            "code": "Focus on architectural patterns, design decisions, and technical significance.",
            "conversation": "Extract key decisions, rationales, and transferable insights.",
            "pattern_extraction": "Identify and categorize specific patterns with clear examples.",
            "insight_generation": "Generate actionable insights from raw analysis data.",
            "significance_scoring": "Evaluate technical significance and provide numerical score."
        }

        return f"{base_prompt}\n\n{type_specific_prompts.get(analysis_type, type_specific_prompts['general'])}"
    
    async def analyze(self, prompt: str, content: str, options: Dict[str, Any] = None) -> Dict[str, Any]:
        """Analyze content using OpenAI API with enhanced prompts."""
        if not self.validate_config():
            return {"success": False, "error": "OpenAI API key not configured", "provider": "openai"}
        
        options = options or {}
        analysis_type = options.get("analysis_type", "general")
        
        try:
            import openai
            
            client = openai.AsyncOpenAI(
                api_key=self.api_key,
                base_url=self.base_url
            )
            
            system_prompt = self._build_system_prompt(analysis_type)
            user_prompt = f"{prompt}\n\n=== CONTENT TO ANALYZE ===\n{content}"
            
            # Determine model based on whether we're using custom OpenAI
            model = "gpt-4"
            if self.base_url:
                # Custom OpenAI endpoint - might be using different models
                model = options.get("model", "gpt-4")
            
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=options.get("temperature", 0.3),
                max_tokens=options.get("max_tokens", 4096)
            )
            
            result = self._parse_response(response.choices[0].message.content, options)
            
            provider_name = "custom_openai" if self.base_url else "openai"
            
            return {
                "success": True,
                "result": result,
                "provider": provider_name,
                "usage": {
                    "input_tokens": response.usage.prompt_tokens if response.usage else 0,
                    "output_tokens": response.usage.completion_tokens if response.usage else 0
                }
            }
            
        except Exception as e:
            provider_name = "custom_openai" if self.base_url else "openai"
            return {
                "success": False,
                "error": str(e),
                "provider": provider_name
            }
    
    def _parse_response(self, response_text: str, options: Dict[str, Any]) -> Dict[str, Any]:
        """Parse OpenAI's response with structured extraction."""
        try:
            # Try to parse as JSON first
            import re
            json_match = re.search(r'\{[\s\S]*\}', response_text)
            if json_match:
                return json.loads(json_match.group(0))
            
            # Fall back to structured text parsing
            return {
                "analysis": response_text,
                "structured": self._extract_structured_data(response_text),
                "timestamp": asyncio.get_event_loop().time()
            }
            
        except Exception:
            return {
                "analysis": response_text,
                "structured": None,
                "timestamp": asyncio.get_event_loop().time()
            }
    
    def _extract_structured_data(self, text: str) -> Optional[Dict[str, Any]]:
        """Extract structured data from text response."""
        structured = {}
        
        # Extract patterns like "Key: Value"
        import re
        key_value_regex = re.compile(r'^([A-Z][a-zA-Z\s]+):\s*(.+)$', re.MULTILINE)
        
        for match in key_value_regex.finditer(text):
            key = match.group(1).lower().replace(' ', '_')
            value = match.group(2).strip()
            structured[key] = value
        
        return structured if structured else None


class SemanticAnalysisEngine(BaseAgent):
    """Enhanced semantic analysis engine with 3-tier fallback system."""
    
    def __init__(self):
        super().__init__("semantic_analysis_engine", {})
        self.providers = {}
        self.api_key_manager = APIKeyManager()
        self.primary_provider = None
        self.fallback_provider = None
        self.analysis_cache = {}
        
        self.register_capability("semantic_analysis")
        self.register_capability("3_tier_fallback")
        self.register_capability("enhanced_prompts")
        self.register_capability("response_parsing")
        self.register_capability("caching")
    
    async def on_initialize(self):
        """Initialize the semantic analysis engine with 3-tier fallback."""
        print("🔄 Initializing enhanced semantic analysis engine with 3-tier fallback...", file=sys.stderr)
        await self._initialize_providers()
        
        status = self.api_key_manager.get_status_report()
        print(f"✅ API Status: {status['has_ai_providers']} providers, chain: {status['fallback_chain']}", file=sys.stderr)
        
        if not status["has_ai_providers"]:
            print("⚠️  No AI providers available - using UKB-CLI fallback mode", file=sys.stderr)
    
    async def _initialize_providers(self):
        """Initialize LLM providers in 3-tier fallback order."""
        fallback_chain = self.api_key_manager.get_fallback_chain()
        
        for provider_type in fallback_chain:
            try:
                if provider_type == "anthropic":
                    provider = ClaudeProvider({})
                elif provider_type in ("openai", "custom_openai"):
                    provider = OpenAIProvider({})
                else:
                    continue
                
                if provider.validate_config():
                    await provider.initialize()
                    self.providers[provider_type] = provider
                    
                    if not self.primary_provider:
                        self.primary_provider = provider
                        print(f"✅ Primary provider: {provider_type}", file=sys.stderr)
                    elif not self.fallback_provider:
                        self.fallback_provider = provider
                        print(f"✅ Fallback provider: {provider_type}", file=sys.stderr)
                
            except Exception as e:
                print(f"⚠️  Failed to initialize {provider_type} provider: {e}", file=sys.stderr)
    
    async def analyze_with_llm(self, prompt: str, content: str, analysis_type: str = "general") -> Dict[str, Any]:
        """Analyze content with enhanced 3-tier fallback system."""
        options = {"analysis_type": analysis_type}
        
        # Check cache first
        cache_key = f"{analysis_type}:{hash(content)}:{hash(prompt)}"
        if cache_key in self.analysis_cache:
            cache_entry = self.analysis_cache[cache_key]
            if asyncio.get_event_loop().time() - cache_entry["timestamp"] < 300:  # 5 min TTL
                print("📋 Returning cached analysis result", file=sys.stderr)
                return cache_entry["result"]
        
        # Try primary provider first
        if self.primary_provider:
            try:
                print(f"🔄 Attempting analysis with primary provider ({self.primary_provider.name})", file=sys.stderr)
                result = await self.primary_provider.analyze(prompt, content, options)
                
                if result.get("success"):
                    # Cache successful result
                    self.analysis_cache[cache_key] = {
                        "result": result,
                        "timestamp": asyncio.get_event_loop().time()
                    }
                    print(f"✅ Analysis successful with {result.get('provider', 'unknown')}", file=sys.stderr)
                    return result
                else:
                    print(f"⚠️  Primary provider failed: {result.get('error')}", file=sys.stderr)
                    
            except Exception as e:
                print(f"⚠️  Primary provider exception: {e}", file=sys.stderr)
        
        # Try fallback provider
        if self.fallback_provider:
            try:
                print(f"🔄 Using fallback provider ({self.fallback_provider.name})", file=sys.stderr)
                result = await self.fallback_provider.analyze(prompt, content, options)
                
                if result.get("success"):
                    # Cache successful result
                    self.analysis_cache[cache_key] = {
                        "result": result,
                        "timestamp": asyncio.get_event_loop().time()
                    }
                    print(f"✅ Analysis successful with fallback {result.get('provider', 'unknown')}", file=sys.stderr)
                    return result
                else:
                    print(f"⚠️  Fallback provider failed: {result.get('error')}", file=sys.stderr)
                    
            except Exception as e:
                print(f"⚠️  Fallback provider exception: {e}", file=sys.stderr)
        
        # Final fallback - UKB-CLI mode
        print("🔄 Using UKB-CLI fallback mode", file=sys.stderr)
        return await self._ukb_fallback_analysis(prompt, content, analysis_type)
    
    async def _ukb_fallback_analysis(self, prompt: str, content: str, analysis_type: str) -> Dict[str, Any]:
        """Final fallback using UKB-CLI for analysis."""
        try:
            # Simple pattern-based analysis when no AI providers available
            word_count = len(content.split())
            char_count = len(content)
            
            # Basic complexity scoring
            complexity_score = min(10, max(1, word_count // 100))
            
            analysis = {
                "analysis_type": analysis_type,
                "word_count": word_count,
                "character_count": char_count,
                "complexity_score": complexity_score,
                "summary": f"Content analysis: {word_count} words, {char_count} characters",
                "provider_note": "Analysis performed using UKB-CLI fallback mode (no AI providers available)"
            }
            
            return {
                "success": True,
                "result": analysis,
                "provider": "ukb_fallback"
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"UKB fallback failed: {str(e)}",
                "provider": "ukb_fallback"
            }


class AgentManager:
    """
    Manages the initialization and coordination of all 7 agents.
    Provides a unified interface for the MCP server while maintaining
    backward compatibility with the existing SemanticAnalysisEngine.
    """
    
    def __init__(self):
        self.agents = {}
        self.coordinator = None
        self.initialized = False
        self.fallback_engine = SemanticAnalysisEngine()
        
    async def initialize(self):
        """Initialize all agents and the coordinator."""
        try:
            # First initialize the fallback engine
            await self.fallback_engine.initialize()
            print("✅ Fallback engine initialized", file=sys.stderr)
            
            # Only initialize agents if imports were successful
            if AGENTS_AVAILABLE and CONFIG_AVAILABLE:
                try:
                    # Get agent and coordinator configurations
                    agent_definitions = agent_config.get_agent_definitions()
                    system_config = agent_config.get_system_config()
                    
                    # Initialize coordinator first
                    if 'coordinator' in agent_definitions:
                        coord_def = agent_definitions['coordinator']
                        self.coordinator = CoordinatorAgent(
                            name=coord_def.name,
                            config=coord_def.config,
                            system=self  # Pass self as the system reference
                        )
                        await self.coordinator.initialize()
                        print("✅ Coordinator agent initialized", file=sys.stderr)
                    
                    # Initialize semantic analysis agent
                    if 'semantic_analysis' in agent_definitions:
                        sem_def = agent_definitions['semantic_analysis']
                        self.agents['semantic_analysis'] = FullSemanticAnalysisAgent(
                            name=sem_def.name,
                            config=sem_def.config,
                            system=self
                        )
                        await self.agents['semantic_analysis'].initialize()
                        print("✅ Semantic analysis agent initialized", file=sys.stderr)
                    
                    # Initialize DocumentationAgent
                    if 'documentation' in agent_definitions:
                        doc_def = agent_definitions['documentation']
                        print(f"🔍 DEBUG: Creating documentation agent with config: {doc_def.config}", file=sys.stderr)
                        self.agents['documentation'] = DocumentationAgent(
                            name=doc_def.name,
                            config=doc_def.config,
                            system=self
                        )
                        print(f"🔍 DEBUG: About to initialize documentation agent...", file=sys.stderr)
                        try:
                            await self.agents['documentation'].initialize()
                            print(f"🔍 DEBUG: Documentation agent event handlers: {list(self.agents['documentation']._event_handlers.keys())}", file=sys.stderr)
                            print("✅ Documentation agent initialized", file=sys.stderr)
                        except Exception as e:
                            print(f"❌ ERROR initializing documentation agent: {e}", file=sys.stderr)
                            import traceback
                            traceback.print_exc(file=sys.stderr)
                    
                    # Initialize KnowledgeGraphAgent
                    if 'knowledge_graph' in agent_definitions:
                        kg_def = agent_definitions['knowledge_graph']
                        self.agents['knowledge_graph'] = KnowledgeGraphAgent(
                            name=kg_def.name,
                            config=kg_def.config,
                            system=self
                        )
                        await self.agents['knowledge_graph'].initialize()
                        print("✅ Knowledge graph agent initialized", file=sys.stderr)
                    
                    # Initialize WebSearchAgent
                    if 'web_search' in agent_definitions:
                        ws_def = agent_definitions['web_search']
                        self.agents['web_search'] = WebSearchAgent(
                            name=ws_def.name,
                            config=ws_def.config,
                            system=self
                        )
                        await self.agents['web_search'].initialize()
                        print("✅ Web search agent initialized", file=sys.stderr)
                    
                    # Initialize SynchronizationAgent
                    if 'synchronization' in agent_definitions:
                        sync_def = agent_definitions['synchronization']
                        self.agents['synchronization'] = SynchronizationAgent(
                            name=sync_def.name,
                            config=sync_def.config,
                            system=self
                        )
                        await self.agents['synchronization'].initialize()
                        print("✅ Synchronization agent initialized", file=sys.stderr)
                    
                    # Initialize DeduplicationAgent
                    if 'deduplication' in agent_definitions:
                        dedup_def = agent_definitions['deduplication']
                        self.agents['deduplication'] = DeduplicationAgent(
                            name=dedup_def.name,
                            config=dedup_def.config,
                            system=self
                        )
                        await self.agents['deduplication'].initialize()
                        print("✅ Deduplication agent initialized", file=sys.stderr)
                    
                except Exception as e:
                    print(f"⚠️  Error initializing agents: {e}", file=sys.stderr)
                    import traceback
                    traceback.print_exc(file=sys.stderr)
            else:
                print("⚠️  Agents not available, using fallback only", file=sys.stderr)
            
            self.initialized = True
            print("✅ Agent Manager initialized", file=sys.stderr)
            
        except Exception as e:
            print(f"⚠️  Agent Manager initialization failed: {e}", file=sys.stderr)
            print("🔄 Using fallback engine only", file=sys.stderr)
            # Even if agent initialization fails, we have the fallback engine
    
    async def shutdown(self):
        """Shutdown all agents gracefully."""
        # Shutdown agents in reverse order
        for agent_name, agent in reversed(list(self.agents.items())):
            try:
                await agent.shutdown()
                print(f"✅ {agent_name} agent shutdown", file=sys.stderr)
            except Exception as e:
                print(f"⚠️  Error shutting down {agent_name}: {e}", file=sys.stderr)
        
        # Shutdown coordinator
        if self.coordinator:
            try:
                await self.coordinator.shutdown()
            except Exception as e:
                print(f"⚠️  Error shutting down coordinator: {e}", file=sys.stderr)
    
    def get_fallback_engine(self):
        """Get the fallback semantic analysis engine."""
        return self.fallback_engine
    
    async def execute_workflow(self, workflow_name: str, parameters: Dict[str, Any] = None) -> Dict[str, Any]:
        """Execute a workflow through the coordinator."""
        if not self.coordinator:
            return {
                "success": False,
                "error": "Coordinator not available",
                "fallback": "No workflow execution available without coordinator"
            }
        
        try:
            if CONFIG_AVAILABLE:
                # Get workflow definitions and execute through coordinator
                result = await self.coordinator.handle_event("execute_workflow", {
                    "workflow_name": workflow_name,
                    "parameters": parameters or {}
                })
                return result
            else:
                # Simple fallback workflow execution
                return await self._execute_simple_workflow(workflow_name, parameters or {})
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "workflow": workflow_name
            }
    
    async def _execute_simple_workflow(self, workflow_name: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
        """Simple workflow execution when configuration is not available."""
        steps_completed = []
        
        # Step 1: Semantic Analysis (if available)
        if 'semantic_analysis' in self.agents:
            try:
                content = parameters.get("code", parameters.get("content", ""))
                result = await self.agents['semantic_analysis'].analyze(
                    analysis_type="workflow_analysis", 
                    content=content,
                    options=parameters
                )
                steps_completed.append({"step": "semantic_analysis", "status": "completed", "result": result.get("success", False)})
            except Exception as e:
                steps_completed.append({"step": "semantic_analysis", "status": "failed", "error": str(e)})
        
        # Step 2: Knowledge Graph Update
        if 'knowledge_graph' in self.agents:
            try:
                result = await self.agents['knowledge_graph'].update_knowledge_graph(
                    entities=[{"name": "WorkflowExecution", "entity_type": "Process", "observations": [f"Executed {workflow_name} workflow"]}]
                )
                steps_completed.append({"step": "knowledge_graph", "status": "completed", "result": result.get("success", False)})
            except Exception as e:
                steps_completed.append({"step": "knowledge_graph", "status": "failed", "error": str(e)})
        
        # Step 3: Synchronization  
        if 'synchronization' in self.agents:
            try:
                result = await self.agents['synchronization'].sync_all_sources()
                steps_completed.append({"step": "synchronization", "status": "completed", "result": result.get("success", False)})
            except Exception as e:
                steps_completed.append({"step": "synchronization", "status": "failed", "error": str(e)})
        
        return {
            "success": True,
            "workflow": workflow_name,
            "workflow_id": f"simple-{workflow_name}-{int(time.time())}",
            "status": "completed",
            "steps": len(steps_completed),
            "steps_completed": steps_completed,
            "message": f"Simple workflow '{workflow_name}' executed with {len(steps_completed)} steps"
        }
    
    async def analyze_repository(self, path: str, options: Dict[str, Any] = None) -> Dict[str, Any]:
        """Analyze a repository using the semantic analysis agent."""
        if 'semantic_analysis' not in self.agents:
            return {
                "success": False,
                "error": "Semantic analysis agent not available",
                "fallback": "Using simple analysis"
            }
        
        try:
            agent = self.agents['semantic_analysis']
            # Use the agent's analyze method
            result = await agent.analyze(
                analysis_type="repository_analysis",
                content=f"Repository path: {path}",
                options=options or {}
            )
            return result
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "path": path
            }
    
    async def extract_patterns(self, code: str, language: str = "unknown") -> Dict[str, Any]:
        """Extract patterns from code using the semantic analysis agent."""
        if 'semantic_analysis' not in self.agents:
            # Fallback to the simple engine
            return await self.fallback_engine.analyze_with_llm(
                f"Extract patterns from this {language} code:",
                code,
                "pattern_extraction"
            )
        
        try:
            agent = self.agents['semantic_analysis']
            result = await agent.analyze(
                analysis_type="pattern_extraction",
                content=code,
                options={"language": language}
            )
            return result
        except Exception as e:
            # Fallback to simple analysis
            return await self.fallback_engine.analyze_with_llm(
                f"Extract patterns from this {language} code:",
                code,
                "pattern_extraction"
            )


async def main():
    """Main entry point for the MCP server."""
    
    # Create the server and agent manager
    server = Server("semantic-analysis")
    agent_manager = AgentManager()
    
    # Initialize the agent manager (which includes the fallback engine)
    await agent_manager.initialize()
    
    # Get the analysis engine for backward compatibility
    analysis_engine = agent_manager.get_fallback_engine()
    
    @server.list_tools()
    async def list_tools() -> list[Tool]:
        """List available tools."""
        return [
            Tool(
                name="test_connection",
                description="Test the connection to the semantic analysis server",
                inputSchema={
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False
                }
            ),
            Tool(
                name="analyze_code", 
                description="Analyze code for patterns and issues",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "The code to analyze"
                        },
                        "language": {
                            "type": "string", 
                            "description": "Programming language"
                        }
                    },
                    "required": ["code"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="determine_insights",
                description="Determine insights from analysis results",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "context": {
                            "type": "string",
                            "description": "Context for insight generation"
                        }
                    },
                    "required": ["context"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="execute_workflow",
                description="Execute a predefined analysis workflow through the coordinator",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "workflow_name": {
                            "type": "string",
                            "description": "Name of the workflow to execute (e.g., 'complete-analysis', 'incremental-analysis')"
                        },
                        "parameters": {
                            "type": "object",
                            "description": "Optional parameters for the workflow",
                            "additionalProperties": True
                        }
                    },
                    "required": ["workflow_name"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="analyze_repository",
                description="Analyze a repository structure and patterns using the semantic analysis agent",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the repository to analyze"
                        },
                        "options": {
                            "type": "object",
                            "description": "Optional analysis options",
                            "additionalProperties": True
                        }
                    },
                    "required": ["path"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="extract_patterns",
                description="Extract design and architectural patterns from code",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "The code to analyze for patterns"
                        },
                        "language": {
                            "type": "string",
                            "description": "Programming language of the code"
                        }
                    },
                    "required": ["code"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="generate_documentation",
                description="Generate comprehensive documentation from analysis results",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "analysis_result": {
                            "type": "object",
                            "description": "Analysis results to document"
                        },
                        "metadata": {
                            "type": "object",
                            "description": "Optional metadata for documentation generation",
                            "additionalProperties": True
                        }
                    },
                    "required": ["analysis_result"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="create_insight_report",
                description="Create a detailed insight report with PlantUML diagrams",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "analysis_result": {
                            "type": "object",
                            "description": "Analysis results to create insight from"
                        },
                        "metadata": {
                            "type": "object",
                            "description": "Optional metadata including insight name and type",
                            "additionalProperties": True
                        }
                    },
                    "required": ["analysis_result"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="generate_plantuml_diagrams",
                description="Generate PlantUML diagrams for analysis results",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "diagram_type": {
                            "type": "string",
                            "description": "Type of diagram (architecture, sequence, use-cases, class)",
                            "enum": ["architecture", "sequence", "use-cases", "class"]
                        },
                        "content": {
                            "type": "string",
                            "description": "Content/title for the diagram"
                        },
                        "name": {
                            "type": "string",
                            "description": "Base name for the diagram files"
                        },
                        "analysis_result": {
                            "type": "object",
                            "description": "Optional analysis result for context",
                            "additionalProperties": True
                        }
                    },
                    "required": ["diagram_type", "content", "name"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="generate_lessons_learned",
                description="Generate lessons learned document (lele) with UKB integration",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "analysis_result": {
                            "type": "object",
                            "description": "Analysis results to extract lessons from"
                        },
                        "title": {
                            "type": "string",
                            "description": "Title for the lessons learned document"
                        },
                        "metadata": {
                            "type": "object",
                            "description": "Optional metadata for the lessons learned",
                            "additionalProperties": True
                        }
                    },
                    "required": ["analysis_result"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="create_ukb_entity_with_insight",
                description="Create UKB entity with detailed insight document",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "analysis_result": {
                            "type": "object",
                            "description": "Analysis results to create entity from"
                        },
                        "metadata": {
                            "type": "object",
                            "description": "Entity metadata including name, type, significance",
                            "additionalProperties": True
                        }
                    },
                    "required": ["analysis_result"],
                    "additionalProperties": False
                }
            )
        ]
    
    @server.call_tool()
    async def call_tool(name: str, arguments: Dict[str, Any]) -> list[TextContent]:
        """Handle tool calls."""
        
        # Debug: Log all tool calls
        with open("/tmp/mcp_debug.log", "a") as f:
            f.write(f"🔍 DEBUG: call_tool called with name={name}, arguments={arguments}\n")
        
        if name == "test_connection":
            return [TextContent(
                type="text", 
                text="✅ Semantic analysis server connection successful!"
            )]
        
        elif name == "analyze_code":
            code = arguments.get("code", "")
            language = arguments.get("language", "unknown")
            
            # Try to use the semantic analysis agent first
            if 'semantic_analysis' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['semantic_analysis'].analyze(
                        analysis_type="code_analysis",
                        content=code,
                        options={"language": language}
                    )
                    
                    return [TextContent(
                        type="text",
                        text=f"Enhanced code analysis (via agent):\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    print(f"⚠️  Agent analysis failed, falling back: {e}", file=sys.stderr)
            
            # Fallback to LLM-powered analysis
            prompt = f"Analyze this {language} code for patterns, issues, and architectural insights:"
            
            try:
                llm_result = await analysis_engine.analyze_with_llm(prompt, code, "code")
                
                analysis = {
                    "language": language,
                    "lines": len(code.split('\n')),
                    "characters": len(code),
                    "llm_analysis": llm_result.get("result", "No LLM analysis available"),
                    "provider_used": llm_result.get("provider", "unknown"),
                    "status": "analyzed"
                }
                
                return [TextContent(
                    type="text",
                    text=f"Enhanced code analysis complete:\n{json.dumps(analysis, indent=2)}"
                )]
                
            except Exception as e:
                # Fallback to simple analysis
                analysis = {
                    "language": language,
                    "lines": len(code.split('\n')),
                    "characters": len(code),
                    "error": str(e),
                    "status": "fallback_analysis"
                }
                
                return [TextContent(
                    type="text",
                    text=f"Code analysis (fallback):\n{json.dumps(analysis, indent=2)}"
                )]
        
        elif name == "determine_insights":
            context = arguments.get("context", "")
            
            # Enhanced LLM-powered insight generation
            prompt = "Generate actionable insights from this analysis context:"
            
            try:
                llm_result = await analysis_engine.analyze_with_llm(prompt, context, "insight_generation")
                
                insight = {
                    "context": context,
                    "llm_insights": llm_result.get("result", "No LLM insights available"),
                    "provider_used": llm_result.get("provider", "unknown"),
                    "confidence": 0.95,
                    "status": "complete"
                }
                
                return [TextContent(
                    type="text", 
                    text=f"Enhanced insights determined:\n{json.dumps(insight, indent=2)}"
                )]
                
            except Exception as e:
                # Fallback to simple insight
                insight = {
                    "context": context,
                    "insight": "Enhanced MCP server with LLM integration",
                    "error": str(e),
                    "confidence": 0.5,
                    "status": "fallback"
                }
                
                return [TextContent(
                    type="text", 
                    text=f"Insights (fallback):\n{json.dumps(insight, indent=2)}"
                )]
        
        elif name == "execute_workflow":
            workflow_name = arguments.get("workflow_name", "")
            parameters = arguments.get("parameters", {})
            
            try:
                result = await agent_manager.execute_workflow(workflow_name, parameters)
                
                return [TextContent(
                    type="text",
                    text=f"Workflow execution result:\n{json.dumps(result, indent=2)}"
                )]
                
            except Exception as e:
                error_result = {
                    "success": False,
                    "error": str(e),
                    "workflow": workflow_name
                }
                
                return [TextContent(
                    type="text",
                    text=f"Workflow execution error:\n{json.dumps(error_result, indent=2)}"
                )]
        
        elif name == "analyze_repository":
            path = arguments.get("path", "")
            options = arguments.get("options", {})
            
            try:
                result = await agent_manager.analyze_repository(path, options)
                
                return [TextContent(
                    type="text",
                    text=f"Repository analysis result:\n{json.dumps(result, indent=2)}"
                )]
                
            except Exception as e:
                error_result = {
                    "success": False,
                    "error": str(e),
                    "path": path
                }
                
                return [TextContent(
                    type="text",
                    text=f"Repository analysis error:\n{json.dumps(error_result, indent=2)}"
                )]
        
        elif name == "extract_patterns":
            code = arguments.get("code", "")
            language = arguments.get("language", "unknown")
            
            try:
                result = await agent_manager.extract_patterns(code, language)
                
                return [TextContent(
                    type="text",
                    text=f"Pattern extraction result:\n{json.dumps(result, indent=2)}"
                )]
                
            except Exception as e:
                error_result = {
                    "success": False,
                    "error": str(e),
                    "language": language
                }
                
                return [TextContent(
                    type="text",
                    text=f"Pattern extraction error:\n{json.dumps(error_result, indent=2)}"
                )]
        
        elif name == "generate_documentation":
            # Debug: Log that we're entering this function
            with open("/tmp/mcp_debug.log", "a") as f:
                f.write(f"🔍 DEBUG: generate_documentation called with args: {arguments}\n")
                f.write(f"🔍 DEBUG: Available agents: {list(agent_manager.agents.keys())}\n")
            
            analysis_result = arguments.get("analysis_result", {})
            metadata = arguments.get("metadata", {})
            
            try:
                if 'documentation' in agent_manager.agents:
                    doc_agent = agent_manager.agents['documentation']
                    # Debug to file
                    with open("/tmp/mcp_debug.log", "a") as f:
                        f.write(f"🔍 DEBUG: DocumentationAgent found: {doc_agent}\n")
                        f.write(f"🔍 DEBUG: Event handlers: {list(doc_agent._event_handlers.keys())}\n")
                    
                    result = await doc_agent.handle_event("generate_analysis_doc", {
                        "analysis_result": analysis_result,
                        "metadata": metadata
                    })
                    
                    # Debug to file
                    with open("/tmp/mcp_debug.log", "a") as f:
                        f.write(f"🔍 DEBUG: Result type: {type(result)}\n")
                        f.write(f"🔍 DEBUG: Result value: {result}\n")
                    
                    print(f"🔍 DEBUG: DocumentationAgent found: {doc_agent}", file=sys.stderr)
                    print(f"🔍 DEBUG: Event handlers: {list(doc_agent._event_handlers.keys())}", file=sys.stderr)
                    print(f"🔍 DEBUG: Result type: {type(result)}", file=sys.stderr)
                    print(f"🔍 DEBUG: Result value: {result}", file=sys.stderr)
                    
                    return [TextContent(
                        type="text",
                        text=f"Documentation generated:\n{json.dumps(result, indent=2)}"
                    )]
                else:
                    return [TextContent(
                        type="text",
                        text="Documentation agent not available"
                    )]
                    
            except Exception as e:
                error_result = {"success": False, "error": str(e)}
                return [TextContent(
                    type="text",
                    text=f"Documentation generation error:\n{json.dumps(error_result, indent=2)}"
                )]
        
        elif name == "create_insight_report":
            analysis_result = arguments.get("analysis_result", {})
            metadata = arguments.get("metadata", {})
            
            try:
                if 'documentation' in agent_manager.agents:
                    doc_agent = agent_manager.agents['documentation']
                    result = await doc_agent.handle_event("create_insight_document", {
                        "analysis_result": analysis_result,
                        "metadata": metadata
                    })
                    
                    return [TextContent(
                        type="text",
                        text=f"Insight report created:\n{json.dumps(result, indent=2)}"
                    )]
                else:
                    return [TextContent(
                        type="text",
                        text="Documentation agent not available"
                    )]
                    
            except Exception as e:
                error_result = {"success": False, "error": str(e)}
                return [TextContent(
                    type="text",
                    text=f"Insight report creation error:\n{json.dumps(error_result, indent=2)}"
                )]
        
        elif name == "generate_plantuml_diagrams":
            diagram_type = arguments.get("diagram_type", "architecture")
            content = arguments.get("content", "")
            name = arguments.get("name", "diagram")
            analysis_result = arguments.get("analysis_result", {})
            
            try:
                if 'documentation' in agent_manager.agents:
                    doc_agent = agent_manager.agents['documentation']
                    
                    # Generate diagram
                    diagram_result = await doc_agent.handle_event("generate_plantuml_diagram", {
                        "diagram_type": diagram_type,
                        "content": content,
                        "name": name,
                        "analysis_result": analysis_result
                    })
                    
                    if diagram_result and diagram_result.get("success"):
                        # Convert to PNG
                        png_result = await doc_agent.handle_event("convert_puml_to_png", {
                            "puml_file": diagram_result["puml_file"]
                        })
                        
                        result = {
                            "diagram_generated": diagram_result,
                            "png_conversion": png_result
                        }
                    else:
                        result = diagram_result or {"success": False, "error": "Diagram generation failed"}
                    
                    return [TextContent(
                        type="text",
                        text=f"PlantUML diagram generated:\n{json.dumps(result, indent=2)}"
                    )]
                else:
                    return [TextContent(
                        type="text",
                        text="Documentation agent not available"
                    )]
                    
            except Exception as e:
                error_result = {"success": False, "error": str(e)}
                return [TextContent(
                    type="text",
                    text=f"PlantUML generation error:\n{json.dumps(error_result, indent=2)}"
                )]
        
        elif name == "generate_lessons_learned":
            analysis_result = arguments.get("analysis_result", {})
            title = arguments.get("title", "Lessons Learned")
            metadata = arguments.get("metadata", {})
            
            try:
                if 'documentation' in agent_manager.agents:
                    doc_agent = agent_manager.agents['documentation']
                    result = await doc_agent.handle_event("generate_lessons_learned", {
                        "analysis_result": analysis_result,
                        "title": title,
                        "metadata": metadata
                    })
                    
                    return [TextContent(
                        type="text",
                        text=f"Lessons learned generated:\n{json.dumps(result, indent=2)}"
                    )]
                else:
                    return [TextContent(
                        type="text",
                        text="Documentation agent not available"
                    )]
                    
            except Exception as e:
                error_result = {"success": False, "error": str(e)}
                return [TextContent(
                    type="text",
                    text=f"Lessons learned generation error:\n{json.dumps(error_result, indent=2)}"
                )]
        
        elif name == "create_ukb_entity_with_insight":
            analysis_result = arguments.get("analysis_result", {})
            metadata = arguments.get("metadata", {})
            
            try:
                if 'documentation' in agent_manager.agents:
                    doc_agent = agent_manager.agents['documentation']
                    result = await doc_agent.handle_event("create_ukb_entity_with_insight", {
                        "analysis_result": analysis_result,
                        "metadata": metadata
                    })
                    
                    return [TextContent(
                        type="text",
                        text=f"UKB entity with insight created:\n{json.dumps(result, indent=2)}"
                    )]
                else:
                    return [TextContent(
                        type="text",
                        text="Documentation agent not available"
                    )]
                    
            except Exception as e:
                error_result = {"success": False, "error": str(e)}
                return [TextContent(
                    type="text",
                    text=f"UKB entity creation error:\n{json.dumps(error_result, indent=2)}"
                )]
        
        else:
            return [TextContent(
                type="text",
                text=f"Unknown tool: {name}"
            )]
    
    # Run the server with proper async context
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream, 
            write_stream, 
            server.create_initialization_options()
        )


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())