#!/usr/bin/env python3
"""Fail if manifest.json content_scripts lists drift from background MODULE_FILES.

Usage: python3 scripts/check-manifest.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
manifest = json.loads((ROOT / "manifest.json").read_text())
bg = (ROOT / "background" / "background.js").read_text()

static = manifest["content_scripts"][0]
static_js = static["js"]
static_css = static["css"]

def extract_block(name):
    m = re.search(
        rf"{name}:\s*\{{\s*css:\s*\[(.*?)\],\s*js:\s*\[(.*?)\],",
        bg,
        re.S,
    )
    if not m:
        print(f"MODULE_FILES.{name} not found in background.js")
        return None
    def to_list(s):
        return re.findall(r"'([^']+)'", s)
    return {"css": to_list(m.group(1)), "js": to_list(m.group(2))}

ok = True
dyn_usos = extract_block("usos")
if dyn_usos:
    # Dynamic USOS registration must carry the same files as the static
    # manifest entry, otherwise a university added via popup gets a broken
    # bundle (e.g. missing zapisy-plan.js -> window.USOSPP_ZAPISY_PLAN undefined).
    for kind in ("js", "css"):
        a, b = static_js if kind == "js" else static_css, dyn_usos[kind]
        if a != b:
            ok = False
            print(f"MISMATCH ({kind}):")
            print(f"  manifest : {a}")
            print(f"  MODULE_FILES.usos: {b}")
if not ok:
    sys.exit(1)
print("OK: manifest.json in sync with MODULE_FILES.usos")
