#!/bin/bash
# 兼容已有调用者；跨平台同步逻辑统一到 Node 入口。
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/sync-skill.mjs
