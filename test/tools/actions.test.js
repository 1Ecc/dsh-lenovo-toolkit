import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  copyDiagnosticReport,
  openApp,
  openSystemSettings,
  openUrl,
  validateAllowedUrl,
} from '../../src/tools/actions/collector.js'

test('URL 白名单按域名边界匹配，不能被子串蒙混过去', () => {
  assert.ok(validateAllowedUrl('https://support.lenovo.com/cn/zh/'))
  // 经典的白名单绕过：把白名单域名做成攻击域名的前缀。
  assert.equal(validateAllowedUrl('https://support.lenovo.com.evil.example/'), null)
  assert.equal(validateAllowedUrl('http://support.lenovo.com/'), null, 'HTTP 不在白名单内')
})

test('四个受控操作在未确认时一律拒绝执行', async () => {
  // 「逐次确认」是这组工具存在的前提。任何一个漏掉确认，
  // 模型就能在用户不知情的情况下改动它的机器状态。
  const calls = [
    ['open_system_settings', () => openSystemSettings('power', false)],
    ['open_app', () => openApp('task_manager', false)],
    ['open_url', () => openUrl('https://support.lenovo.com/', false)],
    ['copy_diagnostic_report', () => copyDiagnosticReport('摘要', false)],
  ]
  for (const [name, call] of calls) {
    const envelope = await call()
    assert.equal(envelope.status, 'permission_denied', `${name} 未确认时应当拒绝`)
    assert.equal(envelope.error?.code, 'confirmation_required', `${name} 的拒绝原因应当可识别`)
  }
})
