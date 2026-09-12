#!/usr/bin/env bash
set -euo pipefail

echo "Starting Saint Expeditus Bridge Server (dev mode with watch)..."
npx tsx watch bridge-server/src/index.ts
