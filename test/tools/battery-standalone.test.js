import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createService } from '../../.dsh/skills/battery-health-check/scripts/service.mjs'
import { readPassport, connectCdp } from '../../.dsh/skills/battery-health-check/scripts/service-lib/browser.mjs'
import { locateCurrent, searchLocations } from '../../.dsh/skills/battery-health-check/scripts/service-lib/location.mjs'

const sn = 'TEST1234'
const slots = [{ date: '2026-09-20', slots: [{ time: '10:00-11:00', available: true }] }]
function fixture({ submitError = false } = {}) {
  let submitted = 0, passport = null, available = true, clock = 0
  const client = {
    normalizeSn: s => s,
    async createAppointmentSession(p) { assert.equal(p, 'PRIVATE_COOKIE'); return { token: 'PRIVATE_TOKEN' } },
    async listAppointmentDevices() { return [{ sn, material_no: 'MTM' }] },
    async getRepairService() { return { big_class_id: 1, big_class: '维修服务', category_type: 1, is_store: 1, is_door: 0 } },
    async listAppointmentStores() { return [{ code: 'station', name: '测试门店', address: '测试地址', phone: '010-00000000' }] },
    async listAppointmentSlots() { return available ? slots : [] },
    async getSubmitSignature() { return 'PRIVATE_SIGNATURE' },
    async submitAppointment(s, p) { submitted++; assert.equal(p.signature, 'PRIVATE_SIGNATURE'); if (submitError) throw Object.assign(new Error('timeout'), { code: 'NETWORK' }); return { submitted_at: 'date', result: { so_no: 'TEST_ORDER', phone: p.phone, token: 'PRIVATE_TOKEN' } } },
  }
  const browserApi = {
    async launchBrowser() { return { endpoint: 'ws://127.0.0.1/devtools/browser/test', targetId: 'test-page' } },
    async browserAlive(browser) { return Boolean(browser) },
    async readPassport() { return passport },
    async openPage() {},
    async closeBrowser() {},
  }
  const runtime = createService({ client, browserApi, now: () => clock })
  return { runtime, submissions: () => submitted, login: () => { passport = 'PRIVATE_COOKIE' }, logout: () => { passport = null }, expire: () => { clock += 31 * 60000 }, soldOut: () => { available = false } }
}
const prepare = { action: 'prepare', stationCode: 'station', appointmentDate: '2026-09-20', timeBucket: '10:00-11:00', name: '测试用户', phone: '13800001111', desc: '测试，不实际预约' }
async function ready(f) {
  await f.runtime.handle({ action: 'login' }); f.login()
  const auth = await f.runtime.handle({ action: 'auth', sn })
  assert.equal(auth.authenticated, true)
  assert.doesNotMatch(JSON.stringify(auth), /PRIVATE/)
  await f.runtime.handle({ action: 'options', city: '北京市', stationCode: 'station' })
}

test('独立 Skill 可复制到仓库外运行，stdin 多条命令不丢进程', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'battery-standalone-test-'))
  await cp(new URL('../../.dsh/skills/battery-health-check', import.meta.url), join(temp, 'skill'), { recursive: true })
  const result = spawnSync(process.execPath, [join(temp, 'skill/scripts/service.mjs'), '--stdio'], { input: '{"action":"status"}\n{"action":"close"}\n', encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(lines[0].ready, true)
  assert.equal(lines[1].data.authenticated, false)
  assert.equal(lines[2].data.closed, true)
})

test('地址搜索复用官网同源腾讯候选，并保留可直接查门店的坐标', async () => {
  let requested
  const locations = await searchLocations(
    { query: '联想三标大厦', region: '北京市', limit: 3 },
    { fetch: async (url, options) => {
      requested = { url: new URL(url), options }
      return new Response(JSON.stringify({
        status: 0,
        message: 'query ok',
        data: [{
          id: 'poi-1', title: '联想三标大厦', address: '北京市海淀区群英科技园2号楼联想',
          province: '北京市', city: '北京市', district: '海淀区', category: '房产小区:商务楼宇',
          location: { lat: 40.040651, lng: 116.311789 },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    } },
  )
  assert.equal(requested.url.hostname, 'apis.map.qq.com')
  assert.equal(requested.url.searchParams.get('keyword'), '联想三标大厦')
  assert.equal(requested.url.searchParams.get('region'), '北京市')
  assert.equal(new URL(requested.options.headers.referer).hostname, 'newsupport.lenovo.com.cn')
  assert.deepEqual(locations[0], {
    id: 'poi-1', title: '联想三标大厦', address: '北京市海淀区群英科技园2号楼联想',
    province: '北京市', city: '北京市', district: '海淀区', lat: 40.040651, lng: 116.311789,
    category: '房产小区:商务楼宇', provider: '腾讯位置服务（联想官方网点页同源）',
  })
})

test('自动定位复用官网同源腾讯 IP 位置，且明确标为粗略位置', async () => {
  const place = await locateCurrent({ fetch: async () => new Response(JSON.stringify({
    status: 0,
    result: { location: { lat: 40.04, lng: 116.31 }, ad_info: { province: '北京市', city: '北京市', district: '海淀区' } },
  }), { status: 200, headers: { 'content-type': 'application/json' } }) })
  assert.deepEqual(place, {
    title: '北京市海淀区', address: null, province: '北京市', city: '北京市', district: '海淀区',
    lat: 40.04, lng: 116.31, source: 'ip', precise: false,
    provider: '腾讯位置服务（联想官方网点页同源）',
  })
})

test('选择方案后自动查最近门店；选店后预约查询沿用位置和门店', async () => {
  let launches = 0, storeArgs, appointmentArgs
  const runtime = createService({
    client: {
      async findNearestStores(args) {
        storeArgs = args
        return { city: args.city, stores: [{ code: 'station', name: '测试门店', address: '测试地址' }], distance_is_estimate: true }
      },
      normalizeSn: s => s,
      async createAppointmentSession() { return { token: 'PRIVATE_TOKEN' } },
      async listAppointmentDevices() { return [{ sn, material_no: 'MTM' }] },
      async getRepairService() { return { big_class_id: 1, big_class: '维修服务', category_type: 1, is_store: 1, is_door: 0 } },
      async listAppointmentStores(session, args) { appointmentArgs = args; return [{ code: 'station', name: '测试门店', address: '测试地址' }] },
      async listAppointmentSlots() { return slots },
    },
    locationApi: {
      async locateCurrent() {
        return { title: '北京市海淀区', city: '北京市', district: '海淀区', lat: 40.04, lng: 116.31, source: 'ip', precise: false }
      },
      async searchLocations() {
        throw new Error('默认主线不应调用地址搜索')
      },
    },
    browserApi: {
      async launchBrowser() { launches++; return { endpoint: 'ws://127.0.0.1/devtools/browser/test', targetId: 'test-page' } },
      async browserAlive(browser) { return Boolean(browser) },
      async openPage() {},
      async readPassport() { return 'PRIVATE_COOKIE' },
      async closeBrowser() {},
    },
  })

  const result = await runtime.handle({ action: 'stores', limit: 3 })
  assert.equal(storeArgs.city, '北京市')
  assert.equal(storeArgs.locationSource, 'ip')
  assert.equal(result.location.precise, false)
  assert.equal(launches, 0)
  await runtime.handle({ action: 'select-store', stationCode: 'station' })
  await runtime.handle({ action: 'login' })
  assert.equal(launches, 1)
  await runtime.handle({ action: 'auth', sn })
  const options = await runtime.handle({ action: 'options' })
  assert.deepEqual(appointmentArgs, { sn, city: '北京市', county: '海淀区', lat: 40.04, lng: 116.31 })
  assert.equal(options.selected_store.code, 'station')
  assert.deepEqual(options.days, slots)
  await runtime.handle({ action: 'close' })
})

test('用户提供中心位置时 stores 内部完成地址解析，仅含糊时返回候选', async () => {
  let storeArgs
  const candidates = [
    { id: 'poi-1', title: '联想三标大厦', address: '北京市海淀区群英科技园', city: '北京市', district: '海淀区', lat: 40.040651, lng: 116.311789, category: '房产小区:商务楼宇' },
    { id: 'poi-2', title: '联想三标大厦1号楼', address: '北京市海淀区创业路8号', city: '北京市', district: '海淀区', lat: 40.040197, lng: 116.311501, category: '房产小区:房产小区附属' },
  ]
  const runtime = createService({
    client: { async findNearestStores(args) { storeArgs = args; return { stores: [{ code: 'station' }], distance_is_estimate: false } } },
    locationApi: { async locateCurrent() { throw new Error('不应自动定位') }, async searchLocations() { return candidates } },
  })
  const exact = await runtime.handle({ action: 'stores', city: '北京市', address: '海淀区联想三标大厦' })
  assert.equal(storeArgs.locationSource, 'user_map')
  assert.equal(exact.location.title, '联想三标大厦')

  const ambiguous = await runtime.handle({ action: 'stores', city: '北京市', address: '联想' })
  assert.equal(ambiguous.state, 'location_selection_required')
  assert.deepEqual(ambiguous.locations.map(x => x.id), ['poi-1', 'poi-2'])
})

test('API 派生文件没有漂移，也不依赖仓库路径', async () => {
  const source = await readFile(new URL('../../src/tools/battery/lenovo-service.js', import.meta.url), 'utf8')
  const bundled = await readFile(new URL('../../.dsh/skills/battery-health-check/scripts/service-lib/api.mjs', import.meta.url), 'utf8')
  assert.equal(bundled.replaceAll('\r\n', '\n'), source.replace("'../../shared/errors.js'", "'./errors.mjs'").replaceAll('\r\n', '\n'))
})

test('登录未完成不会创建会话，已有登录在 auth 后才生效，过期后不可用', async () => {
  const f = fixture()
  await f.runtime.handle({ action: 'login' })
  assert.equal((await f.runtime.handle({ action: 'auth', sn })).state, 'waiting_for_login')
  await assert.rejects(f.runtime.handle({ action: 'options' }), { code: 'LOGIN_REQUIRED' })
  await ready(f)
  f.expire()
  await assert.rejects(f.runtime.handle({ action: 'options' }), { code: 'LOGIN_REQUIRED' })
})

test('门店/时段/确认固定到单据；成功结果不暴露 token 或完整手机号', async () => {
  const f = fixture(); await ready(f)
  await assert.rejects(f.runtime.handle({ ...prepare, stationCode: 'invented' }), { code: 'STATION_UNAVAILABLE' })
  await assert.rejects(f.runtime.handle({ ...prepare, timeBucket: '11:00-12:00' }), { code: 'SLOT_UNAVAILABLE' })
  const draft = await f.runtime.handle(prepare)
  await assert.rejects(f.runtime.handle({ action: 'submit', draft_id: draft.draft_id }), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(f.submissions(), 0)
  const receipt = await f.runtime.handle({ action: 'submit', confirmed: true, draft_id: draft.draft_id, phone: '13911112222' })
  assert.equal(receipt.order.so_no, 'TEST_ORDER')
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|13800001111|13911112222/)
  assert.doesNotMatch(JSON.stringify(await f.runtime.handle({ action: 'status' })), /PRIVATE|13800001111/)
  await assert.rejects(f.runtime.handle({ action: 'submit', confirmed: true, draft_id: draft.draft_id }), { code: 'SUBMISSION_ALREADY_ATTEMPTED' })
  assert.equal(f.submissions(), 1)
})

test('重新鉴权失败不能继续使用旧账号会话', async () => {
  const f = fixture(); await ready(f); f.logout()
  assert.equal((await f.runtime.handle({ action: 'auth', sn })).authenticated, false)
  await assert.rejects(f.runtime.handle(prepare), { code: 'LOGIN_REQUIRED' })
})

test('确认后约满会阻止下单；提交超时不重发', async () => {
  const f = fixture(); await ready(f)
  const d = await f.runtime.handle(prepare); f.soldOut()
  await assert.rejects(f.runtime.handle({ action: 'submit', confirmed: true, draft_id: d.draft_id }), { code: 'SLOT_UNAVAILABLE' })
  assert.equal(f.submissions(), 0)
  const g = fixture({ submitError: true }); await ready(g)
  const e = await g.runtime.handle(prepare)
  await assert.rejects(g.runtime.handle({ action: 'submit', confirmed: true, draft_id: e.draft_id }), { code: 'NETWORK' })
  await assert.rejects(g.runtime.handle({ action: 'submit', confirmed: true, draft_id: e.draft_id }), { code: 'SUBMISSION_ALREADY_ATTEMPTED' })
  assert.equal(g.submissions(), 1)
})

test('浏览器桥接仅请求预约域 cookies，并释放页面会话', async () => {
  const calls = []
  const cdp = { async call(method, params) {
    calls.push({ method, params })
    if (method === 'Target.attachToTarget') return { sessionId: 'page-session' }
    if (method === 'Network.getCookies') return { cookies: [{ name: 'unrelated', value: 'x' }, { name: 'cerpreg-passport', value: 'PRIVATE_COOKIE', httpOnly: true }] }
    return {}
  }, close() {} }
  assert.equal(await readPassport(
    { endpoint: 'ws://127.0.0.1/devtools/browser/test', targetId: 'chosen-page' },
    { connect: async () => cdp },
  ), 'PRIVATE_COOKIE')
  assert.equal(calls[1].params.urls.length, 1)
  assert.equal(new URL(calls[1].params.urls[0]).hostname, 'serviceorder.lenovo.com.cn')
  assert.equal(calls.at(-1).method, 'Target.detachFromTarget')
  await assert.rejects(connectCdp('ws://example.com/devtools/browser/1'), { code: 'INVALID_BROWSER_ENDPOINT' })
})
