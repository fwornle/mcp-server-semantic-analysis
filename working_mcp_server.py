#!/Users/q284340/Agentic/coding/integrations/mcp-server-semantic-analysis/venv/bin/python
"""
Enhanced MCP Server for Semantic Analysis
Integrates the 7-agent system: Step 2 - SemanticAnalysisAgent integration
"""

import json
import sys
import os
import asyncio
from typing import Any, Dict, Optional
from abc import ABC, abstractmethod
from pathlib import Path
from dotenv import load_dotenv
import datetime
import hashlib

# Version and startup tracking
VERSION = "1.4.0"
STARTUP_TIME = datetime.datetime.now().isoformat()
CODE_FILE = __file__
CODE_HASH = hashlib.md5(open(__file__, 'rb').read()).hexdigest()[:8]

# Load environment variables IMMEDIATELY at module import
# This ensures API keys are available regardless of how the module is loaded
coding_env_path = Path(__file__).parent.parent.parent / ".env"  # /Users/q284340/Agentic/coding/.env
parent_env_path = Path(__file__).parent.parent.parent.parent / ".env"
local_env_path = Path(__file__).parent / ".env"

# CRITICAL: The API keys might already be in environment from MCP config
# Only load from .env if they're not already set
if not (os.getenv('ANTHROPIC_API_KEY') and os.getenv('OPENAI_API_KEY')):
    # Try coding .env first (most likely location)
    if coding_env_path.exists():
        load_dotenv(coding_env_path, override=False)  # Don't override existing env vars
        print(f"✅ Loaded environment from: {coding_env_path}", file=sys.stderr)
    elif parent_env_path.exists():
        load_dotenv(parent_env_path, override=False)
        print(f"✅ Loaded environment from: {parent_env_path}", file=sys.stderr)
    elif local_env_path.exists():
        load_dotenv(local_env_path, override=False)
        print(f"✅ Loaded environment from: {local_env_path}", file=sys.stderr)
    else:
        print(f"⚠️  No .env file found at {coding_env_path}, {parent_env_path} or {local_env_path}", file=sys.stderr)
        print("⚠️  API keys must be set as environment variables", file=sys.stderr)
else:
    print(f"✅ API keys already in environment (from MCP config)", file=sys.stderr)

# CRITICAL: Log Python executable information for venv verification
print(f"🐍 PYTHON EXECUTABLE VERIFICATION:", file=sys.stderr)
print(f"   Current Python: {sys.executable}", file=sys.stderr)
print(f"   Python version: {sys.version.split()[0]}", file=sys.stderr)
print(f"   Virtual env: {os.getenv('VIRTUAL_ENV', 'Not detected')}", file=sys.stderr)
print(f"   Is venv Python: {'✅ YES' if 'venv' in sys.executable else '❌ NO - SYSTEM PYTHON'}", file=sys.stderr)
print(f"   Executable path contains 'venv': {'✅ YES' if 'venv' in sys.executable else '❌ NO'}", file=sys.stderr)

# Log current API key status for debugging
print(f"📋 Environment check at module load:", file=sys.stderr)
print(f"  Python executable: {sys.executable}", file=sys.stderr)
print(f"  Is venv: {sys.prefix != sys.base_prefix}", file=sys.stderr)
print(f"  ANTHROPIC_API_KEY: {'✅ Set' if os.getenv('ANTHROPIC_API_KEY') else '❌ Not set'}", file=sys.stderr)
print(f"  OPENAI_API_KEY: {'✅ Set' if os.getenv('OPENAI_API_KEY') else '❌ Not set'}", file=sys.stderr)
print(f"  OPENAI_BASE_URL: {'✅ Set' if os.getenv('OPENAI_BASE_URL') else '❌ Not set'}", file=sys.stderr)
print(f"  VIRTUAL_ENV: {os.getenv('VIRTUAL_ENV', 'Not set')}", file=sys.stderr)

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
                        # Add coordinator to agents dictionary so it's accessible
                        self.agents['coordinator'] = self.coordinator
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
                        self.agents['documentation'] = DocumentationAgent(
                            name=doc_def.name,
                            config=doc_def.config,
                            system=self
                        )
                        await self.agents['documentation'].initialize()
                        print("✅ Documentation agent initialized", file=sys.stderr)
                    
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
            # Get workflow definition from configuration
            if CONFIG_AVAILABLE:
                workflow_definitions = agent_config.get_workflow_definitions()
                if workflow_name not in workflow_definitions:
                    return {
                        "success": False,
                        "error": f"Unknown workflow: {workflow_name}",
                        "available_workflows": list(workflow_definitions.keys())
                    }
                
                workflow_def = workflow_definitions[workflow_name]
                
                # Execute workflow through coordinator
                result = await self.coordinator.execute_workflow(
                    workflow_name=workflow_name,
                    workflow_def=workflow_def,
                    parameters=parameters or {}
                )
                
                return {
                    "success": True,
                    "workflow": workflow_name,
                    "workflow_id": result["workflow_id"],
                    "status": result["status"],
                    "steps": result["steps"],
                    "message": f"Workflow '{workflow_name}' started successfully"
                }
            else:
                # Fallback implementation for simple workflows
                return await self._execute_simple_workflow(workflow_name, parameters or {})
                
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "workflow": workflow_name
            }
    
    async def _execute_simple_workflow(self, workflow_name: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
        """Simple workflow execution when configuration is not available."""
        if workflow_name == "complete-analysis":
            steps_completed = []
            
            # Step 1: Semantic Analysis
            if 'semantic_analysis' in self.agents:
                try:
                    result = await self.agents['semantic_analysis'].analyze(
                        analysis_type="repository_analysis",
                        content="Complete semantic analysis workflow",
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
                "workflow_id": f"simple_{workflow_name}_{int(time.time())}",
                "status": "completed",
                "steps_completed": steps_completed,
                "message": f"Simple workflow '{workflow_name}' executed"
            }
        
        elif workflow_name == "lele" or workflow_name == "lessons-learned":
            # Lessons learned workflow
            if 'documentation' in self.agents:
                try:
                    result = await self.agents['documentation'].handle_event("generate_lessons_learned", {
                        "analysis_result": {"insights": ["Workflow execution completed"], "patterns": ["Simple workflow pattern"]},
                        "title": "Lessons Learned from Workflow Execution"
                    })
                    return {
                        "success": True,
                        "workflow": workflow_name,
                        "workflow_id": f"lele_{int(time.time())}",
                        "status": "completed",
                        "result": result,
                        "message": "Lessons learned document generated"
                    }
                except Exception as e:
                    return {
                        "success": False,
                        "error": str(e),
                        "workflow": workflow_name
                    }
        
        return {
            "success": False,
            "error": f"Unknown simple workflow: {workflow_name}",
            "available_workflows": ["complete-analysis", "lele", "lessons-learned"]
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
            # Use the agent's analyze method with correct parameters
            result = await agent.analyze(
                analysis_type="repository_analysis",
                content=f"Analyze repository structure and patterns. Repository path: {path}",
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
                content=f"Extract design patterns and architectural patterns from this {language} code:\n\n{code}",
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
    
    try:
        # ===== STARTUP LOGGING =====
        print(f"🚀 ====== SEMANTIC ANALYSIS SERVER STARTUP ======", file=sys.stderr)
        print(f"📅 Startup Time: {STARTUP_TIME}", file=sys.stderr)
        print(f"📝 Version: {VERSION}", file=sys.stderr)
        print(f"📁 Code File: {CODE_FILE}", file=sys.stderr)
        print(f"🔢 Code Hash: {CODE_HASH}", file=sys.stderr)
        print(f"🐍 Python Version: {sys.version}", file=sys.stderr)
        print(f"📋 Working Directory: {os.getcwd()}", file=sys.stderr)
        print(f"🆔 Process ID: {os.getpid()}", file=sys.stderr)
        print(f"=================================================", file=sys.stderr)
        
        # Environment variables already loaded at module level
        print(f"📋 Environment check in main():", file=sys.stderr)
        print(f"  ANTHROPIC_API_KEY: {'✅ Set' if os.getenv('ANTHROPIC_API_KEY') else '❌ Not set'}", file=sys.stderr)
        print(f"  OPENAI_API_KEY: {'✅ Set' if os.getenv('OPENAI_API_KEY') else '❌ Not set'}", file=sys.stderr)
        print(f"  OPENAI_BASE_URL: {'✅ Set' if os.getenv('OPENAI_BASE_URL') else '❌ Not set'}", file=sys.stderr)
        
        # Create the server and agent manager
        server = Server("semantic-analysis")
        agent_manager = AgentManager()
        
        # Initialize the agent manager (which includes the fallback engine)
        print("🔄 Initializing agent manager...", file=sys.stderr)
        await agent_manager.initialize()
        print("✅ Agent manager initialized successfully", file=sys.stderr)
    
    except Exception as e:
        print(f"❌ Error during initialization: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        # Continue with limited functionality
        server = Server("semantic-analysis")
        agent_manager = None
        print("🔄 Running in limited mode without agents", file=sys.stderr)
    
    # Get the analysis engine for backward compatibility
    analysis_engine = agent_manager.get_fallback_engine() if agent_manager else None
    
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
            ),
            # KnowledgeGraphAgent tools
            Tool(
                name="update_knowledge_graph",
                description="Create/update entities and relations in the knowledge graph",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "entities": {
                            "type": "array",
                            "description": "List of entities to create/update",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "entity_type": {"type": "string"},
                                    "significance": {"type": "integer", "minimum": 1, "maximum": 10},
                                    "observations": {"type": "array", "items": {"type": "string"}},
                                    "metadata": {"type": "object", "additionalProperties": True}
                                },
                                "required": ["name", "entity_type"]
                            }
                        },
                        "relations": {
                            "type": "array",
                            "description": "List of relations to create",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "from_entity": {"type": "string"},
                                    "to_entity": {"type": "string"},
                                    "relation_type": {"type": "string"},
                                    "metadata": {"type": "object", "additionalProperties": True}
                                },
                                "required": ["from_entity", "to_entity", "relation_type"]
                            }
                        }
                    },
                    "additionalProperties": False
                }
            ),
            Tool(
                name="search_knowledge_graph",
                description="Search entities in the knowledge graph by query",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query for entities"
                        },
                        "entity_type": {
                            "type": "string",
                            "description": "Filter by entity type (optional)"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of results",
                            "default": 10
                        }
                    },
                    "required": ["query"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="sync_knowledge_sources",
                description="Sync knowledge graph with shared-memory files",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "source_files": {
                            "type": "array",
                            "description": "List of shared-memory files to sync",
                            "items": {"type": "string"}
                        },
                        "direction": {
                            "type": "string",
                            "description": "Sync direction: 'import', 'export', or 'bidirectional'",
                            "enum": ["import", "export", "bidirectional"],
                            "default": "bidirectional"
                        }
                    },
                    "additionalProperties": False
                }
            ),
            Tool(
                name="get_entity_relations",
                description="Get relationships for specific entities",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "entity_names": {
                            "type": "array",
                            "description": "List of entity names to get relations for",
                            "items": {"type": "string"}
                        },
                        "relation_types": {
                            "type": "array",
                            "description": "Filter by relation types (optional)",
                            "items": {"type": "string"}
                        },
                        "depth": {
                            "type": "integer",
                            "description": "Depth of relationship traversal",
                            "default": 1,
                            "minimum": 1,
                            "maximum": 3
                        }
                    },
                    "required": ["entity_names"],
                    "additionalProperties": False
                }
            ),
            # WebSearchAgent tools
            Tool(
                name="search_documentation",
                description="Perform context-aware web searches for documentation",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query"
                        },
                        "context": {
                            "type": "string",
                            "description": "Context to guide the search"
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "Maximum number of results",
                            "default": 5,
                            "minimum": 1,
                            "maximum": 20
                        },
                        "search_provider": {
                            "type": "string",
                            "description": "Search provider to use",
                            "enum": ["duckduckgo", "google"],
                            "default": "duckduckgo"
                        }
                    },
                    "required": ["query"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="extract_web_content",
                description="Extract content from web URLs",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "urls": {
                            "type": "array",
                            "description": "List of URLs to extract content from",
                            "items": {"type": "string", "format": "uri"}
                        },
                        "content_type": {
                            "type": "string",
                            "description": "Type of content to extract",
                            "enum": ["text", "code", "documentation", "all"],
                            "default": "all"
                        }
                    },
                    "required": ["urls"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="validate_references",
                description="Validate documentation references and URLs",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "references": {
                            "type": "array",
                            "description": "List of references to validate",
                            "items": {"type": "string"}
                        },
                        "check_accessibility": {
                            "type": "boolean",
                            "description": "Check if URLs are accessible",
                            "default": True
                        }
                    },
                    "required": ["references"],
                    "additionalProperties": False
                }
            ),
            # SynchronizationAgent tools
            Tool(
                name="sync_all_sources",
                description="Sync between MCP Memory, shared-memory files, and other sources",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "sources": {
                            "type": "array",
                            "description": "List of sources to sync",
                            "items": {
                                "type": "string",
                                "enum": ["mcp_memory", "shared_memory_files", "graphology_db", "ukb"]
                            },
                            "default": ["mcp_memory", "shared_memory_files"]
                        },
                        "direction": {
                            "type": "string",
                            "description": "Sync direction",
                            "enum": ["import", "export", "bidirectional"],
                            "default": "bidirectional"
                        },
                        "backup": {
                            "type": "boolean",
                            "description": "Create backup before sync",
                            "default": True
                        }
                    },
                    "additionalProperties": False
                }
            ),
            Tool(
                name="resolve_conflicts",
                description="Handle synchronization conflicts between sources",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "conflict_entities": {
                            "type": "array",
                            "description": "List of conflicting entity names",
                            "items": {"type": "string"}
                        },
                        "resolution_strategy": {
                            "type": "string",
                            "description": "Strategy for conflict resolution",
                            "enum": ["newest", "manual", "merge", "priority_source"],
                            "default": "newest"
                        },
                        "priority_source": {
                            "type": "string",
                            "description": "Priority source for resolution (if using priority_source strategy)",
                            "enum": ["mcp_memory", "shared_memory_files", "graphology_db", "ukb"]
                        }
                    },
                    "required": ["conflict_entities"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="backup_knowledge",
                description="Create backups of knowledge sources",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "sources": {
                            "type": "array",
                            "description": "Sources to backup",
                            "items": {
                                "type": "string",
                                "enum": ["mcp_memory", "shared_memory_files", "graphology_db", "all"]
                            },
                            "default": ["all"]
                        },
                        "backup_location": {
                            "type": "string",
                            "description": "Backup directory path"
                        },
                        "include_metadata": {
                            "type": "boolean",
                            "description": "Include metadata in backup",
                            "default": True
                        }
                    },
                    "additionalProperties": False
                }
            ),
            # DeduplicationAgent tools
            Tool(
                name="detect_duplicates",
                description="Find similar/duplicate entities in the knowledge graph",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "entity_types": {
                            "type": "array",
                            "description": "Entity types to check for duplicates",
                            "items": {"type": "string"}
                        },
                        "similarity_threshold": {
                            "type": "number",
                            "description": "Similarity threshold (0.0-1.0)",
                            "default": 0.85,
                            "minimum": 0.0,
                            "maximum": 1.0
                        },
                        "comparison_method": {
                            "type": "string",
                            "description": "Method for similarity comparison",
                            "enum": ["semantic", "text", "both"],
                            "default": "both"
                        }
                    },
                    "additionalProperties": False
                }
            ),
            Tool(
                name="merge_entities",
                description="Merge duplicate entities into single entities",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "entity_groups": {
                            "type": "array",
                            "description": "Groups of entities to merge",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "entities": {
                                        "type": "array",
                                        "items": {"type": "string"}
                                    },
                                    "target_name": {"type": "string"},
                                    "merge_strategy": {
                                        "type": "string",
                                        "enum": ["combine", "priority", "newest"],
                                        "default": "combine"
                                    }
                                },
                                "required": ["entities", "target_name"]
                            }
                        },
                        "preserve_history": {
                            "type": "boolean",
                            "description": "Preserve merge history",
                            "default": True
                        }
                    },
                    "required": ["entity_groups"],
                    "additionalProperties": False
                }
            ),
            Tool(
                name="deduplicate_insights",
                description="Remove duplicate insights and observations",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
                            "description": "Scope of deduplication",
                            "enum": ["global", "entity_specific", "type_specific"],
                            "default": "global"
                        },
                        "entity_filter": {
                            "type": "array",
                            "description": "Entity names to filter (for entity_specific scope)",
                            "items": {"type": "string"}
                        },
                        "type_filter": {
                            "type": "array",
                            "description": "Entity types to filter (for type_specific scope)",
                            "items": {"type": "string"}
                        },
                        "similarity_threshold": {
                            "type": "number",
                            "description": "Similarity threshold for insights",
                            "default": 0.9,
                            "minimum": 0.0,
                            "maximum": 1.0
                        }
                    },
                    "additionalProperties": False
                }
            )
        ]
    
    @server.call_tool()
    async def call_tool(name: str, arguments: Dict[str, Any]) -> list[TextContent]:
        """Handle tool calls."""
        
        if name == "test_connection":
            return [TextContent(
                type="text", 
                text="✅ Semantic analysis server connection successful!"
            )]
        
        elif name == "analyze_code":
            code = arguments.get("code", "")
            language = arguments.get("language", "unknown")
            
            # Route through coordinator workflow
            try:
                result = await agent_manager.execute_workflow(
                    "code-analysis", 
                    {
                        "code": code,
                        "language": language,
                        "analysis_type": "code_analysis"
                    }
                )
                
                return [TextContent(
                    type="text",
                    text=f"Code analysis workflow result:\n{json.dumps(result, indent=2)}"
                )]
                
            except Exception as e:
                print(f"⚠️  Workflow execution failed, falling back: {e}", file=sys.stderr)
                
                # Fallback to direct agent if coordinator unavailable
                if 'semantic_analysis' in agent_manager.agents:
                    try:
                        result = await agent_manager.agents['semantic_analysis'].analyze(
                            analysis_type="code_analysis",
                            content=f"Analyze this {language} code for patterns, issues, and architectural insights:\n\n{code}",
                            options={"language": language}
                        )
                        
                        return [TextContent(
                            type="text",
                            text=f"Enhanced code analysis (via agent fallback):\n{json.dumps(result, indent=2)}"
                        )]
                    except Exception as e2:
                        print(f"⚠️  Agent analysis failed, falling back to LLM: {e2}", file=sys.stderr)
                
                # Final fallback to LLM-powered analysis
                prompt = f"Analyze this {language} code for patterns, issues, and architectural insights:"
                
                try:
                    llm_result = await analysis_engine.analyze_with_llm(prompt, code, "code")
                    
                    analysis = {
                        "language": language,
                        "lines": len(code.split('\n')),
                        "characters": len(code),
                        "llm_analysis": llm_result.get("result", "No LLM analysis available"),
                        "provider_used": llm_result.get("provider", "unknown"),
                        "status": "analyzed",
                        "execution_method": "llm_fallback"
                    }
                    
                    return [TextContent(
                        type="text",
                        text=f"Enhanced code analysis complete (fallback):\n{json.dumps(analysis, indent=2)}"
                    )]
                    
                except Exception as e3:
                    # Ultimate fallback to simple analysis
                    analysis = {
                        "language": language,
                        "lines": len(code.split('\n')),
                        "characters": len(code),
                        "error": str(e3),
                        "status": "fallback_analysis"
                    }
                    
                    return [TextContent(
                        type="text",
                        text=f"Code analysis (ultimate fallback):\n{json.dumps(analysis, indent=2)}"
                    )]
        
        elif name == "determine_insights":
            context = arguments.get("context", "")
            
            # Route through coordinator workflow
            try:
                result = await agent_manager.execute_workflow(
                    "insight-generation", 
                    {
                        "context": context,
                        "analysis_type": "insight_generation"
                    }
                )
                
                return [TextContent(
                    type="text",
                    text=f"Insight generation workflow result:\n{json.dumps(result, indent=2)}"
                )]
                
            except Exception as e:
                print(f"⚠️  Insight workflow execution failed, falling back: {e}", file=sys.stderr)
                
                # Fallback to direct LLM analysis
                prompt = "Generate actionable insights from this analysis context:"
                
                try:
                    llm_result = await analysis_engine.analyze_with_llm(prompt, context, "insight_generation")
                    
                    insight = {
                        "context": context,
                        "llm_insights": llm_result.get("result", "No LLM insights available"),
                        "provider_used": llm_result.get("provider", "unknown"),
                        "confidence": 0.95,
                        "status": "complete",
                        "execution_method": "llm_fallback"
                    }
                    
                    return [TextContent(
                        type="text", 
                        text=f"Enhanced insights determined (fallback):\n{json.dumps(insight, indent=2)}"
                    )]
                    
                except Exception as e2:
                    # Ultimate fallback to simple insight
                    insight = {
                        "context": context,
                        "insight": "Enhanced MCP server with LLM integration",
                        "error": str(e2),
                        "confidence": 0.5,
                        "status": "fallback"
                    }
                    
                    return [TextContent(
                        type="text", 
                        text=f"Insights (ultimate fallback):\n{json.dumps(insight, indent=2)}"
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
            analysis_result = arguments.get("analysis_result", {})
            metadata = arguments.get("metadata", {})
            
            try:
                if 'documentation' in agent_manager.agents:
                    doc_agent = agent_manager.agents['documentation']
                    result = await doc_agent.handle_event("generate_analysis_doc", {
                        "analysis_result": analysis_result,
                        "metadata": metadata
                    })
                    
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
                    
                    if diagram_result.get("success"):
                        # Convert to PNG
                        png_result = await doc_agent.handle_event("convert_puml_to_png", {
                            "puml_file": diagram_result["puml_file"]
                        })
                        
                        result = {
                            "diagram_generated": diagram_result,
                            "png_conversion": png_result
                        }
                    else:
                        result = diagram_result
                    
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
        
        # KnowledgeGraphAgent tool handlers
        elif name == "update_knowledge_graph":
            entities = arguments.get("entities", [])
            relations = arguments.get("relations", [])
            
            if 'knowledge_graph' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['knowledge_graph'].update_knowledge_graph(
                        entities=entities,
                        relations=relations
                    )
                    return [TextContent(
                        type="text",
                        text=f"Knowledge graph update result:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Knowledge graph update error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Knowledge graph agent not available"
                )]
        
        elif name == "search_knowledge_graph":
            query = arguments.get("query", "")
            entity_type = arguments.get("entity_type")
            limit = arguments.get("limit", 10)
            
            if 'knowledge_graph' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['knowledge_graph'].search_entities(
                        query=query,
                        entity_type=entity_type,
                        limit=limit
                    )
                    return [TextContent(
                        type="text",
                        text=f"Knowledge graph search results:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Knowledge graph search error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Knowledge graph agent not available"
                )]
        
        elif name == "sync_knowledge_sources":
            source_files = arguments.get("source_files", [])
            direction = arguments.get("direction", "bidirectional")
            
            if 'knowledge_graph' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['knowledge_graph'].sync_knowledge_sources(
                        source_files=source_files,
                        direction=direction
                    )
                    return [TextContent(
                        type="text",
                        text=f"Knowledge source sync result:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Knowledge source sync error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Knowledge graph agent not available"
                )]
        
        elif name == "get_entity_relations":
            entity_names = arguments.get("entity_names", [])
            relation_types = arguments.get("relation_types")
            depth = arguments.get("depth", 1)
            
            if 'knowledge_graph' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['knowledge_graph'].get_entity_relations(
                        entity_names=entity_names,
                        relation_types=relation_types,
                        depth=depth
                    )
                    return [TextContent(
                        type="text",
                        text=f"Entity relations result:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Entity relations error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Knowledge graph agent not available"
                )]
        
        # WebSearchAgent tool handlers
        elif name == "search_documentation":
            query = arguments.get("query", "")
            context = arguments.get("context", "")
            max_results = arguments.get("max_results", 5)
            search_provider = arguments.get("search_provider", "duckduckgo")
            
            if 'web_search' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['web_search'].search_documentation(
                        query=query,
                        context=context,
                        max_results=max_results,
                        search_provider=search_provider
                    )
                    return [TextContent(
                        type="text",
                        text=f"Documentation search results:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Documentation search error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Web search agent not available"
                )]
        
        elif name == "extract_web_content":
            urls = arguments.get("urls", [])
            content_type = arguments.get("content_type", "all")
            
            if 'web_search' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['web_search'].extract_web_content(
                        urls=urls,
                        content_type=content_type
                    )
                    return [TextContent(
                        type="text",
                        text=f"Web content extraction results:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Web content extraction error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Web search agent not available"
                )]
        
        elif name == "validate_references":
            references = arguments.get("references", [])
            check_accessibility = arguments.get("check_accessibility", True)
            
            if 'web_search' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['web_search'].validate_references(
                        references=references,
                        check_accessibility=check_accessibility
                    )
                    return [TextContent(
                        type="text",
                        text=f"Reference validation results:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Reference validation error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Web search agent not available"
                )]
        
        # SynchronizationAgent tool handlers
        elif name == "sync_all_sources":
            sources = arguments.get("sources", ["mcp_memory", "shared_memory_files"])
            direction = arguments.get("direction", "bidirectional")
            backup = arguments.get("backup", True)
            
            if 'synchronization' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['synchronization'].sync_all_sources(
                        sources=sources,
                        direction=direction,
                        backup=backup
                    )
                    return [TextContent(
                        type="text",
                        text=f"Source synchronization result:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Source synchronization error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Synchronization agent not available"
                )]
        
        elif name == "resolve_conflicts":
            conflict_entities = arguments.get("conflict_entities", [])
            resolution_strategy = arguments.get("resolution_strategy", "newest")
            priority_source = arguments.get("priority_source")
            
            if 'synchronization' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['synchronization'].resolve_conflicts(
                        conflict_entities=conflict_entities,
                        resolution_strategy=resolution_strategy,
                        priority_source=priority_source
                    )
                    return [TextContent(
                        type="text",
                        text=f"Conflict resolution result:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Conflict resolution error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Synchronization agent not available"
                )]
        
        elif name == "backup_knowledge":
            sources = arguments.get("sources", ["all"])
            backup_location = arguments.get("backup_location", "")
            include_metadata = arguments.get("include_metadata", True)
            
            if 'synchronization' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['synchronization'].backup_knowledge(
                        sources=sources,
                        backup_location=backup_location,
                        include_metadata=include_metadata
                    )
                    return [TextContent(
                        type="text",
                        text=f"Knowledge backup result:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Knowledge backup error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Synchronization agent not available"
                )]
        
        # DeduplicationAgent tool handlers
        elif name == "detect_duplicates":
            entity_types = arguments.get("entity_types", [])
            similarity_threshold = arguments.get("similarity_threshold", 0.85)
            comparison_method = arguments.get("comparison_method", "both")
            
            if 'deduplication' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['deduplication'].detect_duplicates(
                        entity_types=entity_types,
                        similarity_threshold=similarity_threshold,
                        comparison_method=comparison_method
                    )
                    return [TextContent(
                        type="text",
                        text=f"Duplicate detection result:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Duplicate detection error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Deduplication agent not available"
                )]
        
        elif name == "merge_entities":
            entity_groups = arguments.get("entity_groups", [])
            preserve_history = arguments.get("preserve_history", True)
            
            if 'deduplication' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['deduplication'].merge_entities(
                        entity_groups=entity_groups,
                        preserve_history=preserve_history
                    )
                    return [TextContent(
                        type="text",
                        text=f"Entity merge result:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Entity merge error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Deduplication agent not available"
                )]
        
        elif name == "deduplicate_insights":
            scope = arguments.get("scope", "global")
            entity_filter = arguments.get("entity_filter", [])
            type_filter = arguments.get("type_filter", [])
            similarity_threshold = arguments.get("similarity_threshold", 0.9)
            
            if 'deduplication' in agent_manager.agents:
                try:
                    result = await agent_manager.agents['deduplication'].deduplicate_insights(
                        scope=scope,
                        entity_filter=entity_filter,
                        type_filter=type_filter,
                        similarity_threshold=similarity_threshold
                    )
                    return [TextContent(
                        type="text",
                        text=f"Insight deduplication result:\n{json.dumps(result, indent=2)}"
                    )]
                except Exception as e:
                    return [TextContent(
                        type="text",
                        text=f"Insight deduplication error: {str(e)}"
                    )]
            else:
                return [TextContent(
                    type="text",
                    text="Deduplication agent not available"
                )]
        
        else:
            return [TextContent(
                type="text",
                text=f"Unknown tool: {name}"
            )]
    
    # Log Python executable verification to the log file
    log_file_path = Path(__file__).parent / "logs" / "semantic_analysis.log"
    log_file_path.parent.mkdir(exist_ok=True)
    
    startup_log_entry = {
        "timestamp": datetime.datetime.now().isoformat(),
        "level": "info",
        "event": "MCP Server Startup - Python Executable Verification",
        "python_executable": sys.executable,
        "python_version": sys.version.split()[0],
        "virtual_env": os.getenv('VIRTUAL_ENV', 'Not detected'),
        "is_venv_python": 'venv' in sys.executable,
        "executable_contains_venv": 'venv' in sys.executable,
        "startup_verification": "✅ VENV PYTHON" if 'venv' in sys.executable else "❌ SYSTEM PYTHON",
        "logger": "mcp_server_startup"
    }
    
    try:
        with open(log_file_path, 'a') as f:
            f.write(f"[info     ] {json.dumps(startup_log_entry)} [mcp_server_startup]\n")
    except Exception as e:
        print(f"⚠️  Could not write to log file: {e}", file=sys.stderr)

    # Run the server with proper async context and error handling
    try:
        print("🚀 Starting MCP server...", file=sys.stderr)
        async with stdio_server() as (read_stream, write_stream):
            print("✅ MCP server stdio transport established", file=sys.stderr)
            await server.run(
                read_stream, 
                write_stream, 
                server.create_initialization_options()
            )
    except KeyboardInterrupt:
        print("🔄 Received shutdown signal", file=sys.stderr)
    except Exception as e:
        print(f"❌ MCP server error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
    finally:
        if agent_manager:
            print("🔄 Shutting down agents...", file=sys.stderr)
            try:
                await agent_manager.shutdown()
                print("✅ Agents shutdown complete", file=sys.stderr)
            except Exception as e:
                print(f"⚠️  Error during shutdown: {e}", file=sys.stderr)


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())