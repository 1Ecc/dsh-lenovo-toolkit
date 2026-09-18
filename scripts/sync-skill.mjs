import { cp, readdir, rm } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
const dshSkills = new URL('.dsh/skills/', root)
const claudeSkills = new URL('.claude/skills/', root)
const batterySource = new URL('.codex/skills/battery-health-check/', root)

// battery-health-check 以 .codex 为唯一事实源；其他 skill 仍按原约定从 .dsh 同步到 .claude。
for (const entry of await readdir(dshSkills, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== 'battery-health-check') {
    await cp(new URL(entry.name, dshSkills), new URL(entry.name, claudeSkills), { recursive: true })
  }
}
for (const destination of [new URL('battery-health-check', dshSkills), new URL('battery-health-check', claudeSkills)]) {
  // 只重建两个明确的派生目录，确保从事实源删除的文件不会残留；绝不删除或写入 .codex。
  await rm(destination, { recursive: true, force: true })
  await cp(batterySource, destination, { recursive: true })
}
console.log('已同步 battery-health-check：.codex → .dsh/.claude；其他 Skill：.dsh → .claude')
