"""
Semantic Analysis Agent
Core LLM-powered analysis with 3-tier API key fallback system
"""

import asyncio
import os
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
        return bool(self.api_key and self.api_key != "your-anthropic-api-key")
    
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
            chain=status["fallback_chain"]
        )
        
        if not status["has_ai_providers"]:
            self.logger.warning("No AI providers available - using UKB-CLI fallback mode")
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
                    elif not self.fallback_provider:
                        self.fallback_provider = provider
                        self.logger.info(f"Fallback provider: {provider_type.value}")
                
            except Exception as e:
                self.logger.warning(f"Failed to initialize {provider_type.value} provider", error=str(e))
    
    def _register_event_handlers(self):
        """Register event handlers for this agent."""
        self.register_event_handler("analyze_code", self._handle_code_analysis)
        self.register_event_handler("analyze_conversation", self._handle_conversation_analysis)
        self.register_event_handler("extract_patterns", self._handle_pattern_extraction)
        self.register_event_handler("score_significance", self._handle_significance_scoring)
        self.register_event_handler("generate_insights", self._handle_insight_generation)
    
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
                    self.logger.warning("Primary provider failed", error=result.get("error"))
                    
            except Exception as e:
                self.logger.warning("Primary provider exception", error=str(e))
        
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
        self.logger.info("Using UKB-CLI fallback mode")
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
                input_text = f"{entity_data['name']}\n{entity_data['entityType']}\n{entity_data['significance']}\n{entity_data['observations'][0]}"
                
                cmd = [ukb_path, "--interactive"]
                result = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                
                stdout, stderr = await result.communicate(input=input_text.encode())
                
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
            # Perform comprehensive repository analysis
            git_analysis = await self._analyze_git_history(repository, options)
            session_analysis = await self._analyze_session_logs(repository, options)
            code_structure = await self._analyze_code_structure(repository, options)
            
            # Combine all analysis
            combined_content = f"""
# Comprehensive Repository Analysis for: {repository}

## Git History Analysis
{git_analysis}

## Session Logs Analysis  
{session_analysis}

## Code Structure Analysis
{code_structure}
"""
            return combined_content
                
        except Exception as e:
            return f"Repository analysis for: {repository}\nError: {str(e)}"

    async def _analyze_git_history(self, repository: str, options: Dict[str, Any]) -> str:
        """Perform comprehensive git history analysis."""
        try:
            depth = options.get("depth", 50)
            since_date = options.get("since_date", "1 month ago")
            
            # Get comprehensive git log with stats
            cmd = [
                "git", "-C", repository, "log", 
                f"--since={since_date}",
                f"-{depth}",
                "--stat",
                "--format=fuller", 
                "--show-notes"
            ]
            
            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await result.communicate()
            
            if result.returncode != 0:
                return f"Error accessing git history: {stderr.decode()}"
            
            git_log = stdout.decode()
            
            # Get commit authors and stats
            author_stats = await self._get_git_author_stats(repository, since_date)
            file_changes = await self._get_git_file_changes(repository, since_date)
            branch_info = await self._get_git_branch_info(repository)
            
            return f"""
### Git Commit History ({depth} commits since {since_date})
{git_log}

### Author Statistics
{author_stats}

### File Change Patterns
{file_changes}

### Branch Information
{branch_info}
"""
                
        except Exception as e:
            return f"Git history analysis error: {str(e)}"

    async def _get_git_author_stats(self, repository: str, since_date: str) -> str:
        """Get git author statistics."""
        try:
            cmd = [
                "git", "-C", repository, "shortlog", 
                f"--since={since_date}",
                "-sn"
            ]
            
            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await result.communicate()
            
            if result.returncode == 0:
                return stdout.decode()
            else:
                return f"Error getting author stats: {stderr.decode()}"
                
        except Exception as e:
            return f"Author stats error: {str(e)}"

    async def _get_git_file_changes(self, repository: str, since_date: str) -> str:
        """Get git file change patterns."""
        try:
            cmd = [
                "git", "-C", repository, "log", 
                f"--since={since_date}",
                "--name-status",
                "--pretty=format:"
            ]
            
            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await result.communicate()
            
            if result.returncode == 0:
                return stdout.decode()
            else:
                return f"Error getting file changes: {stderr.decode()}"
                
        except Exception as e:
            return f"File changes error: {str(e)}"

    async def _get_git_branch_info(self, repository: str) -> str:
        """Get git branch information."""
        try:
            cmd = ["git", "-C", repository, "branch", "-a", "-v"]
            
            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await result.communicate()
            
            if result.returncode == 0:
                return stdout.decode()
            else:
                return f"Error getting branch info: {stderr.decode()}"
                
        except Exception as e:
            return f"Branch info error: {str(e)}"

    async def _analyze_session_logs(self, repository: str, options: Dict[str, Any]) -> str:
        """Analyze .specstory session logs for insights."""
        try:
            from pathlib import Path
            import glob
            
            specstory_dir = Path(repository) / ".specstory" / "history"
            
            if not specstory_dir.exists():
                return "No .specstory/history directory found"
            
            # Get recent session logs
            days_back = options.get("session_days_back", 7)
            import time
            cutoff_time = time.time() - (days_back * 24 * 60 * 60)
            
            session_files = []
            for md_file in specstory_dir.glob("*.md"):
                if md_file.stat().st_mtime > cutoff_time:
                    session_files.append(md_file)
            
            if not session_files:
                return f"No session logs found in last {days_back} days"
            
            # Sort by modification time (newest first)
            session_files.sort(key=lambda x: x.stat().st_mtime, reverse=True)
            
            # Analyze recent sessions
            session_analysis = []
            max_sessions = options.get("max_sessions", 5)
            
            for session_file in session_files[:max_sessions]:
                try:
                    with open(session_file, 'r', encoding='utf-8') as f:
                        content = f.read()
                    
                    # Extract key insights from session content
                    insights = await self._extract_session_insights(content)
                    session_analysis.append(f"""
### Session: {session_file.name}
Modified: {time.ctime(session_file.stat().st_mtime)}
{insights}
""")
                except Exception as e:
                    session_analysis.append(f"Error reading {session_file.name}: {str(e)}")
            
            return "\n".join(session_analysis)
                
        except Exception as e:
            return f"Session logs analysis error: {str(e)}"

    async def _extract_session_insights(self, session_content: str) -> str:
        """Extract key insights from session log content."""
        try:
            # Extract key patterns from session logs
            lines = session_content.split('\n')
            
            # Look for technical decisions, errors, solutions
            insights = []
            current_section = None
            
            for line in lines:
                line = line.strip()
                
                # Look for exchange markers
                if line.startswith('## Exchange'):
                    current_section = line
                    continue
                
                # Look for user/assistant indicators  
                if line.startswith('**User:**') or line.startswith('**Assistant:**'):
                    continue
                
                # Look for key technical content
                if any(keyword in line.lower() for keyword in [
                    'error', 'fix', 'issue', 'problem', 'solution', 
                    'implementation', 'pattern', 'architecture', 'design',
                    'performance', 'optimization', 'refactor'
                ]):
                    insights.append(f"- {line}")
            
            if insights:
                return "\n".join(insights[:10])  # Limit to top 10 insights
            else:
                return "No specific technical insights extracted"
                
        except Exception as e:
            return f"Session insight extraction error: {str(e)}"

    async def _analyze_code_structure(self, repository: str, options: Dict[str, Any]) -> str:
        """Analyze code structure and patterns."""
        try:
            from pathlib import Path
            
            repo_path = Path(repository)
            
            # Analyze file types and structure
            file_analysis = await self._analyze_file_structure(repo_path)
            
            # Look for configuration files
            config_analysis = await self._analyze_config_files(repo_path)
            
            # Analyze documentation
            docs_analysis = await self._analyze_documentation(repo_path)
            
            return f"""
### File Structure Analysis
{file_analysis}

### Configuration Analysis
{config_analysis}

### Documentation Analysis
{docs_analysis}
"""
                
        except Exception as e:
            return f"Code structure analysis error: {str(e)}"

    async def _analyze_file_structure(self, repo_path: Path) -> str:
        """Analyze repository file structure."""
        try:
            # Count files by type
            file_counts = {}
            total_files = 0
            
            for file_path in repo_path.rglob("*"):
                if file_path.is_file() and not any(part.startswith('.') for part in file_path.parts):
                    total_files += 1
                    suffix = file_path.suffix.lower()
                    file_counts[suffix] = file_counts.get(suffix, 0) + 1
            
            # Sort by count
            sorted_types = sorted(file_counts.items(), key=lambda x: x[1], reverse=True)
            
            structure_info = [f"Total files: {total_files}"]
            structure_info.extend([f"{ext or 'no extension'}: {count}" for ext, count in sorted_types[:10]])
            
            return "\n".join(structure_info)
                
        except Exception as e:
            return f"File structure analysis error: {str(e)}"

    async def _analyze_config_files(self, repo_path: Path) -> str:
        """Analyze configuration files."""
        try:
            config_files = []
            
            # Common config file patterns
            config_patterns = [
                "package.json", "requirements.txt", "Cargo.toml", "pom.xml",
                "Dockerfile", "docker-compose.yml", ".gitignore", "README*",
                "CLAUDE.md", "*.config.js", "*.config.json", "*.yml", "*.yaml"
            ]
            
            for pattern in config_patterns:
                for config_file in repo_path.glob(pattern):
                    if config_file.is_file():
                        config_files.append(config_file.name)
            
            if config_files:
                return "Configuration files found:\n" + "\n".join([f"- {f}" for f in config_files])
            else:
                return "No common configuration files found"
                
        except Exception as e:
            return f"Config analysis error: {str(e)}"

    async def _analyze_documentation(self, repo_path: Path) -> str:
        """Analyze documentation files."""
        try:
            doc_files = []
            
            # Look for documentation
            doc_patterns = ["*.md", "*.rst", "*.txt", "docs/*", "documentation/*"]
            
            for pattern in doc_patterns:
                for doc_file in repo_path.glob(pattern):
                    if doc_file.is_file():
                        doc_files.append(doc_file.relative_to(repo_path))
            
            if doc_files:
                return "Documentation found:\n" + "\n".join([f"- {f}" for f in doc_files[:10]])
            else:
                return "No documentation files found"
                
        except Exception as e:
            return f"Documentation analysis error: {str(e)}"
    
    async def _read_file(self, file_path: str) -> str:
        """Read file content asynchronously."""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception as e:
            raise ValueError(f"Failed to read file {file_path}: {str(e)}")
    
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