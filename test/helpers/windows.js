/**
 * 非 Windows 平台上的降级断言。
 *
 * 开发机多数是 macOS，而 device/performance/storage/app/wifi 五个能力域都只支持 Windows。
 * 这里守的不是「功能对不对」（那要真机验证），而是「在错的平台上不能炸」——
 * 整个包在 macOS 上也会被加载（电池工具跨平台），一个未捕获的 spawn 错误
 * 会顺着 Cordis 冒上去，表现成整个插件出问题而不是单个工具不可用。
 */
import assert from 'node:assert/strict'

export async function assertUnsupportedOffWindows(t, call) {
  if (process.platform === 'win32') {
    t.skip('本用例只在非 Windows 上有意义')
    return
  }
  const envelope = await call()
  assert.equal(envelope.status, 'unsupported', '非 Windows 上应返回 unsupported 而不是抛异常')
  assert.equal(envelope.error?.code, 'powershell_unavailable')
  assert.equal(envelope.data, null)
}
