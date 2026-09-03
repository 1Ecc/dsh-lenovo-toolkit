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

# 所有顶层 skill 都要同步。只同步 battery 会让新增工具组在 Claude Code 形态下静默缺失。
for skill in "$SRC"/*; do
  [ -d "$skill" ] || continue
  name="$(basename "$skill")"
  rm -rf "${DST:?}/$name"
  cp -R "$skill" "$DST/$name"
done

if diff -r "$SRC" "$DST" >/dev/null 2>&1; then
  echo "✅ 已同步 $SRC → $DST"
else
  echo "ERROR: 同步后仍存在差异" >&2
  exit 1
fi
