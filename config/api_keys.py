"""
API Key Management with 3-Tier Fallback System
Supports: ANTHROPIC_API_KEY → OPENAI_API_KEY → CUSTOM_API_KEY (OpenAI-compatible)
"""

import os
from typing import Optional, Dict, Any
from enum import Enum
import structlog

logger = structlog.get_logger(__name__)


class ProviderType(Enum):
    """Supported LLM provider types."""
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    CUSTOM_OPENAI = "custom_openai"
    FALLBACK = "fallback"  # UKB-CLI mode


class APIKeyManager:
    """Manages API keys with intelligent fallback chain."""
    
    def __init__(self):
        self.logger = logger.bind(component="api_key_manager")
        self._available_providers = None
        self._primary_provider = None
        self._fallback_provider = None
        
    def detect_available_providers(self) -> Dict[ProviderType, Dict[str, Any]]:
        """Detect which API providers are available based on environment variables."""
        providers = {}
        
        # Debug: Log all environment variables starting with common API key prefixes
        self.logger.info("🔍 Debugging environment variables...")
        for key in sorted(os.environ.keys()):
            if any(prefix in key for prefix in ["ANTHROPIC", "OPENAI", "API", "KEY"]):
                value = os.environ[key]
                masked_value = value[:8] + "..." if len(value) > 8 else "***"
                self.logger.info(f"  ENV: {key}={masked_value}")
        
        # Check Anthropic (Claude)
        anthropic_key = os.getenv("ANTHROPIC_API_KEY")
        self.logger.info(f"🔍 ANTHROPIC_API_KEY check: found={bool(anthropic_key)}, length={len(anthropic_key) if anthropic_key else 0}")
        if anthropic_key and anthropic_key not in ("", "your-anthropic-api-key"):
            providers[ProviderType.ANTHROPIC] = {
                "api_key": anthropic_key,
                "available": True,
                "priority": 1
            }
            self.logger.info("✅ ANTHROPIC_API_KEY detected", key_prefix=anthropic_key[:8] + "..." if len(anthropic_key) > 8 else "***")
        else:
            self.logger.warning("❌ ANTHROPIC_API_KEY not found or invalid", 
                              found=bool(anthropic_key), 
                              is_placeholder=anthropic_key == "your-anthropic-api-key" if anthropic_key else False)
            
        # Check OpenAI
        openai_key = os.getenv("OPENAI_API_KEY")
        self.logger.info(f"🔍 OPENAI_API_KEY check: found={bool(openai_key)}, length={len(openai_key) if openai_key else 0}")
        if openai_key and openai_key not in ("", "your-openai-api-key"):
            providers[ProviderType.OPENAI] = {
                "api_key": openai_key,
                "available": True,
                "priority": 2
            }
            self.logger.info("✅ OPENAI_API_KEY detected", key_prefix=openai_key[:8] + "..." if len(openai_key) > 8 else "***")
        else:
            self.logger.warning("❌ OPENAI_API_KEY not found or invalid", 
                              found=bool(openai_key), 
                              is_placeholder=openai_key == "your-openai-api-key" if openai_key else False)
            
        # Check Custom OpenAI-compatible endpoint
        custom_base_url = os.getenv("OPENAI_BASE_URL")
        custom_key = os.getenv("OPENAI_API_KEY") or os.getenv("CUSTOM_API_KEY")
        if custom_base_url and custom_key and custom_key not in ("", "your-custom-api-key"):
            providers[ProviderType.CUSTOM_OPENAI] = {
                "api_key": custom_key,
                "base_url": custom_base_url,
                "available": True,
                "priority": 3
            }
            
        # Always have fallback available
        providers[ProviderType.FALLBACK] = {
            "available": True,
            "priority": 99,
            "description": "UKB-CLI fallback mode (no LLM)"
        }
        
        self._available_providers = providers
        self.logger.info(
            "Detected available providers",
            providers=list(providers.keys()),
            primary=self.get_primary_provider(),
            fallback=self.get_fallback_provider()
        )
        
        return providers
    
    def get_primary_provider(self) -> Optional[ProviderType]:
        """Get the primary (best available) provider."""
        if not self._available_providers:
            self.detect_available_providers()
            
        # Find the provider with the lowest priority (best)
        ai_providers = {
            provider_type: config 
            for provider_type, config in self._available_providers.items() 
            if provider_type != ProviderType.FALLBACK
        }
        
        if not ai_providers:
            return ProviderType.FALLBACK
            
        primary = min(ai_providers.items(), key=lambda x: x[1]["priority"])
        return primary[0]
    
    def get_fallback_provider(self) -> Optional[ProviderType]:
        """Get the fallback provider (second-best available)."""
        if not self._available_providers:
            self.detect_available_providers()
            
        primary = self.get_primary_provider()
        
        # Find the next best provider after primary
        ai_providers = {
            provider_type: config 
            for provider_type, config in self._available_providers.items() 
            if provider_type != ProviderType.FALLBACK and provider_type != primary
        }
        
        if not ai_providers:
            return ProviderType.FALLBACK
            
        fallback = min(ai_providers.items(), key=lambda x: x[1]["priority"])
        return fallback[0]
    
    def get_provider_config(self, provider_type: ProviderType) -> Dict[str, Any]:
        """Get configuration for a specific provider."""
        if not self._available_providers:
            self.detect_available_providers()
            
        return self._available_providers.get(provider_type, {})
    
    def has_ai_providers(self) -> bool:
        """Check if any AI providers are available (not just fallback)."""
        if not self._available_providers:
            self.detect_available_providers()
            
        return any(
            provider_type != ProviderType.FALLBACK 
            for provider_type in self._available_providers.keys()
        )
    
    def validate_provider(self, provider_type: ProviderType) -> bool:
        """Validate that a provider is properly configured."""
        config = self.get_provider_config(provider_type)
        
        if not config.get("available", False):
            return False
            
        if provider_type == ProviderType.FALLBACK:
            return True  # Fallback is always valid
            
        # Validate API key is present
        api_key = config.get("api_key")
        if not api_key or api_key in ("", "your-anthropic-api-key", "your-openai-api-key"):
            return False
            
        return True
    
    def get_fallback_chain(self) -> list[ProviderType]:
        """Get the complete fallback chain in order of preference."""
        if not self._available_providers:
            self.detect_available_providers()
            
        # Sort by priority, excluding unavailable providers
        valid_providers = [
            (provider_type, config)
            for provider_type, config in self._available_providers.items()
            if self.validate_provider(provider_type)
        ]
        
        # Sort by priority
        valid_providers.sort(key=lambda x: x[1]["priority"])
        
        return [provider_type for provider_type, _ in valid_providers]
    
    def get_status_report(self) -> Dict[str, Any]:
        """Generate a comprehensive status report of API key availability."""
        if not self._available_providers:
            self.detect_available_providers()
            
        primary = self.get_primary_provider()
        fallback_chain = self.get_fallback_chain()
        
        return {
            "primary_provider": primary.value if primary else None,
            "fallback_chain": [p.value for p in fallback_chain],
            "has_ai_providers": self.has_ai_providers(),
            "provider_details": {
                provider_type.value: {
                    "available": config.get("available", False),
                    "valid": self.validate_provider(provider_type),
                    "priority": config.get("priority", 99),
                    "description": config.get("description", "")
                }
                for provider_type, config in self._available_providers.items()
            }
        }
    
    @classmethod
    def log_status(cls):
        """Log the current API key status for debugging."""
        manager = cls()
        status = manager.get_status_report()
        
        logger.info(
            "API Key Status Report",
            primary=status["primary_provider"],
            has_ai=status["has_ai_providers"],
            chain=status["fallback_chain"]
        )
        
        for provider, details in status["provider_details"].items():
            if details["available"]:
                logger.info(
                    f"Provider {provider} available",
                    valid=details["valid"],
                    priority=details["priority"]
                )
            else:
                logger.debug(f"Provider {provider} not available")
        
        return status


# Convenience functions for external use
def get_api_key_manager() -> APIKeyManager:
    """Get a configured API key manager instance."""
    return APIKeyManager()


def has_ai_capabilities() -> bool:
    """Quick check if any AI providers are available."""
    manager = APIKeyManager()
    return manager.has_ai_providers()


def get_primary_provider_type() -> Optional[ProviderType]:
    """Quick access to primary provider type."""
    manager = APIKeyManager()
    return manager.get_primary_provider()


if __name__ == "__main__":
    # CLI tool for checking API key status
    manager = APIKeyManager()
    status = manager.get_status_report()
    
    print("🔑 API Key Status Report")
    print("=" * 40)
    
    if status["has_ai_providers"]:
        print(f"✅ Primary Provider: {status['primary_provider']}")
        print(f"🔄 Fallback Chain: {' → '.join(status['fallback_chain'])}")
    else:
        print("⚠️  No AI providers available - will use UKB-CLI fallback mode")
    
    print("\n📋 Provider Details:")
    for provider, details in status["provider_details"].items():
        status_icon = "✅" if details["valid"] else ("🔶" if details["available"] else "❌")
        print(f"  {status_icon} {provider}: Priority {details['priority']}")
        if details.get("description"):
            print(f"      {details['description']}")