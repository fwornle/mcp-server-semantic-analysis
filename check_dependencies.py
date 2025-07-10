#!/usr/bin/env python3
"""Check which dependencies are missing between system Python and venv"""

import subprocess
import sys
import json

def get_installed_packages(python_path):
    """Get list of installed packages for a Python interpreter"""
    try:
        result = subprocess.run(
            [python_path, '-m', 'pip', 'list', '--format=json'],
            capture_output=True,
            text=True
        )
        if result.returncode == 0:
            return {pkg['name']: pkg['version'] for pkg in json.loads(result.stdout)}
    except:
        pass
    return {}

# Check system Python
system_packages = get_installed_packages('/Library/Frameworks/Python.framework/Versions/3.12/bin/python3')
print(f"System Python packages: {len(system_packages)}")

# Check venv Python
venv_packages = get_installed_packages('/Users/q284340/Agentic/coding/integrations/mcp-server-semantic-analysis/venv/bin/python')
print(f"Venv Python packages: {len(venv_packages)}")

# Find differences
venv_only = set(venv_packages.keys()) - set(system_packages.keys())
print(f"\nPackages in venv but NOT in system Python ({len(venv_only)}):")
for pkg in sorted(venv_only):
    print(f"  - {pkg} ({venv_packages[pkg]})")

# Check critical AI packages
critical_packages = ['anthropic', 'openai', 'langchain', 'structlog', 'mcp']
print("\nCritical package status:")
for pkg in critical_packages:
    in_system = pkg in system_packages
    in_venv = pkg in venv_packages
    status = "✅ Both" if in_system and in_venv else ("🟡 Venv only" if in_venv else ("🟠 System only" if in_system else "❌ Missing"))
    print(f"  {pkg}: {status}")
    if in_system:
        print(f"    System: {system_packages[pkg]}")
    if in_venv:
        print(f"    Venv: {venv_packages[pkg]}")