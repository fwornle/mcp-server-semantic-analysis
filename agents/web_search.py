"""
Web Search Agent
Context-aware search and validation capabilities
"""

import asyncio
import aiohttp
from typing import Dict, Any, List, Optional
from urllib.parse import quote_plus
import re
from bs4 import BeautifulSoup

from .base import BaseAgent


class WebSearchAgent(BaseAgent):
    """Agent for performing context-aware web searches."""
    
    def __init__(self, name: str, config: Dict[str, Any], system: Any):
        super().__init__(name, config, system)
        
        self.search_providers = config.get("search_providers", ["duckduckgo"])
        self.max_results = config.get("max_results", 10)
        self.timeout = config.get("timeout", 30)
        self.content_config = config.get("content_extraction", {})
        
        self.register_capability("web_search")
        self.register_capability("content_extraction")
        self.register_capability("url_validation")
    
    async def on_initialize(self):
        """Initialize web search agent."""
        self.logger.info("Initializing web search agent...")
        self._register_event_handlers()
        
    def _register_event_handlers(self):
        """Register event handlers."""
        self.register_event_handler("search", self._handle_search)
        self.register_event_handler("extract_content", self._handle_extract_content)
        self.register_event_handler("validate_urls", self._handle_validate_urls)
    
    async def search(self, query: str, provider: str = None) -> Dict[str, Any]:
        """Perform web search."""
        provider = provider or self.search_providers[0]
        
        try:
            if provider == "duckduckgo":
                return await self._search_duckduckgo(query)
            else:
                return {"success": False, "error": f"Unsupported provider: {provider}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def _search_duckduckgo(self, query: str) -> Dict[str, Any]:
        """Search using DuckDuckGo."""
        try:
            encoded_query = quote_plus(query)
            url = f"https://html.duckduckgo.com/html/?q={encoded_query}"
            
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.timeout)) as session:
                async with session.get(url) as response:
                    if response.status == 200:
                        html = await response.text()
                        results = self._parse_duckduckgo_results(html)
                        
                        return {
                            "success": True,
                            "query": query,
                            "provider": "duckduckgo",
                            "results": results[:self.max_results]
                        }
                    else:
                        return {"success": False, "error": f"HTTP {response.status}"}
        except Exception as e:
            return {"success": False, "error": f"DuckDuckGo search failed: {str(e)}"}
    
    def _parse_duckduckgo_results(self, html: str) -> List[Dict[str, Any]]:
        """Parse DuckDuckGo search results."""
        results = []
        
        try:
            soup = BeautifulSoup(html, 'html.parser')
            result_divs = soup.find_all('div', class_='result')
            
            for div in result_divs:
                title_elem = div.find('a', class_='result__a')
                snippet_elem = div.find('a', class_='result__snippet')
                
                if title_elem:
                    title = title_elem.get_text(strip=True)
                    url = title_elem.get('href', '')
                    snippet = snippet_elem.get_text(strip=True) if snippet_elem else ""
                    
                    results.append({
                        "title": title,
                        "url": url,
                        "snippet": snippet
                    })
        except Exception as e:
            self.logger.warning(f"Failed to parse DuckDuckGo results: {e}")
        
        return results
    
    async def extract_content(self, url: str) -> Dict[str, Any]:
        """Extract content from a URL."""
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.timeout)) as session:
                async with session.get(url) as response:
                    if response.status == 200:
                        html = await response.text()
                        content = self._extract_text_content(html)
                        
                        return {
                            "success": True,
                            "url": url,
                            "content": content
                        }
                    else:
                        return {"success": False, "error": f"HTTP {response.status}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    def _extract_text_content(self, html: str) -> Dict[str, Any]:
        """Extract meaningful text content from HTML."""
        try:
            soup = BeautifulSoup(html, 'html.parser')
            
            # Remove script and style elements
            for script in soup(["script", "style"]):
                script.decompose()
            
            # Extract text
            text = soup.get_text()
            
            # Clean up text
            lines = (line.strip() for line in text.splitlines())
            chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
            text = ' '.join(chunk for chunk in chunks if chunk)
            
            # Limit content length
            max_length = self.content_config.get("max_content_length", 10000)
            if len(text) > max_length:
                text = text[:max_length] + "..."
            
            # Extract additional elements if configured
            result = {"text": text}
            
            if self.content_config.get("extract_code", False):
                code_blocks = soup.find_all(['code', 'pre'])
                result["code"] = [block.get_text() for block in code_blocks]
            
            if self.content_config.get("extract_links", False):
                links = soup.find_all('a', href=True)
                result["links"] = [link['href'] for link in links]
            
            return result
            
        except Exception as e:
            return {"text": "", "error": str(e)}
    
    async def search_documentation(self, query: str, context: str = "", max_results: int = 5, search_provider: str = "duckduckgo") -> Dict[str, Any]:
        """Perform context-aware search for documentation."""
        try:
            # Enhance query with context
            enhanced_query = f"{query} {context}".strip() if context else query
            
            # Add documentation-specific terms
            doc_query = f"{enhanced_query} documentation api guide tutorial"
            
            search_result = await self.search(doc_query, search_provider)
            
            if search_result.get("success"):
                results = search_result["results"][:max_results]
                
                # Filter for documentation-like results
                filtered_results = []
                doc_indicators = ['docs', 'documentation', 'api', 'guide', 'tutorial', 'reference', 'manual']
                
                for result in results:
                    url_lower = result["url"].lower()
                    title_lower = result["title"].lower()
                    
                    # Prioritize results that look like documentation
                    is_doc = any(indicator in url_lower or indicator in title_lower for indicator in doc_indicators)
                    
                    filtered_results.append({
                        **result,
                        "is_documentation": is_doc,
                        "relevance_score": self._calculate_relevance(result, query, context)
                    })
                
                # Sort by documentation likelihood and relevance
                filtered_results.sort(key=lambda x: (x["is_documentation"], x["relevance_score"]), reverse=True)
                
                return {
                    "success": True,
                    "query": query,
                    "context": context,
                    "enhanced_query": doc_query,
                    "results": filtered_results[:max_results],
                    "provider": search_provider
                }
            else:
                return search_result
                
        except Exception as e:
            self.logger.error("Documentation search failed", error=str(e))
            return {
                "success": False,
                "error": str(e),
                "query": query
            }
    
    def _calculate_relevance(self, result: Dict[str, Any], query: str, context: str) -> float:
        """Calculate relevance score for a search result."""
        score = 0.0
        query_lower = query.lower()
        context_lower = context.lower()
        
        title_lower = result["title"].lower()
        snippet_lower = result["snippet"].lower()
        url_lower = result["url"].lower()
        
        # Query term matches
        if query_lower in title_lower:
            score += 0.4
        if query_lower in snippet_lower:
            score += 0.2
        if query_lower in url_lower:
            score += 0.1
        
        # Context term matches
        if context and context_lower in title_lower:
            score += 0.2
        if context and context_lower in snippet_lower:
            score += 0.1
        
        # Documentation indicators
        doc_indicators = ['api', 'docs', 'documentation', 'guide', 'tutorial', 'reference']
        for indicator in doc_indicators:
            if indicator in url_lower:
                score += 0.1
                break
        
        return min(score, 1.0)
    
    async def extract_web_content(self, urls: List[str], content_type: str = "all") -> Dict[str, Any]:
        """Extract content from multiple web URLs."""
        results = []
        
        for url in urls:
            try:
                content_result = await self.extract_content(url)
                
                if content_result.get("success"):
                    content = content_result["content"]
                    
                    # Filter content based on type
                    if content_type == "text":
                        filtered_content = {"text": content.get("text", "")}
                    elif content_type == "code":
                        filtered_content = {"code": content.get("code", [])}
                    elif content_type == "documentation":
                        # For documentation, prioritize text and code
                        filtered_content = {
                            "text": content.get("text", ""),
                            "code": content.get("code", []),
                            "links": content.get("links", [])[:10]  # Limit links
                        }
                    else:  # "all"
                        filtered_content = content
                    
                    results.append({
                        "url": url,
                        "success": True,
                        "content": filtered_content,
                        "content_type": content_type
                    })
                else:
                    results.append({
                        "url": url,
                        "success": False,
                        "error": content_result.get("error", "Unknown error")
                    })
                    
            except Exception as e:
                results.append({
                    "url": url,
                    "success": False,
                    "error": str(e)
                })
        
        # Calculate success metrics
        successful = sum(1 for r in results if r.get("success", False))
        
        return {
            "success": True,
            "urls_processed": len(urls),
            "successful_extractions": successful,
            "failed_extractions": len(urls) - successful,
            "content_type": content_type,
            "results": results
        }
    
    async def validate_references(self, references: List[str], check_accessibility: bool = True) -> Dict[str, Any]:
        """Validate documentation references and URLs."""
        results = []
        
        for reference in references:
            validation_result = {
                "reference": reference,
                "is_url": self._is_url(reference),
                "accessible": None,
                "status_code": None,
                "redirect_url": None,
                "error": None
            }
            
            # Check if it's a URL
            if validation_result["is_url"] and check_accessibility:
                try:
                    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                        async with session.get(reference, allow_redirects=True) as response:
                            validation_result["accessible"] = response.status < 400
                            validation_result["status_code"] = response.status
                            
                            # Check for redirects
                            if str(response.url) != reference:
                                validation_result["redirect_url"] = str(response.url)
                                
                except Exception as e:
                    validation_result["accessible"] = False
                    validation_result["error"] = str(e)
            
            results.append(validation_result)
        
        # Calculate summary statistics
        total_references = len(references)
        urls_count = sum(1 for r in results if r["is_url"])
        accessible_count = sum(1 for r in results if r.get("accessible") is True)
        inaccessible_count = sum(1 for r in results if r.get("accessible") is False)
        
        return {
            "success": True,
            "total_references": total_references,
            "urls_found": urls_count,
            "accessible_urls": accessible_count,
            "inaccessible_urls": inaccessible_count,
            "check_accessibility": check_accessibility,
            "results": results
        }
    
    def _is_url(self, reference: str) -> bool:
        """Check if a reference is a URL."""
        url_pattern = re.compile(
            r'^https?://'  # http:// or https://
            r'(?:(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,6}\.?|'  # domain...
            r'localhost|'  # localhost...
            r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})'  # ...or ip
            r'(?::\d+)?'  # optional port
            r'(?:/?|[/?]\S+)$', re.IGNORECASE)
        
        return bool(url_pattern.match(reference))
    
    # Event handlers
    async def _handle_search(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle search requests."""
        query = data["query"]
        provider = data.get("provider")
        
        return await self.search(query, provider)
    
    async def _handle_extract_content(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle content extraction requests."""
        url = data["url"]
        
        return await self.extract_content(url)
    
    async def _handle_validate_urls(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle URL validation requests."""
        urls = data["urls"]
        results = []
        
        for url in urls:
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                    async with session.head(url) as response:
                        results.append({
                            "url": url,
                            "valid": response.status < 400,
                            "status": response.status
                        })
            except:
                results.append({
                    "url": url,
                    "valid": False,
                    "status": None
                })
        
        return {"results": results}