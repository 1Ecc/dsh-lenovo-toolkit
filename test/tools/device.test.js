import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { deviceGetInfo } from '../../src/tools/device/collector.js'
import { assertUnsupportedOffWindows } from '../helpers/windows.js'

const COLLECTOR = new URL('../../src/tools/device/collector.js', import.meta.url)

test('deviceGetInfo 在非 Windows 上优雅降级，不抛异常', async (t) => {
  await assertUnsupportedOffWindows(t, () => deviceGetInfo())
})

test('设备采集不得读取序列号', () => {
  // 型号足以支撑服务推荐，序列号只会把这份报告变成敏感数据。
  // 有人「顺手」加回来的话，这条会拦住。
  assert.doesNotMatch(readFileSync(COLLECTOR, 'utf8'), /SerialNumber/i)
})
