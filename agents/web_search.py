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