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
    // Windows 上 core.autocrlf=true 会让工作区文件变成 CRLF，正则必须容忍 \r，否则整个守卫在 Windows 上恒失败
    const m = readFileSync(p, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
    assert.ok(m, `${name}/SKILL.md 应当有 frontmatter`)

    for (const line of m[1].split(/\r?\n/)) {
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

/**
 * 能力域框架守卫。
 *
 * 「一个工具组 = 一个能力域，各自带齐 collector / register / 文档 / 测试」这条约定
 * 写在 AGENTS.md 里，但约定不会自己执行——迁入 14 个工具那次就漂了：
 * device 一个组塞了 5 个工具对应 3 个 skill，wifi 和 actions 连文档和测试都没有。
 * 光靠 review 拦不住，所以在这里把约定变成断言。
 */
test('每个能力域都要带齐 collector / register / 文档 / 测试，并挂进入口', () => {
  const toolsRoot = join(ROOT, 'src', 'tools')
  const groups = readdirSync(toolsRoot)
    .filter((n) => statSync(join(toolsRoot, n)).isDirectory())
    .sort()

  assert.ok(groups.length > 0, '至少应有一个能力域')

  const index = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8')

  for (const g of groups) {
    for (const required of ['collector.js', 'register.js']) {
      assert.ok(
        existsSync(join(toolsRoot, g, required)),
        `src/tools/${g}/ 缺 ${required}（额外的纯逻辑模块可以有，这两个必须有）`,
      )
    }

    const register = readFileSync(join(toolsRoot, g, 'register.js'), 'utf8')
    assert.match(
      register,
      new RegExp(`export const group = '${g}'`),
      `src/tools/${g}/register.js 的 group 常量必须等于目录名，否则日志里对不上号`,
    )

    assert.match(
      index,
      new RegExp(`from './tools/${g}/register.js'`),
      `src/tools/${g}/ 没挂进 src/index.js 的 GROUPS——工具写了但不会被注册`,
    )

    assert.ok(
      existsSync(join(ROOT, 'test', 'tools', `${g}.test.js`)),
      `缺 test/tools/${g}.test.js`,
    )
    assert.ok(
      existsSync(join(ROOT, 'docs', 'tools', `${g}.md`)),
      `缺 docs/tools/${g}.md`,
    )
  }
})

/**
 * 工具名是插件的对外契约：改名或重名都会让已经写好的 skill 调不到工具。
 * 这里不写死总数会更"灵活"，但也就守不住"迁移时漏掉一个工具"这类问题——
 * 所以刻意写死，改动工具数时必须同步改这里，逼人确认这是有意为之。
 */
test('全仓库共注册 21 个工具，名字不得重复', () => {
  const toolsRoot = join(ROOT, 'src', 'tools')
  const source = walk(toolsRoot)
    .filter((p) => p.endsWith('register.js'))
    .map((p) => readFileSync(join(toolsRoot, p), 'utf8'))
    .join('\n')

  const names = [...source.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1])
  assert.equal(names.length, 21, '工具总数变了；确认是有意的再改这个数字')
  assert.equal(new Set(names).size, names.length, '有重名工具，后注册的会覆盖先注册的')
})

/**
 * 迁入非电池工具时最容易犯的错：把原项目自带的电池能力一起搬进来，
 * 于是仓库里出现两套电池实现，判读口径开始分叉。
 */
test('电池能力只有一套实现', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8')
  assert.equal((index.match(/battery\/register\.js/g) || []).length, 1)

  const toolsRoot = join(ROOT, 'src', 'tools')
  const strayBattery = walk(toolsRoot)
    .filter((p) => !p.startsWith('battery') && p.endsWith('.js'))
    .filter((p) => /battery/i.test(readFileSync(join(toolsRoot, p), 'utf8')))
  assert.deepEqual(strayBattery, [], '非电池能力域里出现了电池相关代码')
})

/**
 * 总路由 skill 决定了模型先看哪个能力域。它一旦指向已经不存在的工具名，
 * 症状是"skill 触发了但什么也没发生"，很难查。
 */
test('总路由 skill 指向现存能力，且不复活旧的电池路由', () => {
  const rootSkill = readFileSync(
    join(ROOT, '.dsh', 'skills', 'xiangbangbang-device-assistant', 'SKILL.md'),
    'utf8',
  )
  assert.match(rootSkill, /`battery-health-check`/)
  assert.match(rootSkill, /`service-recommendation`/)
  assert.match(rootSkill, /服务网点、价格或适配性/)
  assert.match(rootSkill, /服务入口不能跳过必要诊断/)
  assert.doesNotMatch(rootSkill, /`battery_diagnosis`|`battery_get_health`/)
})
