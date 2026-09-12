#!/usr/bin/env bash
set -euo pipefail

echo "Testing claude CLI directly..."
echo "This should take 10-30 seconds."
echo ""

time claude -p "Say 'hello' in one word" --output-format json --model sonnet --max-turns 1 2>&1

echo ""
echo "Done."
