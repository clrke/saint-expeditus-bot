#!/usr/bin/env bash
set -euo pipefail

echo "Starting Saint Expeditus Bridge Server..."
npx tsx bridge-server/src/index.ts
