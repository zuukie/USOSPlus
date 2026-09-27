#!/usr/bin/env bash
# Build a lean store-ready zip: excludes dev-only fixtures, landing, docs tooling.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")"
OUT="dist/usospp_${VERSION}.zip"
mkdir -p dist
python3 scripts/check-manifest.py
rm -f "$OUT"
zip -r "$OUT" \
  manifest.json icons fonts background core popup usos irk vendor \
  -x 'usos/fixtures/*' '*/.DS_Store'
echo "Built $OUT"
unzip -l "$OUT" | tail -n 5
