"""
Semantic Analysis Agent
Core LLM-powered analysis with 3-tier API key fallback system
"""

import asyncio
import os
import sys
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional, List, Union
import json

from .base import BaseAgent
from config.api_keys import APIKeyManager, ProviderType


class LLMProvider:
    """Base class for LLM providers."""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        
    async def analyze(self, prompt: str, content: str, options: Dict[str, Any] = None) -> Dict[str, Any]:
        """Analyze content with the LLM."""
        raise NotImplementedError
        
    def validate_config(self) -> bool:
        """Validate provider configuration."""
        raise NotImplementedError
        
    def get_info(self) -> Dict[str, Any]:
        """Get provider information."""
        return {
            "name": self.__class__.__name__,
            "config": self.config
        }


class ClaudeProvider(LLMProvider):
    """Claude (Anthropic) LLM provider."""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.api_key = os.getenv("ANTHROPIC_API_KEY")
        
    def validate_config(self) -> bool:
        is_valid = bool(self.api_key and self.api_key != "your-anthropic-api-key")
        if not is_valid:
            print(f"⚠️  Claude provider validation failed: api_key={bool(self.api_key)}, is_placeholder={self.api_key == 'your-anthropic-api-key' if self.api_key else 'N/A'}", file=sys.stderr)
        return is_valid
    
    async def analyze(self, prompt: str, content: str, options: Dict[str, Any] = None) -> Dict[str, Any]:
        """Analyze content using Claude API."""
        if not self.validate_config():
            raise ValueError("Claude API key not configured")
        
        try:
            # Import anthropic here to avoid dependency issues if not installed
            import anthropic
            
            client = anthropic.Anthropic(api_key=self.api_key)
            
            system_prompt = self._build_system_prompt(options.get("analysis_type", "general") if options else "general")
            user_prompt = f"{prompt}\n\n=== CONTENT TO ANALYZE ===\n{content}"
            
            response = await asyncio.to_thread(
                client.messages.create,
                model=options.get("model", "claude-3-sonnet-20240229") if options else "claude-3-sonnet-20240229",
                max_tokens=options.get("max_tokens", 4096) if options else 4096,
                temperature=options.get("temperature", 0.3) if options else 0.3,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}]
            )
            
            result = self._parse_response(response.content[0].text, options or {})
            
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
    
    def _build_system_prompt(self, analysis_type: str) -> str:
        """Build system prompt for Claude."""
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
    
    def _parse_response(self, response_text: str, options: Dict[str, Any]) -> Dict[str, Any]:
        """Parse Claude's response."""
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
            structured[key] = match.group(2).strip()
        
        return structured if structured else None


class OpenAIProvider(LLMProvider):
    """OpenAI LLM provider (includes custom OpenAI-compatible endpoints)."""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.api_key = os.getenv("OPENAI_API_KEY")
        self.base_url = os.getenv("OPENAI_BASE_URL") or config.get("base_url")
        
    def validate_config(self) -> bool:
        return bool(self.api_key and self.api_key != "your-openai-api-key")
    
    async def analyze(self, prompt: str, content: str, options: Dict[str, Any] = None) -> Dict[str, Any]:
        """Analyze content using OpenAI API."""
        if not self.validate_config():
            raise ValueError("OpenAI API key not configured")
        
        try:
            # Import openai here to avoid dependency issues if not installed
            import openai
            
            client = openai.AsyncOpenAI(
                api_key=self.api_key,
                base_url=self.base_url
            )
            
            system_prompt = self._build_system_prompt(options.get("analysis_type", "general") if options else "general")
            user_prompt = f"{prompt}\n\n=== CONTENT TO ANALYZE ===\n{content}"
            
            response = await client.chat.completions.create(
                model=options.get("model", "gpt-4") if options else "gpt-4",
                max_tokens=options.get("max_tokens", 4096) if options else 4096,
                temperature=options.get("temperature", 0.3) if options else 0.3,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ]
            )
            
            result = self._parse_response(response.choices[0].message.content, options or {})
            
            return {
                "success": True,
                "result": result,
                "provider": "openai" if not self.base_url else "custom_openai",
                "usage": response.usage.dict() if response.usage else None
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "provider": "openai" if not self.base_url else "custom_openai"
            }
    
    def _build_system_prompt(self, analysis_type: str) -> str:
        """Build system prompt for OpenAI."""
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
    
    def _parse_response(self, response_text: str, options: Dict[str, Any]) -> Dict[str, Any]:
        """Parse OpenAI's response."""
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
            structured[key] = match.group(2).strip()
        
        return structured if structured else None


class SemanticAnalysisAgent(BaseAgent):
    """
    Core semantic analysis agent with 3-tier API key fallback system.
    
    Fallback chain:
    1. ANTHROPIC_API_KEY (Claude) - Primary
    2. OPENAI_API_KEY (OpenAI) - Secondary  
    3. OPENAI_BASE_URL + OPENAI_API_KEY (Custom OpenAI-compatible) - Tertiary
    4. UKB-CLI fallback mode (no AI) - Final fallback
    """
    
    def __init__(self, name: str, config: Dict[str, Any], system: Any):
        super().__init__(name, config, system)
        
        self.api_key_manager = APIKeyManager()
        self.providers = {}
        self.primary_provider = None
        self.fallback_provider = None
        self.analysis_cache = {}
        
        # Register capabilities
        self.register_capability("code_analysis")
        self.register_capability("conversation_analysis")
        self.register_capability("pattern_extraction")
        self.register_capability("significance_scoring")
        self.register_capability("insight_generation")
    
    async def on_initialize(self):
        """Initialize the semantic analysis agent."""
        self.logger.info("Initializing semantic analysis agent with 3-tier API fallback...")
        
        # Initialize LLM providers
        await self._initialize_providers()
        
        # Register event handlers
        self._register_event_handlers()
        
        self.logger.info(
            "Semantic analysis agent initialized",
            primary_provider=self.primary_provider.get_info()["name"] if self.primary_provider else "UKB-CLI",
            fallback_available=bool(self.fallback_provider),
            fallback_mode=not bool(self.primary_provider)
        )
    
    async def _initialize_providers(self):
        """Initialize LLM providers based on available API keys."""
        self.api_key_manager.detect_available_providers()
        status = self.api_key_manager.get_status_report()
        
        self.logger.info(
            "API key status",
            has_ai=status["has_ai_providers"],
            chain=status["fallback_chain"],
            provider_details=status["provider_details"]
        )
        
        if not status["has_ai_providers"]:
            self.logger.warning(
                "🔴 FALLBACK TRIGGER: No AI providers available - using UKB-CLI fallback mode",
                reason="No valid API keys found",
                provider_details=status["provider_details"],
                env_vars_checked=["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
                cwd=os.getcwd(),
                env_path=os.getenv("PATH", "NOT SET")
            )
            return
        
        # Initialize providers in order of preference
        fallback_chain = self.api_key_manager.get_fallback_chain()
        
        for provider_type in fallback_chain:
            if provider_type == ProviderType.FALLBACK:
                continue  # Skip UKB fallback for now
                
            try:
                if provider_type == ProviderType.ANTHROPIC:
                    provider = ClaudeProvider(self.config.get("llm_providers", {}))
                elif provider_type in (ProviderType.OPENAI, ProviderType.CUSTOM_OPENAI):
                    provider = OpenAIProvider(self.config.get("llm_providers", {}))
                else:
                    continue
                
                if provider.validate_config():
                    self.providers[provider_type] = provider
                    
                    if not self.primary_provider:
                        self.primary_provider = provider
                        self.logger.info(f"Primary provider: {provider_type.value}")
                        print(f"✅ Primary provider set: {provider_type.value}", file=sys.stderr)
                    elif not self.fallback_provider:
                        self.fallback_provider = provider
                        self.logger.info(f"Fallback provider: {provider_type.value}")
                        print(f"✅ Fallback provider set: {provider_type.value}", file=sys.stderr)
                else:
                    self.logger.warning(f"Provider {provider_type.value} failed validation")
                    print(f"❌ Provider {provider_type.value} failed validation", file=sys.stderr)
                
            except Exception as e:
                self.logger.warning(f"Failed to initialize {provider_type.value} provider", error=str(e))
    
    def _register_event_handlers(self):
        """Register event handlers for this agent."""
        self.register_event_handler("analyze_code", self._handle_code_analysis)
        self.register_event_handler("analyze_conversation", self._handle_conversation_analysis)
        self.register_event_handler("extract_patterns", self._handle_pattern_extraction)
        self.register_event_handler("score_significance", self._handle_significance_scoring)
        self.register_event_handler("generate_insights", self._handle_insight_generation)
        
        # Missing workflow action handlers
        self.register_event_handler("analyze_repository", self._handle_analyze_repository)
        self.register_event_handler("analyze_changes", self._handle_analyze_changes)
        self.register_event_handler("extract_insights", self._handle_extract_insights)
        self.register_event_handler("analyze_patterns", self._handle_analyze_patterns)
        self.register_event_handler("analyze_insights", self._handle_analyze_insights)
    
    async def analyze(self, analysis_type: str, content: str, options: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Perform analysis with automatic fallback through the provider chain.
        """
        options = options or {}
        
        # Check cache first
        cache_key = f"{analysis_type}:{hash(content)}:{hash(str(options))}"
        if cache_key in self.analysis_cache:
            cache_ttl = self.config.get("llm_providers", {}).get("cache_ttl", 300)
            cache_entry = self.analysis_cache[cache_key]
            if asyncio.get_event_loop().time() - cache_entry["timestamp"] < cache_ttl:
                self.logger.debug("Returning cached analysis result")
                return cache_entry["result"]
        
        # Build prompt based on analysis type
        prompt = self._build_prompt(analysis_type, options)
        
        # Try primary provider first
        if self.primary_provider:
            try:
                self.logger.debug("Attempting analysis with primary provider")
                result = await self.primary_provider.analyze(prompt, content, options)
                
                if result.get("success"):
                    # Cache successful result
                    self.analysis_cache[cache_key] = {
                        "result": result,
                        "timestamp": asyncio.get_event_loop().time()
                    }
                    return result
                else:
                    self.logger.warning(
                        "🟡 FALLBACK TRIGGER: Primary provider failed",
                        provider=self.primary_provider.get_info()["name"],
                        error=result.get("error"),
                        reason="Primary provider returned unsuccessful result"
                    )
                    
            except Exception as e:
                self.logger.warning(
                    "🟡 FALLBACK TRIGGER: Primary provider exception",
                    provider=self.primary_provider.get_info()["name"],
                    error=str(e),
                    error_type=type(e).__name__,
                    reason="Exception during primary provider execution"
                )
        
        # Try fallback provider
        if self.fallback_provider:
            try:
                self.logger.info("Using fallback provider")
                result = await self.fallback_provider.analyze(prompt, content, options)
                
                if result.get("success"):
                    # Cache successful result
                    self.analysis_cache[cache_key] = {
                        "result": result,
                        "timestamp": asyncio.get_event_loop().time()
                    }
                    return result
                else:
                    self.logger.warning("Fallback provider failed", error=result.get("error"))
                    
            except Exception as e:
                self.logger.warning("Fallback provider exception", error=str(e))
        
        # Final fallback to UKB-CLI mode
        self.logger.warning(
            "🔴 FINAL FALLBACK TRIGGER: Using UKB-CLI fallback mode",
            reason="All AI providers failed or unavailable",
            analysis_type=analysis_type,
            content_length=len(content),
            primary_available=bool(self.primary_provider),
            fallback_available=bool(self.fallback_provider),
            options=options
        )
        return await self._ukb_fallback_analysis(analysis_type, content, options)
    
    async def _ukb_fallback_analysis(self, analysis_type: str, content: str, options: Dict[str, Any]) -> Dict[str, Any]:
        """Fallback analysis using UKB-CLI when no AI providers are available."""
        try:
            # Get UKB path from system config
            ukb_path = self.config.get("ukb_integration", {}).get("ukb_path")
            if not ukb_path:
                # Try to find UKB in the system
                coding_tools_path = os.getenv("CODING_TOOLS_PATH")
                if coding_tools_path:
                    ukb_path = os.path.join(coding_tools_path, "bin", "ukb")
                else:
                    ukb_path = "ukb"  # Hope it's in PATH
            
            # Create a temporary entity for UKB
            entity_data = self._convert_to_ukb_format(analysis_type, content, options)
            
            # Write entity data to temporary file
            import tempfile
            with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
                json.dump(entity_data, f, indent=2)
                temp_file = f.name
            
            try:
                # Execute UKB command using interactive mode
                input_data = f"{entity_data['name']}\n{entity_data['entityType']}\n{entity_data['significance']}\n{entity_data.get('observation', 'Analysis from semantic agent')}\n"
                
                cmd = [ukb_path, "--add-entity"]
                result = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                
                stdout, stderr = await result.communicate(input=input_data.encode())
                
                if result.returncode == 0:
                    return {
                        "success": True,
                        "result": {
                            "analysis": f"Analysis completed using UKB-CLI fallback mode for {analysis_type}",
                            "entity_created": entity_data,
                            "ukb_output": stdout.decode() if stdout else "",
                            "fallback_mode": True
                        },
                        "provider": "ukb_fallback"
                    }
                else:
                    error_msg = stderr.decode() if stderr else "Unknown UKB error"
                    return {
                        "success": False,
                        "error": f"UKB command failed: {error_msg}",
                        "provider": "ukb_fallback"
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
                "error": f"UKB fallback failed: {str(e)}",
                "provider": "ukb_fallback"
            }
    
    def _convert_to_ukb_format(self, analysis_type: str, content: str, options: Dict[str, Any]) -> Dict[str, Any]:
        """Convert analysis request to UKB entity format."""
        import time
        timestamp = time.strftime("%Y-%m-%d_%H-%M-%S")
        
        return {
            "name": f"{analysis_type}_fallback_{timestamp}",
            "entityType": "TechnicalPattern",
            "significance": options.get("significance", 5),
            "observations": [
                f"Analysis type: {analysis_type}",
                f"Content length: {len(content)} characters",
                f"Content preview: {content[:200]}..." if len(content) > 200 else content,
                f"Processed in UKB-CLI fallback mode (no AI providers available)",
                f"Options: {json.dumps(options)}",
                f"Timestamp: {timestamp}"
            ],
            "metadata": {
                "source": "semantic-analysis-fallback",
                "analysis_type": analysis_type,
                "fallback_mode": True,
                "created": timestamp,
                "options": options
            }
        }
    
    def _build_prompt(self, analysis_type: str, options: Dict[str, Any]) -> str:
        """Build analysis prompt based on type and options."""
        prompts = {
            "code": """Analyze this code for architectural patterns, design decisions, and technical significance.
Focus on:
1. Architectural patterns used
2. Design decisions and rationales
3. Code quality and maintainability
4. Technical debt indicators
5. Reusable patterns and best practices

Provide structured analysis with significance scoring (1-10).""",

            "conversation": """Analyze this conversation for technical insights, decisions, and patterns.
Focus on:
1. Key technical decisions made
2. Problem-solution patterns discussed
3. Architectural considerations
4. Learning outcomes and insights
5. Actionable recommendations
6. Technology mentions and evaluations

Extract main topics, decision rationales, and transferable insights.""",

            "pattern_extraction": """Extract and identify specific patterns from the content.
Focus on:
1. Recurring patterns and structures
2. Best practices and anti-patterns
3. Implementation patterns
4. Design patterns
5. Architectural patterns

Categorize patterns with examples and significance levels.""",

            "significance_scoring": """Evaluate the technical significance of this content on a scale of 1-10.
Consider:
- Architectural impact (1-3 points)
- Complexity and scope (1-2 points)
- Reusability and applicability (1-2 points)
- Innovation and uniqueness (1-2 points)
- Documentation and knowledge value (1-1 point)

Provide detailed scoring rationale.""",

            "insight_generation": """Generate actionable insights from the provided content.
Focus on:
- Problem-solution patterns
- Architectural decisions and rationales
- Reusable patterns and best practices
- Technical debt and improvement opportunities
- Key learnings and takeaways

Structure insights with applicability and significance."""
        }
        
        return prompts.get(analysis_type, prompts["code"])
    
    # Event handlers
    async def _handle_code_analysis(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle code analysis requests."""
        repository = data.get("repository")
        if not repository:
            raise ValueError("Repository path required for code analysis")
        
        # Analyze recent commits or files based on options
        content = await self._extract_code_content(repository, data)
        
        return await self.analyze("code", content, data.get("options", {}))
    
    async def _handle_conversation_analysis(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle conversation analysis requests."""
        conversation_path = data.get("conversation_path")
        if not conversation_path:
            raise ValueError("Conversation path required")
        
        # Read conversation content
        content = await self._read_file(conversation_path)
        
        return await self.analyze("conversation", content, data.get("options", {}))
    
    async def _handle_pattern_extraction(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle pattern extraction requests."""
        content = data.get("content")
        if not content:
            raise ValueError("Content required for pattern extraction")
        
        options = data.get("options", {})
        options["patterns"] = data.get("patterns", [])
        
        return await self.analyze("pattern_extraction", content, options)
    
    async def _handle_significance_scoring(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle significance scoring requests."""
        content = data.get("content")
        if not content:
            raise ValueError("Content required for significance scoring")
        
        return await self.analyze("significance_scoring", content, data.get("options", {}))
    
    async def _handle_insight_generation(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle insight generation requests."""
        content = data.get("content")
        if not content:
            raise ValueError("Content required for insight generation")
        
        return await self.analyze("insight_generation", content, data.get("options", {}))
    
    # Helper methods
    async def _extract_code_content(self, repository: str, options: Dict[str, Any]) -> str:
        """Extract comprehensive code content from repository for analysis."""
        try:
            # Use git to get recent commits
            depth = options.get("depth", 10)
            cmd = ["git", "-C", repository, "log", "--oneline", f"-{depth}"]
            
            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await result.communicate()
            
            if result.returncode == 0:
                return stdout.decode()
            else:
                # Fallback to directory listing
                return f"Repository analysis for: {repository}\nError accessing git history: {stderr.decode()}"
                
        except Exception as e:
            return f"Repository analysis for: {repository}\nError: {str(e)}"
    
    async def _read_file(self, file_path: str) -> str:
        """Read file content asynchronously."""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception as e:
            raise ValueError(f"Failed to read file {file_path}: {str(e)}")
    
    async def _handle_analyze_repository(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Analyze entire repository structure and content."""
        parameters = data.get("parameters", {})
        path = parameters.get("path", ".")
        
        self.logger.info("Starting repository analysis", path=path)
        
        # Use existing analyze method for repository analysis
        try:
            import os
            # Collect all code files
            code_content = []
            for root, dirs, files in os.walk(path):
                for file in files:
                    if file.endswith(('.py', '.js', '.ts', '.java', '.cpp', '.c', '.go', '.rs')):
                        file_path = os.path.join(root, file)
                        try:
                            with open(file_path, 'r', encoding='utf-8') as f:
                                content = f.read()
                                code_content.append(f"File: {file_path}\n{content}\n\n")
                        except Exception:
                            continue
            
            combined_content = "\n".join(code_content[:50])  # Limit to first 50 files
            result = await self.analyze("repository", combined_content, {
                "analysis_type": "repository",
                "path": path
            })
            
            return {
                "status": "repository_analyzed",
                "files_analyzed": len(code_content),
                "analysis_result": result,
                "path": path
            }
            
        except Exception as e:
            return {
                "status": "analysis_failed",
                "error": str(e),
                "path": path
            }
    
    async def _handle_analyze_changes(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Analyze changes detected in the repository."""
        parameters = data.get("parameters", {})
        previous_results = data.get("previous_results", {})
        
        self.logger.info("Analyzing detected changes")
        
        # For now, use the change detection results from coordinator
        changes_detected = previous_results.get("changes_detected", True)
        change_count = previous_results.get("change_count", 1)
        
        if not changes_detected:
            return {
                "status": "no_changes",
                "change_count": 0,
                "analysis_skipped": True
            }
        
        # Perform incremental analysis
        path = parameters.get("path", ".")
        result = await self.analyze("changes", f"Analyzing {change_count} changes in {path}", {
            "analysis_type": "incremental",
            "change_count": change_count
        })
        
        return {
            "status": "changes_analyzed",
            "change_count": change_count,
            "analysis_result": result
        }
    
    async def _handle_extract_insights(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Extract insights from conversation or analysis data."""
        parameters = data.get("parameters", {})
        previous_results = data.get("previous_results", {})
        
        # Get prepared conversation data
        conversation_data = previous_results.get("prepared_data", "")
        if not conversation_data:
            conversation_data = parameters.get("conversation", "")
        
        self.logger.info("Extracting insights from conversation")
        
        # Use existing insight generation handler
        return await self._handle_insight_generation({
            "content": conversation_data,
            "context": previous_results
        })
    
    async def _handle_analyze_patterns(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Analyze patterns from repository or conversation data."""
        parameters = data.get("parameters", {})
        previous_results = data.get("previous_results", {})
        
        self.logger.info("Analyzing patterns")
        
        # Get content to analyze patterns from
        analysis_result = previous_results.get("analysis_result", {})
        content = str(analysis_result) if analysis_result else ""
        
        # Use existing pattern extraction handler
        return await self._handle_pattern_extraction({
            "content": content,
            "context": previous_results
        })
    
    async def _handle_analyze_insights(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Analyze and score insights for significance."""
        parameters = data.get("parameters", {})
        previous_results = data.get("previous_results", {})
        
        self.logger.info("Analyzing insights for significance")
        
        # Get insights from previous results
        insights = previous_results.get("insights", [])
        if not insights:
            insights = previous_results.get("analysis_result", {}).get("insights", [])
        
        # Score each insight
        scored_insights = []
        for insight in insights:
            score_result = await self._handle_significance_scoring({
                "content": str(insight),
                "context": previous_results
            })
            scored_insights.append({
                "insight": insight,
                "significance": score_result.get("significance", 5)
            })
        
        return {
            "status": "insights_analyzed",
            "total_insights": len(insights),
            "scored_insights": scored_insights,
            "average_significance": sum(i["significance"] for i in scored_insights) / max(len(scored_insights), 1)
        }

    async def health_check(self) -> Dict[str, Any]:
        """Check agent health including provider status."""
        base_health = await super().health_check()
        
        provider_health = {}
        for provider_type, provider in self.providers.items():
            try:
                provider_health[provider_type.value] = {
                    "available": provider.validate_config(),
                    "info": provider.get_info()
                }
            except Exception as e:
                provider_health[provider_type.value] = {
                    "available": False,
                    "error": str(e)
                }
        
        return {
            **base_health,
            "providers": provider_health,
            "primary_provider": self.primary_provider.get_info() if self.primary_provider else None,
            "fallback_provider": self.fallback_provider.get_info() if self.fallback_provider else None,
            "cache_size": len(self.analysis_cache)
        }
    
    async def on_shutdown(self):
        """Clean up resources on shutdown."""
        # Clear analysis cache
        self.analysis_cache.clear()
        
        # Clear providers
        self.providers.clear()
        self.primary_provider = None
        self.fallback_provider = None