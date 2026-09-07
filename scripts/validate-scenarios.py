#!/usr/bin/env python3
"""Validate all scenario-pack contracts without a running Elastic Stack."""

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "learning-service" / "engine"))
spec = importlib.util.spec_from_file_location("contracts", ROOT / "learning-service" / "engine" / "contracts.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
errors = module.validate_catalog(ROOT / "learning")
if errors:
    raise SystemExit("\n".join(f"- {error}" for error in errors))
print("scenario catalog contracts passed")
