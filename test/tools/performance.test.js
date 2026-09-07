import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { performanceGetStatus, processList } from '../../src/tools/performance/collector.js'
import { assertUnsupportedOffWindows } from '../helpers/windows.js'

test('performanceGetStatus 在非 Windows 上优雅降级', async (t) => {
  await assertUnsupportedOffWindows(t, () => performanceGetStatus())
})

test('processList 在非 Windows 上优雅降级', async (t) => {
  await assertUnsupportedOffWindows(t, () => processList('cpu', 5))
})

test('快照类结论必须自带「这是时点采样」的警示', () => {
  // 卡顿投诉里最常见的误判就是拿一次采样当「长期高占用」的证据。
  // 这句警示是判读纪律的一部分，不是可有可无的文案。
  const source = readFileSync(new URL('../../src/tools/performance/collector.js', import.meta.url), 'utf8')
  assert.match(source, /时点快照，不能单独证明/)
  assert.match(source, /进程 CPU 是采样值/)
})
