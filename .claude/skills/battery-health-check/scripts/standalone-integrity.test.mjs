import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function walk(dir, out = []) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    const info = await lstat(path)
    assert.equal(info.isSymbolicLink(), false, `${relative(skillRoot, path)} 不能是符号链接`)
    if (info.isDirectory()) await walk(path, out)
    else out.push(path)
  }
  return out
}

test('所有相对模块依赖都闭合在 Skill 目录内', async () => {
  const files = await walk(skillRoot)
  for (const file of files.filter(path => path.endsWith('.mjs'))) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), match[1])
      assert.ok(target.startsWith(`${skillRoot}\\`) || target.startsWith(`${skillRoot}/`), `${relative(skillRoot, file)} 引用了目录外模块 ${match[1]}`)
      assert.ok((await lstat(target)).isFile(), `${relative(skillRoot, file)} 缺少本地模块 ${match[1]}`)
    }
  }

  const text = (await Promise.all(files.filter(path => path !== fileURLToPath(import.meta.url) && /\.(?:md|mjs|ps1|sh|py)$/.test(path)).map(path => readFile(path, 'utf8')))).join('\n')
  assert.doesNotMatch(text, /battery_warranty_lookup|battery_part_price_lookup|battery_service_handoff|battery_appointment_options|battery_health_rules|SendUserFile|src[\\/]tools[\\/]battery/)
})

test('复制到仓库外后服务入口仍可独立运行，状态跨进程保存', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'battery-skill-standalone-'))
  const copied = join(temp, 'battery-health-check')
  const statePath = join(temp, 'state.json')
  const env = { ...process.env, LENOVO_BATTERY_SERVICE_STATE: statePath }
  try {
    await cp(skillRoot, copied, { recursive: true })
    const service = join(copied, 'scripts', 'service.mjs')
    const direct = spawnSync(process.execPath, [service, '--stdio'], {
      input: '{"action":"status"}\n{"action":"close"}\n', encoding: 'utf8', timeout: 15000,
    })
    assert.equal(direct.status, 0, direct.stderr)
    assert.equal(JSON.parse(direct.stdout.trim().split(/\r?\n/)[1]).ok, true)

    const status = spawnSync(process.execPath, [service, 'status'], { encoding: 'utf8', timeout: 20000, env })
    assert.equal(status.status, 0, status.stdout || status.stderr)
    assert.equal(JSON.parse(status.stdout).data.authenticated, false)
    assert.ok((await lstat(statePath)).isFile(), '第一次调用后状态文件存在')
    const closed = spawnSync(process.execPath, [service, 'close'], { encoding: 'utf8', timeout: 20000, env })
    assert.equal(closed.status, 0, closed.stdout || closed.stderr)
    await assert.rejects(lstat(statePath), 'close 后状态文件删除')

    const pythonCandidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]]
    const python = pythonCandidates.find(([exe, args]) => spawnSync(exe, [...args, '--version'], { encoding: 'utf8' }).status === 0)
    if (python) {
      const metrics = join(temp, 'metrics.env')
      const chart = join(temp, 'trend.svg')
      await writeFile(metrics, 'schema_version=1\ncollected_at=2026-09-14T00:00:00+0800\nplatform=windows\ncapacity_unit=mWh\ndesign_capacity_mah=60000\nfull_charge_capacity_mah=48000\nhealth_pct_os=80\ncycle_count=300\ndesign_cycle_count=1000\n')
      const rendered = spawnSync(python[0], [...python[1], join(copied, 'scripts', 'render_trend.py'), '--metrics', metrics, '--out', chart], { encoding: 'utf8', timeout: 15000 })
      assert.equal(rendered.status, 0, rendered.stderr)
      assert.ok((await lstat(chart)).size > 0)
      // 判读字段随图一起产出：健康度 80% + 300 循环 / 1000 设计 → 良好、可以开始关注（<85%）、不触发服务推荐
      const fields = Object.fromEntries(rendered.stdout.trim().split(/\r?\n/).map(line => line.split(/=(.*)/s).slice(0, 2)))
      assert.equal(fields.trend_svg, chart)
      assert.equal(fields.health_grade, '良好')
      assert.equal(fields.cycle_grade, '正常')
      assert.equal(fields.decay_multiplier_reliable, 'true')
      assert.equal(fields.trend_mode, 'single_point_projection')
      assert.equal(fields.conclusion_tier, '可以开始关注')
      assert.equal(fields.service_trigger_result, 'false')
      assert.ok((await lstat(join(temp, 'assessment.env'))).size > 0)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
