#!/bin/bash
# 把 .dsh/skills/ 同步到 .claude/skills/
#
# 同一份 skill 要放两处：DSH 的加载器扫 .dsh/skills/，Claude Code 扫 .claude/skills/，
# 两边都不认对方的路径。软链在 Windows 上不可靠（这个插件要跨平台），所以用真实副本 +
# 这个脚本保持一致，避免两份内容悄悄漂移。
#
# .dsh/skills/ 是唯一事实来源——它的 frontmatter 字段更全（whenToUse、user-invocable），
# 多出来的键对 Claude Code 无害。

set -euo pipefail
cd "$(dirname "$0")/.."

SRC=".dsh/skills"
DST=".claude/skills"

if [ ! -d "$SRC" ]; then
  echo "ERROR: 找不到源目录 $SRC" >&2
  exit 1
fi

mkdir -p "$DST"
rm -rf "${DST:?}/battery-health-check"
cp -R "$SRC/battery-health-check" "$DST/battery-health-check"

if diff -r "$SRC/battery-health-check" "$DST/battery-health-check" >/dev/null 2>&1; then
  echo "✅ 已同步 $SRC → $DST"
else
  echo "ERROR: 同步后仍存在差异" >&2
  exit 1
fi
