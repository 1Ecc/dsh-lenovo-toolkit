/**
 * 仓库一致性守卫。
 *
 * 这个仓库有两处「同一份内容存在于两个位置」的结构，都是被外部工具的路径约定逼出来的：
 *   - skill 文件：DSH 扫 .dsh/skills/，Claude Code 扫 .claude/skills/
 *   - agent 说明：AGENTS.md 是通行约定，CLAUDE.md 是 Claude Code 读的
 *
 * 两者的处理方式不同，原因也不同：
 *   - skill 必须是真副本（软链在 Windows 上不可靠，而这个插件要跨平台），
 *     所以只能靠脚本同步 + 这里的守卫兜底；
 *   - agent 说明可以做成指针，从结构上根除漂移，所以守的是「CLAUDE.md 别长出内容」。
 *
 * 没有这些断言的话，两处内容漂移不会有任何征兆，直到某天有人照着过期的那份改代码。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 递归列出目录下所有文件的相对路径 */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, base, out)
    else out.push(relative(base, p))
  }
  return out
}

test('CLAUDE.md 必须保持为指向 AGENTS.md 的指针，不能长出内容', () => {
  const p = join(ROOT, 'CLAUDE.md')
  assert.ok(existsSync(p), 'CLAUDE.md 应当存在')
  const s = readFileSync(p, 'utf8')

  assert.match(s, /AGENTS\.md/, 'CLAUDE.md 必须指向 AGENTS.md')

  // 阈值取得比当前内容宽裕，但远小于一份真正的说明文档。
  // 超了说明有人开始往这里写实际约定了——那属于 AGENTS.md。
  assert.ok(
    Buffer.byteLength(s, 'utf8') < 1200,
    `CLAUDE.md 变大了（${Buffer.byteLength(s, 'utf8')} 字节）。` +
      '它应当只是指针；实际约定请写进 AGENTS.md，否则两份说明会漂移。',
  )
})

test('AGENTS.md 必须存在且是实际内容', () => {
  const p = join(ROOT, 'AGENTS.md')
  assert.ok(existsSync(p), 'AGENTS.md 应当存在')
  assert.ok(
    Buffer.byteLength(readFileSync(p, 'utf8'), 'utf8') > 2000,
    'AGENTS.md 看起来太短，它应当是唯一事实来源而不是指针',
  )
})

test('.claude/skills 必须与 .dsh/skills 完全一致（漂移了就跑 npm run sync-skill）', () => {
  const src = join(ROOT, '.dsh', 'skills')
  const dst = join(ROOT, '.claude', 'skills')
  assert.ok(existsSync(src), '.dsh/skills 应当存在（它是唯一事实来源）')
  assert.ok(existsSync(dst), '.claude/skills 应当存在')

  const a = walk(src)
  const b = walk(dst)
  assert.deepEqual(b, a, '两处的文件清单不一致，跑 npm run sync-skill')

  for (const rel of a) {
    const x = readFileSync(join(src, rel))
    const y = readFileSync(join(dst, rel))
    assert.ok(x.equals(y), `${rel} 内容不一致，跑 npm run sync-skill（请改 .dsh/ 那份）`)
  }
})

test('每个 skill 的 frontmatter 都要加引号，否则 DSH 会静默拒绝', () => {
  const skillsRoot = join(ROOT, '.dsh', 'skills')
  const skills = readdirSync(skillsRoot).filter((n) =>
    statSync(join(skillsRoot, n)).isDirectory(),
  )
  assert.ok(skills.length > 0, '至少应有一个 skill')

  for (const name of skills) {
    const p = join(skillsRoot, name, 'SKILL.md')
    assert.ok(existsSync(p), `${name}/SKILL.md 应当存在`)
    const m = readFileSync(p, 'utf8').match(/^---\n([\s\S]*?)\n---\n/)
    assert.ok(m, `${name}/SKILL.md 应当有 frontmatter`)

    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([a-zA-Z-]+):\s*(.+)$/)
      if (!kv) continue
      const [, key, value] = kv
      if (value === 'true' || value === 'false') continue
      // DSH 文档：含冒号/括号/逗号的值不加引号会解析失败并静默拒绝整个 skill。
      // 全角标点对标准 YAML 无害，但 DSH 解析器的行为未知，一律要求加引号更安全。
      if (/[:：(（)）,，、]/.test(value)) {
        assert.ok(
          /^['"].*['"]$/.test(value),
          `${name}/SKILL.md 的 ${key} 含标点却未加引号，DSH 可能静默拒绝该 skill`,
        )
      }
    }
  }
})

test('Cordis 工具 schema 遵守 DSH 的显式约束', () => {
  const toolsRoot = join(ROOT, 'src', 'tools')
  const registerFiles = walk(toolsRoot)
    .filter((p) => p.endsWith('register.js'))
    .map((p) => join(toolsRoot, p))

  assert.ok(registerFiles.length > 0, '至少应有一个工具组注册文件')

  for (const p of registerFiles) {
    const source = readFileSync(p, 'utf8')

    // dsh-tools 0.1.1 开始把 required 视为“出现即为 true”，可选参数必须省略该字段。
    assert.doesNotMatch(source, /required\s*:\s*false/, `${relative(ROOT, p)} 不能写 required: false`)

    // 对象输出若不明示开放或关闭额外属性，新版 schema 编译器会拒绝加载整个插件。
    const objectOutputs = source.matchAll(/schema\s*:\s*\{([^}]*)type\s*:\s*['"]object['"]([^}]*)\}/g)
    for (const match of objectOutputs) {
      assert.match(
        `${match[1]}${match[2]}`,
        /additionalProperties\s*:\s*(true|false)/,
        `${relative(ROOT, p)} 的 object 输出 schema 必须显式声明 additionalProperties`,
      )
    }
  }
})
