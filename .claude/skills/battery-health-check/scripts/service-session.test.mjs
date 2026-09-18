import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createService } from './service.mjs'

const service = fileURLToPath(new URL('./service.mjs', import.meta.url))
const session = fileURLToPath(new URL('./service-session.mjs', import.meta.url))

function run(args, input = '') {
  return spawnSync(process.execPath, [session, ...args], { input, encoding: 'utf8', timeout: 20000 })
}

test('stdio 兼容首行 UTF-8 BOM，后续命令仍可解析', () => {
  const result = spawnSync(process.execPath, [service, '--stdio'], {
    input: '\uFEFF{"action":"status"}\n{"action":"close"}\n', encoding: 'utf8', timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(lines[1].ok, true)
  assert.equal(lines[1].action, 'status')
  assert.equal(lines[2].data.closed, true)
})

test('跨宿主会话可跨进程保持状态并正常关闭', () => {
  const started = run(['start'])
  assert.equal(started.status, 0, started.stdout || started.stderr)
  const id = JSON.parse(started.stdout).data.session_id
  try {
    const status = run(['call', id], '{"action":"status"}')
    assert.equal(status.status, 0, status.stdout || status.stderr)
    assert.equal(JSON.parse(status.stdout).data.authenticated, false)

    const withBom = run(['call', id], '\uFEFF{"action":"status"}')
    assert.equal(withBom.status, 0, withBom.stdout || withBom.stderr)
    assert.equal(JSON.parse(withBom.stdout).ok, true)
  } finally {
    run(['call', id], '{"action":"close"}')
  }
})

test('专用浏览器使用随机非零端口且不创建额外隐身 context', async () => {
  const source = await readFile(new URL('./service-lib/browser.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /--remote-debugging-port=0/)
  assert.doesNotMatch(source, /Target\.createBrowserContext/)
  assert.match(source, /--remote-debugging-port=\$\{port\}/)
})

test('门店已确定时 options 只返回已选门店和时段', async () => {
  const days = [{ date: '2026-09-15', slots: [{ time: '10:00-11:00', available: true }] }]
  const runtime = createService({
    client: {
      async findNearestStores() { return { stores: [{ code: 'chosen', name: '已选门店' }] } },
      normalizeSn: value => value,
      async createAppointmentSession() { return { token: 'private' } },
      async listAppointmentDevices() { return [{ sn: 'TEST', material_no: 'MTM' }] },
      async getRepairService() { return { big_class_id: 1, category_type: 1, is_store: 1, is_door: 0 } },
      async listAppointmentStores() { return [{ code: 'other', name: '其他门店' }, { code: 'chosen', name: '已选门店' }] },
      async listAppointmentSlots() { return days },
    },
    browserApi: {
      async launchBrowser() { return { endpoint: 'ws://127.0.0.1/devtools/browser/test', targetId: 'test-page' } },
      async browserAlive(browser) { return Boolean(browser) },
      async readPassport() { return 'private-cookie' },
      async openPage() {},
      async closeBrowser() {},
    },
  })
  await runtime.handle({ action: 'stores', city: '北京市', lat: 40, lng: 116 })
  await runtime.handle({ action: 'select-store', stationCode: 'chosen' })
  await runtime.handle({ action: 'login' })
  await runtime.handle({ action: 'auth', sn: 'TEST' })
  const result = await runtime.handle({ action: 'options' })
  assert.equal(result.selected_store.code, 'chosen')
  assert.deepEqual(result.days, days)
  assert.equal(Object.hasOwn(result, 'stores'), false)
  await runtime.handle({ action: 'close' })
})
