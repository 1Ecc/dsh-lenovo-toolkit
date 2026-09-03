/**
 * 纯逻辑层测试。
 *
 * collect / renderTrend 会真的去跑采集脚本，所以它们是集成测试：在 macOS 和 Windows 上
 * 会真实执行并断言产物；在其他平台上只断言"给出明确的不支持错误"，而不是跳过——
 * 静默跳过的测试等于没有测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ToolkitError } from '../../src/shared/errors.js'
import {
  collect,
  defaultOutDir,
  detectPlatform,
  num,
  parseMetrics,
  readRules,
  renderTrend,
  summarize,
} from '../../src/tools/battery/collector.js'

test('parseMetrics 只在第一个等号处切分，路径里的等号不能把值截断', () => {
  const m = parseMetrics(
    ['# 注释', '', 'a=1', 'health_pct_os=88', 'raw_dir=/tmp/x=y/raw', '  spaced = 3  ', 'bad'].join('\n'),
  )
  assert.equal(m.a, '1')
  assert.equal(m.health_pct_os, '88')
  assert.equal(m.raw_dir, '/tmp/x=y/raw')
  assert.equal(m.spaced, '3')
  assert.equal(m.bad, undefined)
  assert.equal(m['#'], undefined)
})

test('num 把空值和非数字都收敛成 null，不放 NaN 出去', () => {
  assert.equal(num('88'), 88)
  assert.equal(num('97.9%'), 97.9)
  assert.equal(num(''), null)
  assert.equal(num(undefined), null)
  assert.equal(num('未提供'), null)
})

test('两种健康度口径分歧超过 3 个百分点时，摘要必须给出警示', () => {
  const s = summarize({
    device_vendor: 'Apple',
    device_model: 'MacBook Air',
    battery_model: 'bq40z651',
    design_capacity_mah: '4563',
    full_charge_capacity_mah: '4469',
    health_pct_os: '88',
    health_pct_raw: '97.9',
    cycle_count: '75',
  })
  assert.match(s, /系统口径 88%/)
  assert.match(s, /电量计实测 97\.9%/)
  assert.match(s, /9\.9 个百分点/)
})

test('两种口径一致时不要平白多出一行警示', () => {
  const s = summarize({ health_pct_os: '90', health_pct_raw: '90.5', cycle_count: '10' })
  assert.doesNotMatch(s, /个百分点/)
})

test('readRules 能取到三份规则文档，未知名字要报错而不是返回空', () => {
  assert.match(readRules('interpretation'), /健康度分级/)
  assert.match(readRules('platform'), /macOS/)
  assert.match(readRules('offers'), /触发条件/)
  assert.throws(() => readRules('nope'), ToolkitError)
})

test('defaultOutDir 落在临时目录且带时间戳', () => {
  const d = defaultOutDir()
  assert.ok(d.startsWith(tmpdir()))
  assert.match(d, /battery-health-\d{8}-\d{6}$/)
})

test('renderTrend 对缺失的 metrics 文件给出可识别的错误码', async () => {
  await assert.rejects(
    () => renderTrend({ metricsPath: join(tmpdir(), 'definitely-not-here.env') }),
    (e) => e instanceof ToolkitError && e.code === 'METRICS_MISSING',
  )
})

const platform = detectPlatform()

test('collect 集成测试：真实采集并解析出关键字段', { skip: platform === 'unsupported' }, async (t) => {
  const out = join(tmpdir(), `bh-test-${process.pid}`)
  try {
    const r = await collect({ outDir: out })
    assert.equal(r.platform, platform)
    assert.ok(existsSync(r.metricsPath), 'metrics.env 应当落盘')

    const m = r.metrics
    assert.ok(num(m.design_capacity_mah) > 0, '设计容量应为正数')
    assert.ok(num(m.full_charge_capacity_mah) > 0, '满充容量应为正数')
    assert.ok(m.device_model, '机型不应为空')
    assert.ok(existsSync(m.official_report), '官方电池报告应当生成')

    // 采集层绝不能把 plutil/powershell 的报错文本当成字段值写进去
    for (const [k, v] of Object.entries(m)) {
      assert.doesNotMatch(v, /Could not extract|invalid key path/, `${k} 混入了工具报错文本`)
    }

    // 趋势图串联
    const svg = join(out, 'trend.svg')
    let trend
    try {
      trend = await renderTrend({ metricsPath: r.metricsPath, outPath: svg })
    } catch (err) {
      assert.equal(err.code, 'PYTHON_MISSING', '已安装解释器时，趋势图渲染错误不能被静默跳过')
      t.diagnostic('当前测试进程无法调用 Python，已验证 PYTHON_MISSING 降级；电池采集结果不受影响')
      return
    }
    assert.equal(trend.path, svg)
    const content = readFileSync(svg, 'utf8')
    assert.match(content, /^<svg /, 'SVG 应以 <svg 开头')
    assert.match(content, /80% 建议更换线/, '应画出 80% 更换线')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('collect 在不支持的平台上明确报错', { skip: platform !== 'unsupported' }, async () => {
  await assert.rejects(
    () => collect(),
    (e) => e instanceof ToolkitError && e.code === 'UNSUPPORTED_PLATFORM',
  )
})
