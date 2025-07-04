"""
Command Line Interface for Semantic Analysis System
Provides the 'sal' command for semantic analysis operations
"""

import asyncio
import argparse
import sys
import json
import os
from pathlib import Path
from typing import Dict, Any, Optional

try:
    from .core import initialize_system, get_system
    from config.api_keys import APIKeyManager
    from config.logging_config import setup_default_logging, get_logger
except ImportError:
    # Handle running as script
    import sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from semantic_analysis.core import initialize_system, get_system
    from config.api_keys import APIKeyManager
    from config.logging_config import setup_default_logging, get_logger


def setup_cli_logging():
    """Setup logging for CLI use."""
    setup_default_logging()


async def analyze_repository(args: argparse.Namespace) -> Dict[str, Any]:
    """Analyze a repository."""
    system = await initialize_system()
    
    try:
        result = await system.analyze_repository(
            args.repository,
            depth=args.depth,
            significance_threshold=args.significance_threshold
        )
        
        return {
            "success": True,
            "type": "repository_analysis",
            "repository": args.repository,
            "result": result
        }
        
    finally:
        await system.shutdown()


async def analyze_conversation(args: argparse.Namespace) -> Dict[str, Any]:
    """Analyze a conversation file."""
    system = await initialize_system()
    
    try:
        result = await system.analyze_conversation(
            args.conversation,
            extract_insights=True
        )
        
        return {
            "success": True,
            "type": "conversation_analysis", 
            "conversation": args.conversation,
            "result": result
        }
        
    finally:
        await system.shutdown()


async def incremental_analysis(args: argparse.Namespace) -> Dict[str, Any]:
    """Perform incremental analysis."""
    system = await initialize_system()
    
    try:
        result = await system.incremental_analysis(
            args.repository or os.getcwd(),
            significance_threshold=args.significance_threshold
        )
        
        return {
            "success": True,
            "type": "incremental_analysis",
            "repository": args.repository or os.getcwd(),
            "result": result
        }
        
    finally:
        await system.shutdown()


async def complete_analysis(args: argparse.Namespace) -> Dict[str, Any]:
    """Perform complete semantic analysis."""
    system = await initialize_system()
    
    try:
        result = await system.complete_semantic_analysis(
            args.repository or os.getcwd(),
            depth=args.depth,
            significance_threshold=args.significance_threshold
        )
        
        return {
            "success": True,
            "type": "complete_analysis",
            "repository": args.repository or os.getcwd(),
            "result": result
        }
        
    finally:
        await system.shutdown()


async def check_status(args: argparse.Namespace) -> Dict[str, Any]:
    """Check system status."""
    try:
        system = get_system()
        await system.initialize()
        
        status = system.get_system_status()
        
        await system.shutdown()
        
        return {
            "success": True,
            "type": "status",
            "status": status
        }
        
    except Exception as e:
        return {
            "success": False,
            "type": "status",
            "error": str(e)
        }


async def interactive_mode(args: argparse.Namespace) -> Dict[str, Any]:
    """Interactive mode for semantic analysis."""
    print("🤖 Semantic Analysis Interactive Mode")
    print("=" * 40)
    
    # Check API key status
    api_manager = APIKeyManager()
    api_status = api_manager.get_status_report()
    
    print(f"API Status: {'✅ AI Available' if api_status['has_ai_providers'] else '⚠️  UKB Fallback Mode'}")
    if api_status['has_ai_providers']:
        print(f"Primary Provider: {api_status['primary_provider']}")
    
    print("\nSelect analysis type:")
    print("1. Repository Analysis")
    print("2. Conversation Analysis") 
    print("3. Incremental Analysis")
    print("4. Complete Semantic Analysis")
    print("5. System Status")
    print("6. Exit")
    
    while True:
        try:
            choice = input("\nEnter choice (1-6): ").strip()
            
            if choice == "6":
                return {"success": True, "type": "interactive", "action": "exit"}
            
            if choice == "1":
                repo = input("Repository path (or press Enter for current directory): ").strip()
                if not repo:
                    repo = os.getcwd()
                
                depth = input("Analysis depth (default 10): ").strip()
                depth = int(depth) if depth.isdigit() else 10
                
                # Create args object
                class Args:
                    repository = repo
                    depth = depth
                    significance_threshold = 7
                
                return await analyze_repository(Args())
            
            elif choice == "2":
                conv_path = input("Conversation file path: ").strip()
                if not conv_path or not os.path.exists(conv_path):
                    print("❌ Invalid conversation file path")
                    continue
                
                class Args:
                    conversation = conv_path
                
                return await analyze_conversation(Args())
            
            elif choice == "3":
                repo = input("Repository path (or press Enter for current directory): ").strip()
                if not repo:
                    repo = os.getcwd()
                
                class Args:
                    repository = repo
                    significance_threshold = 7
                
                return await incremental_analysis(Args())
            
            elif choice == "4":
                repo = input("Repository path (or press Enter for current directory): ").strip()
                if not repo:
                    repo = os.getcwd()
                
                depth = input("Analysis depth (default 10): ").strip()
                depth = int(depth) if depth.isdigit() else 10
                
                class Args:
                    repository = repo
                    depth = depth
                    significance_threshold = 7
                
                return await complete_analysis(Args())
            
            elif choice == "5":
                class Args:
                    pass
                
                return await check_status(Args())
            
            else:
                print("❌ Invalid choice. Please enter 1-6.")
                continue
                
        except KeyboardInterrupt:
            print("\n\n👋 Goodbye!")
            return {"success": True, "type": "interactive", "action": "exit"}
        except Exception as e:
            print(f"❌ Error: {e}")
            continue


def format_output(result: Dict[str, Any], args: argparse.Namespace) -> str:
    """Format output based on format preference."""
    if args.format == "json":
        return json.dumps(result, indent=2)
    
    # Human-readable format
    if not result.get("success", False):
        return f"❌ Error: {result.get('error', 'Unknown error')}"
    
    output_lines = []
    
    # Header
    analysis_type = result.get("type", "unknown")
    output_lines.append(f"🤖 Semantic Analysis - {analysis_type.replace('_', ' ').title()}")
    output_lines.append("=" * 60)
    
    # Analysis details
    if "repository" in result:
        output_lines.append(f"📁 Repository: {result['repository']}")
    
    if "conversation" in result:
        output_lines.append(f"💬 Conversation: {result['conversation']}")
    
    # Results summary
    analysis_result = result.get("result", {})
    
    if analysis_type == "status":
        status = result.get("status", {})
        output_lines.append(f"🏃 System Running: {status.get('system_running', False)}")
        output_lines.append(f"🔧 Agents: {len(status.get('agents', {}))}")
        output_lines.append(f"🔑 API Keys: {'Available' if status.get('api_keys', {}).get('has_ai_providers') else 'UKB Fallback'}")
        
        # Agent status
        output_lines.append("\n📋 Agent Status:")
        for agent_name, agent_info in status.get("agents", {}).items():
            health_icon = "✅" if agent_info.get("health") == "healthy" else "❌"
            output_lines.append(f"  {health_icon} {agent_name}")
    
    else:
        # General analysis results
        if isinstance(analysis_result, dict):
            if analysis_result.get("success"):
                output_lines.append("✅ Analysis completed successfully")
                
                # Try to extract key information
                if "entities" in analysis_result:
                    output_lines.append(f"📊 Entities created: {len(analysis_result['entities'])}")
                
                if "insights" in analysis_result:
                    output_lines.append(f"💡 Insights generated: {len(analysis_result['insights'])}")
                
                if "workflow_id" in analysis_result:
                    output_lines.append(f"🔄 Workflow ID: {analysis_result['workflow_id']}")
            else:
                output_lines.append(f"❌ Analysis failed: {analysis_result.get('error', 'Unknown error')}")
        else:
            output_lines.append("✅ Analysis completed")
    
    # Footer
    output_lines.append("\n💡 Use 'sal --help' for more options")
    
    return "\n".join(output_lines)


def create_parser() -> argparse.ArgumentParser:
    """Create argument parser."""
    parser = argparse.ArgumentParser(
        prog="sal",
        description="Semantic Analysis Launcher - Multi-agent semantic analysis system",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  sal                                    # Interactive mode
  sal --repository /path/to/repo        # Analyze repository
  sal --conversation chat.md             # Analyze conversation
  sal --incremental                      # Incremental analysis (current dir)
  sal --complete --repository /path      # Complete analysis
  sal --status                           # Check system status
  
The system uses a 3-tier API key fallback:
  ANTHROPIC_API_KEY → OPENAI_API_KEY → Custom OpenAI → UKB fallback
        """
    )
    
    # Main action arguments
    parser.add_argument(
        "--repository", "-r",
        type=str,
        help="Repository path for analysis"
    )
    
    parser.add_argument(
        "--conversation", "-c", 
        type=str,
        help="Conversation file path for analysis"
    )
    
    parser.add_argument(
        "--incremental", "-i",
        action="store_true",
        help="Perform incremental analysis since last run"
    )
    
    parser.add_argument(
        "--complete",
        action="store_true", 
        help="Perform complete semantic analysis with all agents"
    )
    
    parser.add_argument(
        "--status", "-s",
        action="store_true",
        help="Check system status"
    )
    
    # Analysis parameters
    parser.add_argument(
        "--depth", "-d",
        type=int,
        default=10,
        help="Analysis depth (number of commits/items to analyze, default: 10)"
    )
    
    parser.add_argument(
        "--significance-threshold", "-t", 
        type=int,
        default=7,
        choices=range(1, 11),
        help="Significance threshold 1-10 (default: 7)"
    )
    
    # Output options
    parser.add_argument(
        "--format", "-f",
        choices=["human", "json"],
        default="human",
        help="Output format (default: human)"
    )
    
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Verbose output"
    )
    
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Quiet mode (minimal output)"
    )
    
    return parser


async def main():
    """Main CLI entry point."""
    parser = create_parser()
    args = parser.parse_args()
    
    # Setup logging based on verbosity
    if not args.quiet:
        setup_cli_logging()
    
    try:
        # Determine action
        if args.status:
            result = await check_status(args)
        elif args.repository:
            if args.complete:
                result = await complete_analysis(args)
            else:
                result = await analyze_repository(args)
        elif args.conversation:
            result = await analyze_conversation(args)
        elif args.incremental:
            result = await incremental_analysis(args)
        elif args.complete:
            result = await complete_analysis(args)
        else:
            # Interactive mode
            result = await interactive_mode(args)
        
        # Output result
        if not args.quiet:
            output = format_output(result, args)
            print(output)
        
        # Exit code
        sys.exit(0 if result.get("success", False) else 1)
        
    except KeyboardInterrupt:
        if not args.quiet:
            print("\n👋 Analysis cancelled")
        sys.exit(1)
        
    except Exception as e:
        if not args.quiet:
            print(f"❌ Unexpected error: {e}")
        sys.exit(1)


def advanced_main():
    """Advanced CLI entry point with more options."""
    # This would be the entry point for semantic-analysis-cli
    # For now, just call main
    asyncio.run(main())


if __name__ == "__main__":
    asyncio.run(main())