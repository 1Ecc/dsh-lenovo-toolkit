import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createService, describeError, parseCli, KNOWN_ERROR_CODES, ACTIONS } from './service.mjs'
import { fileStore, memoryStore, STATE_IDLE_MS } from './service-lib/state.mjs'
import { ensureNode, nodeIsNewEnough, NODE_MIN_MAJOR } from './service-lib/runtime.mjs'
import { ToolkitError } from './service-lib/errors.mjs'

const service = fileURLToPath(new URL('./service.mjs', import.meta.url))
const scriptsDir = fileURLToPath(new URL('./', import.meta.url))
const b64 = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

// 测试用独立状态文件，不碰用户目录里可能正在进行的真实会话。
const testStatePath = join(tmpdir(), `battery-service-test-${process.pid}.json`)
function run(args, input = '') {
  return spawnSync(process.execPath, [service, ...args], { input, encoding: 'utf8', timeout: 20000, env: { ...process.env, LENOVO_BATTERY_SERVICE_STATE: testStatePath } })
}

const slots = [{ date: '2026-09-15', slots: [{ time: '10:00-11:00', available: true }] }]
function mockClient({ withStores = true, submit } = {}) {
  return {
    async lookupWarranty(sn) { return { sn, battery_covered: false } },
    async lookupBatteryPrice(sn) { return { sn, available: true, standard_price_cny: 399 } },
    async findNearestStores() { return { stores: withStores ? [{ code: 'chosen', name: '已选门店' }, { code: 'other', name: '其他门店' }] : [] } },
    normalizeSn: value => String(value).toUpperCase(),
    async createAppointmentSession() { return { token: 'private-token', oauthToken: 'private-oauth', lenovoid: 'uid' } },
    async listAppointmentDevices() { return [{ sn: 'TEST', material_no: 'MTM' }] },
    async getRepairService() { return { big_class_id: 1, category_type: 1, is_store: 1, is_door: 0 } },
    async listAppointmentStores() { return [{ code: 'other', name: '其他门店' }, { code: 'chosen', name: '已选门店', address: '地址', phone: '010' }] },
    async listAppointmentSlots() { return slots },
    async getSubmitSignature() { return 'sig' },
    submitAppointment: submit || (async () => ({ submitted: true, result: { so_no: 'SO1' }, submitted_at: 'now' })),
  }
}
function mockBrowser() {
  const counters = { launches: 0, closes: 0, opened: [] }
  let alive = true
  const api = {
    async launchBrowser() { counters.launches++; alive = true; return { endpoint: 'ws://127.0.0.1:1/devtools/browser/x', targetId: 't', pid: 1, profile: null, owned: true, launched_via: 'mock' } },
    async attachBrowser() { throw new Error('unused') },
    async readPassport() { return 'private-cookie' },
    async openPage(browser, url) { if (!alive) throw new ToolkitError('gone', 'BROWSER_CLOSED'); counters.opened.push(url) },
    async closeBrowser(browser) { if (browser) counters.closes++ },
    async browserAlive() { return alive },
  }
  return { api, counters, kill: () => { alive = false } }
}
function mocked(options = {}) {
  const browser = mockBrowser()
  const runtime = createService({ client: mockClient(options), browserApi: browser.api, store: options.store })
  return { runtime, ...browser }
}

test('CLI 参数解析：位置参数是 action，--key value 是字段，裸 --flag 为 true，--b64 整体合并', () => {
  const { req, flags } = parseCli(['prepare', '--stationCode', '007', '--phone', '13800000000', '--confirmed', '--lat', '39.9', '--withOptions=false', '--ascii'])
  assert.equal(req.action, 'prepare')
  assert.equal(req.stationCode, '007', '门店编号保持字符串')
  assert.equal(req.phone, '13800000000', '手机号保持字符串')
  assert.equal(req.confirmed, true)
  assert.equal(req.lat, 39.9)
  assert.equal(req.withOptions, false)
  assert.equal(flags.ascii, true)
  const merged = parseCli(['--b64', b64({ action: 'stores', city: '北京市' }), '--address', '中关村']).req
  assert.deepEqual(merged, { action: 'stores', city: '北京市', address: '中关村' })
  assert.throws(() => parseCli(['quote', 'extra']), { code: 'INVALID_REQUEST' })
  assert.throws(() => parseCli(['--b64', 'nope']), { code: 'INVALID_JSON' })
})

test('Node 版本前置检查：够新直接放行；不够新时找替代重新执行，找不到报 NODE_TOO_OLD 并附安装命令', async () => {
  assert.equal(nodeIsNewEnough(`${NODE_MIN_MAJOR}.0.0`), true)
  assert.equal(nodeIsNewEnough('20.20.2'), false)
  assert.equal(ensureNode(service, []), true, '测试本身就在够新的 Node 上跑')
  const described = describeError(new ToolkitError('当前 Node v20.0.0 过旧。安装 Node', 'NODE_TOO_OLD'))
  assert.match(described.message, /安装 Node/, 'NODE_TOO_OLD 的 message 必须原样带出安装命令')
  assert.ok(described.next)

  // 假装当前 Node 是 20：PATH 上只有一个空目录时报错；PATH 上放一份够新的 node 时用它重新执行整条命令。
  const dir = await mkdtemp(join(tmpdir(), 'battery-node-'))
  try {
    const bare = { PATH: dir, Path: dir, HOME: dir, USERPROFILE: dir, ProgramFiles: dir, 'ProgramFiles(x86)': dir, LOCALAPPDATA: dir, APPDATA: dir }
    // macOS/Linux 的固定路径（/usr/local/bin 等）不受 env 控制，"找不到"这一半只在 Windows 上可靠断言。
    if (process.platform === 'win32') assert.throws(() => ensureNode(service, [], { env: bare, currentVersion: '20.20.2' }), { code: 'NODE_TOO_OLD' })
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    await cp(process.execPath, join(dir, exe))
    let exitCode
    const statePath = join(dir, 'state.json')
    const proceeded = ensureNode(service, ['status', '--ascii'], { env: { ...bare, LENOVO_BATTERY_SERVICE_STATE: statePath }, currentVersion: '20.20.2', exit: code => { exitCode = code } })
    assert.equal(proceeded, false)
    assert.equal(exitCode, 0, '重新执行的 status 应成功')
    await access(statePath)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('无参数或 --help 打印用法；未知 action 报 INVALID_ACTION', () => {
  assert.match(run(['--help']).stdout, /用法/)
  const unknown = run(['nonsense', '--ascii'])
  assert.equal(JSON.parse(unknown.stdout).code, 'INVALID_ACTION')
})

test('CLI 跨进程保持状态：status 不落敏感信息，close 删除状态文件；--ascii 只输出可打印 ASCII', async () => {
  const status = run(['status', '--ascii'])
  assert.equal(status.status, 0, status.stdout || status.stderr)
  assert.match(status.stdout.trim(), /^[ -~]+$/)
  const parsed = JSON.parse(status.stdout)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.authenticated, false)
  assert.equal(parsed.data.node_version, process.version)
  await access(testStatePath)
  const closed = run(['close'])
  assert.equal(JSON.parse(closed.stdout).data.closed, true)
  await assert.rejects(access(testStatePath), 'close 后状态文件应删除')
})

test('stdio 兼容首行 UTF-8 BOM，后续命令仍可解析', () => {
  const result = spawnSync(process.execPath, [service, '--stdio'], {
    input: '﻿{"action":"status"}\n{"action":"close"}\n', encoding: 'utf8', timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trim().split(/\r?\n/).map(JSON.parse)
  assert.deepEqual(lines[0].actions, ACTIONS)
  assert.equal(lines[1].ok, true)
  assert.equal(lines[2].data.closed, true)
})

test('文件存储：两个独立的 service 实例通过同一状态文件接力，且文件里不含原始 cookie', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'battery-state-'))
  const path = join(dir, 'state.json')
  try {
    const first = mocked({ store: fileStore(path) })
    await first.runtime.handle({ action: 'quote', sn: 'test' })
    await first.runtime.handle({ action: 'stores', city: '北京市', lat: 40, lng: 116 })
    const second = mocked({ store: fileStore(path) })
    const login = await second.runtime.handle({ action: 'login', stationCode: 'chosen' })
    assert.equal(login.selected_store.code, 'chosen', '门店列表来自上一进程写的状态文件')
    const third = mocked({ store: fileStore(path) })
    const auth = await third.runtime.handle({ action: 'auth' })
    assert.equal(auth.sn, 'TEST', 'sn 沿用 quote 时记下的，不必再传')
    assert.equal(auth.authenticated, true)
    assert.deepEqual(auth.options.days, slots)
    const raw = await readFile(path, 'utf8')
    assert.doesNotMatch(raw, /private-cookie/)
    assert.match(raw, /private-token/, 'token 允许落盘（这是它唯一能跨进程保存的地方）')
    const prepare = await third.runtime.handle({ action: 'prepare', stationCode: 'chosen', appointmentDate: '2026-09-15', timeBucket: '10:00-11:00', name: '张三', phone: '13800000000', desc: '电池健康度72%' })
    assert.equal(prepare.review.phone_masked, '138****0000')
    const fourth = mocked({ store: fileStore(path) })
    const submit = await fourth.runtime.handle({ action: 'submit', draft_id: prepare.draft_id, confirmed: true })
    assert.equal(submit.order.so_no, 'SO1')
    assert.doesNotMatch(await readFile(path, 'utf8'), /13800000000/, '提交后手机号不再留在文件里')
    await assert.rejects(fourth.runtime.handle({ action: 'prepare', stationCode: 'chosen', appointmentDate: '2026-09-15', timeBucket: '10:00-11:00', name: '张三', phone: '13800000000', desc: 'x' }), { code: 'SUBMISSION_ALREADY_ATTEMPTED' })
    await fourth.runtime.handle({ action: 'close' })
    assert.equal(fourth.counters.closes, 1)
    await assert.rejects(access(path), 'close 后状态文件应删除')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('文件存储：submit 抛错也保留 attempted 标志；过期状态被丢弃并回收浏览器', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'battery-state-'))
  const path = join(dir, 'state.json')
  try {
    const failing = mocked({ store: fileStore(path), submit: async () => { throw new ToolkitError('timeout', 'NETWORK') } })
    await failing.runtime.handle({ action: 'stores', city: '北京市', lat: 40, lng: 116 })
    await failing.runtime.handle({ action: 'login', stationCode: 'chosen' })
    await failing.runtime.handle({ action: 'auth', sn: 'TEST' })
    const prepare = await failing.runtime.handle({ action: 'prepare', stationCode: 'chosen', appointmentDate: '2026-09-15', timeBucket: '10:00-11:00', name: '张三', phone: '13800000000', desc: 'x' })
    await assert.rejects(failing.runtime.handle({ action: 'submit', draft_id: prepare.draft_id, confirmed: true }), { code: 'NETWORK' })
    const again = mocked({ store: fileStore(path) })
    await assert.rejects(again.runtime.handle({ action: 'submit', draft_id: prepare.draft_id, confirmed: true }), { code: 'SUBMISSION_ALREADY_ATTEMPTED' })
    assert.equal((await again.runtime.handle({ action: 'status' })).submission_attempted, true)

    let staleBrowser = null
    let clock = Date.now() + STATE_IDLE_MS + 1000
    const expired = fileStore(path, { now: () => clock, onStale: async state => { staleBrowser = state.browser } })
    assert.equal(await expired.load(), null)
    assert.ok(staleBrowser?.endpoint, '过期时把浏览器句柄交给回收回调')
    await assert.rejects(access(path))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('login 复用仍活着的浏览器；浏览器已被关闭时自动重新拉起', async () => {
  const { runtime, counters, kill } = mocked()
  await runtime.handle({ action: 'stores', city: '北京市', lat: 40, lng: 116 })
  await assert.rejects(runtime.handle({ action: 'login', stationCode: 'invented' }), { code: 'STATION_UNAVAILABLE' })
  assert.equal(counters.launches, 0)
  const first = await runtime.handle({ action: 'login', stationCode: 'chosen' })
  assert.equal(first.browser_reused, false)
  const second = await runtime.handle({ action: 'login' })
  assert.equal(second.browser_reused, true)
  assert.equal(counters.launches, 1)
  kill()
  await assert.rejects(runtime.handle({ action: 'auth', sn: 'TEST' }), { code: 'BROWSER_CLOSED' }, '登录后浏览器被回收：auth 要报 BROWSER_CLOSED（带宿主提示），不是"请先 login"')
  assert.equal((await runtime.handle({ action: 'status' })).browser_open, false, 'status 要真实探测，不能只看状态文件')
  const third = await runtime.handle({ action: 'login' })
  assert.equal(third.browser_reused, false)
  assert.equal(third.browser_launched_via, 'mock')
  assert.equal(counters.launches, 2)
  const auth = await runtime.handle({ action: 'auth', sn: 'TEST' })
  assert.equal(auth.options.selected_store.code, 'chosen')
  assert.doesNotMatch(JSON.stringify(auth), /private/)
  await runtime.handle({ action: 'close' })
})

test('没选门店时 auth 不附带 options；withOptions:false 可关闭；门店已定时 options 只返回该店', async () => {
  const { runtime } = mocked()
  await runtime.handle({ action: 'login' })
  const auth = await runtime.handle({ action: 'auth', sn: 'TEST' })
  assert.equal(auth.authenticated, true)
  assert.equal(Object.hasOwn(auth, 'options'), false)
  await runtime.handle({ action: 'stores', city: '北京市', lat: 40, lng: 116 })
  await runtime.handle({ action: 'select-store', stationCode: 'chosen' })
  const plain = await runtime.handle({ action: 'auth', sn: 'TEST', withOptions: false })
  assert.equal(Object.hasOwn(plain, 'options'), false)
  const result = await runtime.handle({ action: 'options' })
  assert.equal(result.selected_store.code, 'chosen')
  assert.deepEqual(result.days, slots)
  assert.equal(Object.hasOwn(result, 'stores'), false)
  await runtime.handle({ action: 'close' })
})

test('查询动作缺 sn 时报 INVALID_SN；需要登录的动作在未登录时报可执行的错误', async () => {
  const { runtime } = mocked()
  await assert.rejects(runtime.handle({ action: 'quote' }), { code: 'INVALID_SN' })
  await assert.rejects(runtime.handle({ action: 'options' }), { code: 'LOGIN_REQUIRED' })
  await assert.rejects(runtime.handle({ action: 'auth', sn: 'TEST' }), { code: 'BROWSER_REQUIRED' })
  const quote = await runtime.handle({ action: 'quote', sn: 'test' })
  assert.equal(quote.price.standard_price_cny, 399)
  assert.ok(quote.next)
})

test('scripts 下抛出的每个错误码都在文案表里，错误响应总带 next 且不透传输入', async () => {
  const codes = new Set()
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
        const source = await readFile(path, 'utf8')
        for (const match of source.matchAll(/(?:new ToolkitError|\bfail)\([\s\S]*?,\s*'([A-Z_]+)'\s*\)/g)) codes.add(match[1])
      }
    }
  }
  await walk(scriptsDir)
  assert.ok(codes.size > 30, `只扫到 ${codes.size} 个错误码`)
  const missing = [...codes].filter(code => !KNOWN_ERROR_CODES.includes(code))
  assert.deepEqual(missing, [], `缺少文案的错误码：${missing.join(', ')}`)
  for (const gone of ['SESSION_NOT_FOUND', 'SESSION_UNAVAILABLE', 'SESSION_REQUIRED', 'RUNTIME_UNSUPPORTED']) assert.ok(!KNOWN_ERROR_CODES.includes(gone), `${gone} 属于已删除的守护进程方案`)
  const described = describeError(Object.assign(new ToolkitError('x', 'SLOT_UNAVAILABLE'), { stage: 's' }), 'submit')
  assert.equal(described.ok, false)
  assert.equal(described.code, 'SLOT_UNAVAILABLE')
  assert.equal(described.stage, 's')
  assert.ok(described.next)
  assert.doesNotMatch(JSON.stringify(described), /\bx\b/)
  const generic = describeError(new Error('secret upstream body'))
  assert.equal(generic.code, 'INVALID_REQUEST')
  assert.doesNotMatch(JSON.stringify(generic), /secret/)
})

test('专用浏览器使用随机非零端口、脱离本进程树拉起、不创建额外隐身 context；桥接检查发生在拉起浏览器之前', async () => {
  const source = await readFile(new URL('./service-lib/browser.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /--remote-debugging-port=0/)
  assert.doesNotMatch(source, /Target\.createBrowserContext/)
  assert.match(source, /--remote-debugging-port=\$\{port\}/)
  assert.match(source, /Win32_Process -MethodName Create/, 'Windows 上必须经 WMI 拉起，否则会被杀进程树的宿主回收')
  assert.match(source, /detached: true/)
  assert.ok(source.indexOf('assertBrowserBridge()\n  const executable = await findBrowser') > -1, 'launchBrowser 必须先检查桥接能力再 spawn')
  assert.equal(typeof memoryStore().load, 'function')
})
