import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { storageGetStatus } from '../../src/tools/storage/collector.js'
import { assertUnsupportedOffWindows } from '../helpers/windows.js'

test('storageGetStatus 在非 Windows 上优雅降级', async (t) => {
  await assertUnsupportedOffWindows(t, () => storageGetStatus())
})

test('存储采集只看固定卷的容量数字，不遍历用户文件', () => {
  const source = readFileSync(new URL('../../src/tools/storage/collector.js', import.meta.url), 'utf8')
  // DriveType = 3 就是固定卷；放开这个过滤会把 U 盘、网络盘一起算进「空间不足」。
  assert.match(source, /DriveType = 3/)
  // 出现目录遍历命令说明有人把「看看哪个文件夹占地方」加进来了——那是越界。
  assert.doesNotMatch(source, /Get-ChildItem|Measure-Object -Property Length/)
})
