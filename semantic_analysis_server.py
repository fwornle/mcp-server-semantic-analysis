#!/usr/bin/env python3
"""
Semantic Analysis MCP Server using FastMCP
Provides tools for code analysis and knowledge base interaction
"""

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from fastmcp import FastMCP
from pydantic import BaseModel, Field

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastMCP server
mcp = FastMCP("semantic-analysis")

class AnalysisResult(BaseModel):
    """Result of semantic analysis"""
    summary: str = Field(description="Summary of the analysis")
    insights: List[str] = Field(description="Key insights discovered")
    patterns: List[str] = Field(description="Patterns identified")
    recommendations: List[str] = Field(description="Recommended actions")

class KnowledgeSearchResult(BaseModel):
    """Result of knowledge base search"""
    query: str = Field(description="Original search query")
    results: List[Dict[str, Any]] = Field(description="Search results")
    summary: str = Field(description="Summary of findings")

@mcp.tool()
def analyze_code(
    code: str,
    language: str = "unknown",
    context: str = ""
) -> AnalysisResult:
    """
    Analyze code for patterns, structure, and potential improvements.
    
    Args:
        code: The source code to analyze
        language: Programming language (e.g., "python", "javascript", "typescript")
        context: Additional context about the code's purpose
    
    Returns:
        AnalysisResult with analysis findings
    """
    try:
        # Basic code analysis
        lines = code.splitlines()
        line_count = len(lines)
        char_count = len(code)
        
        insights = []
        patterns = []
        recommendations = []
        
        # Basic metrics
        if line_count > 0:
            avg_line_length = char_count / line_count
            insights.append(f"Code has {line_count} lines with average length {avg_line_length:.1f} characters")
        
        # Language-specific analysis
        if language.lower() == "python":
            if "class " in code:
                patterns.append("Object-oriented programming with classes")
            if "def " in code:
                patterns.append("Function definitions present")
            if "import " in code or "from " in code:
                patterns.append("Module imports used")
            if "async " in code or "await " in code:
                patterns.append("Async/await patterns detected")
        
        elif language.lower() in ["javascript", "typescript"]:
            if "function " in code or "=>" in code:
                patterns.append("Function definitions present")
            if "class " in code:
                patterns.append("ES6 class syntax used")
            if "async " in code or "await " in code:
                patterns.append("Async/await patterns detected")
            if "const " in code or "let " in code:
                patterns.append("Modern variable declarations")
        
        # General recommendations
        if line_count > 50:
            recommendations.append("Consider breaking large code blocks into smaller functions")
        
        if context:
            insights.append(f"Context provided: {context}")
        
        summary = f"Analyzed {language} code with {line_count} lines. "
        if patterns:
            summary += f"Detected patterns: {', '.join(patterns[:2])}"
        else:
            summary += "Basic structure analysis completed"
        
        return AnalysisResult(
            summary=summary,
            insights=insights,
            patterns=patterns,
            recommendations=recommendations
        )
    
    except Exception as e:
        logger.error(f"Error analyzing code: {e}")
        return AnalysisResult(
            summary=f"Analysis failed: {str(e)}",
            insights=[],
            patterns=[],
            recommendations=["Check code syntax and try again"]
        )

@mcp.tool()
def search_knowledge(
    query: str,
    knowledge_type: str = "general"
) -> KnowledgeSearchResult:
    """
    Search the knowledge base for relevant information.
    
    Args:
        query: Search query
        knowledge_type: Type of knowledge to search ("general", "patterns", "solutions")
    
    Returns:
        KnowledgeSearchResult with search findings
    """
    try:
        # Look for knowledge base file
        kb_path = Path(__file__).parent.parent.parent / "shared-memory-coding.json"
        
        results = []
        summary = f"Searched for '{query}' in {knowledge_type} knowledge"
        
        if kb_path.exists():
            with open(kb_path, 'r') as f:
                kb_data = json.load(f)
            
            # Simple search through entities
            if "entities" in kb_data:
                for entity in kb_data["entities"]:
                    entity_name = entity.get("name", "")
                    entity_type = entity.get("entityType", "")
                    observations = entity.get("observations", [])
                    
                    # Check if query matches entity name or observations
                    if (query.lower() in entity_name.lower() or 
                        any(query.lower() in str(obs).lower() for obs in observations)):
                        results.append({
                            "name": entity_name,
                            "type": entity_type,
                            "relevance": "Name or observation match",
                            "summary": f"{entity_type}: {entity_name}"
                        })
            
            summary = f"Found {len(results)} relevant items for '{query}'"
        else:
            summary = f"Knowledge base not found at {kb_path}"
            results = [{"note": "Knowledge base file not accessible"}]
        
        return KnowledgeSearchResult(
            query=query,
            results=results,
            summary=summary
        )
    
    except Exception as e:
        logger.error(f"Error searching knowledge: {e}")
        return KnowledgeSearchResult(
            query=query,
            results=[],
            summary=f"Search failed: {str(e)}"
        )

@mcp.tool()
def extract_patterns(
    source: str,
    pattern_type: str = "general"
) -> AnalysisResult:
    """
    Extract reusable patterns from code or text.
    
    Args:
        source: Source code or text to analyze
        pattern_type: Type of patterns to extract ("design", "code", "workflow")
    
    Returns:
        AnalysisResult with extracted patterns
    """
    try:
        patterns = []
        insights = []
        recommendations = []
        
        # Extract based on pattern type
        if pattern_type == "design":
            if "class " in source:
                patterns.append("Class-based design pattern")
            if "interface " in source or "protocol " in source:
                patterns.append("Interface/Protocol pattern")
            if "factory" in source.lower():
                patterns.append("Factory pattern indicators")
        
        elif pattern_type == "code":
            if "try:" in source or "except:" in source:
                patterns.append("Error handling pattern")
            if "with " in source:
                patterns.append("Context manager pattern")
            if "yield " in source:
                patterns.append("Generator pattern")
        
        elif pattern_type == "workflow":
            if "step" in source.lower():
                patterns.append("Step-based workflow")
            if "pipeline" in source.lower():
                patterns.append("Pipeline pattern")
            if "queue" in source.lower():
                patterns.append("Queue-based processing")
        
        # General pattern extraction
        lines = source.splitlines()
        for line in lines:
            if line.strip().startswith("#") or line.strip().startswith("//"):
                insights.append(f"Comment pattern: {line.strip()}")
        
        summary = f"Extracted {len(patterns)} patterns of type '{pattern_type}'"
        if patterns:
            summary += f": {', '.join(patterns[:2])}"
        
        return AnalysisResult(
            summary=summary,
            insights=insights,
            patterns=patterns,
            recommendations=recommendations
        )
    
    except Exception as e:
        logger.error(f"Error extracting patterns: {e}")
        return AnalysisResult(
            summary=f"Pattern extraction failed: {str(e)}",
            insights=[],
            patterns=[],
            recommendations=["Check source format and try again"]
        )

@mcp.tool()
def determine_insights(
    data: str,
    context: str = ""
) -> AnalysisResult:
    """
    Determine insights from data or code analysis.
    
    Args:
        data: Data to analyze for insights
        context: Additional context for the analysis
    
    Returns:
        AnalysisResult with determined insights
    """
    try:
        insights = []
        patterns = []
        recommendations = []
        
        # Analyze data structure
        data_lines = data.splitlines()
        insights.append(f"Data contains {len(data_lines)} lines")
        
        # Look for structured data patterns
        if "{" in data and "}" in data:
            patterns.append("JSON-like structure detected")
        
        if "=" in data:
            patterns.append("Key-value pair pattern")
        
        if data.strip().startswith("[") and data.strip().endswith("]"):
            patterns.append("Array/List structure")
        
        # Context-based insights
        if context:
            insights.append(f"Context analysis: {context}")
            if "performance" in context.lower():
                recommendations.append("Consider performance optimization")
            if "security" in context.lower():
                recommendations.append("Review security implications")
            if "scalability" in context.lower():
                recommendations.append("Evaluate scalability requirements")
        
        summary = f"Analyzed data and determined {len(insights)} insights"
        if patterns:
            summary += f" with patterns: {', '.join(patterns[:2])}"
        
        return AnalysisResult(
            summary=summary,
            insights=insights,
            patterns=patterns,
            recommendations=recommendations
        )
    
    except Exception as e:
        logger.error(f"Error determining insights: {e}")
        return AnalysisResult(
            summary=f"Insight determination failed: {str(e)}",
            insights=[],
            patterns=[],
            recommendations=["Check data format and try again"]
        )

if __name__ == "__main__":
    logger.info("Starting Semantic Analysis MCP Server with FastMCP...")
    mcp.run()