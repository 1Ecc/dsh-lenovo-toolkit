import { test } from 'node:test'
import assert from 'node:assert/strict'

import { appList } from '../../src/tools/app/collector.js'
import { assertUnsupportedOffWindows } from '../helpers/windows.js'

test('appList 用合法关键词时在非 Windows 上优雅降级', async (t) => {
  await assertUnsupportedOffWindows(t, () => appList('vantage', 10))
})

test('关键词过短必须在碰 PowerShell 之前就被拒', async () => {
  // 这条是隐私边界，不是参数校验：装了什么软件是高度敏感的画像信息，
  // 「按名查询」和「拉全量清单」是两件事，空关键词等于后者。
  for (const query of ['', ' ', 'a', ' x ']) {
    const envelope = await appList(query, 10)
    assert.equal(envelope.status, 'error', `query=${JSON.stringify(query)} 应当被拒`)
    assert.equal(envelope.error?.code, 'invalid_query')
    assert.ok(envelope.warnings.some((w) => w.includes('不允许无关键词枚举全部软件')))
  }
})

test('关键词过长同样被拒', async () => {
  const envelope = await appList('x'.repeat(101), 10)
  assert.equal(envelope.error?.code, 'invalid_query')
})
