import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as device from '../../src/tools/device/collector.js'
import { openUrl, validateAllowedUrl } from '../../src/tools/actions/collector.js'
import { summarizeNetworkSamples } from '../../src/tools/wifi/network-monitor.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('非电池迁移没有引入第二套电池工具', () => {
  assert.equal(device.batteryGetHealth, undefined)
  const index = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8')
  assert.equal((index.match(/battery\/register\.js/g) || []).length, 1)
})

test('总入口接入 DSH 电池和服务推荐，并拒绝旧电池路由', () => {
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

test('迁入的注册壳暴露 14 个非电池工具', () => {
  const files = [
    join(ROOT, 'src', 'tools', 'device', 'register.js'),
    join(ROOT, 'src', 'tools', 'wifi', 'register.js'),
    join(ROOT, 'src', 'tools', 'actions', 'register.js'),
  ]
  const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
  const names = [...source.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1])
  assert.equal(names.length, 14)
  assert.equal(new Set(names).size, 14)
  assert.ok(!names.some((name) => name.includes('battery')))
})

test('操作工具继续执行确认和 URL 白名单校验', async () => {
  assert.ok(validateAllowedUrl('https://support.lenovo.com/cn/zh/'))
  assert.equal(validateAllowedUrl('https://support.lenovo.com.evil.example/'), null)
  const denied = await openUrl('https://support.lenovo.com/', false)
  assert.equal(denied.status, 'permission_denied')
  assert.equal(denied.error?.code, 'confirmation_required')
})

test('网络采样摘要保持原来的确定性计算', () => {
  const summary = summarizeNetworkSamples([
    { elapsed_seconds: 1, download_bytes_per_second: 100, upload_bytes_per_second: 20, latency_ms: 10 },
    { elapsed_seconds: 2, download_bytes_per_second: 300, upload_bytes_per_second: 40, latency_ms: null },
  ])
  assert.equal(summary.average_download_bytes_per_second, 200)
  assert.equal(summary.peak_upload_bytes_per_second, 40)
  assert.equal(summary.average_latency_ms, 10)
  assert.equal(summary.packet_loss_percent, 50)
})
