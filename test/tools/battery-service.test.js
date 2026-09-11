/**
 * 服务链路的离线测试。
 *
 * 联想接口不能在 CI 里稳定跑，所以 fetch 全部注入夹具。夹具内容是 2026-09-11 对一台真实
 * Yoga Pro 14s（保外、延保注明不含电池）抓的响应，字段形状与线上一致。
 * 真要打线上，跑 `LENOVO_LIVE_SN=<主机编号> npm test`，最后那个用例会真实请求一次。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ToolkitError } from '../../src/shared/errors.js'
import {
  buildFaultDescription,
  findNearestStores,
  locateByIp,
  lookupBatteryPrice,
  lookupWarranty,
  mockHumanHandoff,
  normalizeSn,
} from '../../src/tools/battery/lenovo-service.js'

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const MACHINE = {
  statusCode: 200,
  message: 'success',
  data: {
    SN: 'PS00CC2J',
    MachineName: 'Yoga Pro 14s ARH7GRXR716G51211P-XZ',
    ProductModel: 'Yoga Pro 14s ARH7',
    MTM: '82TL007KCD',
    ProductSeries: 'YOGA S',
    ProductBigClass: '笔记本',
    PurchaseDate: '2024-05-28 00:00:00',
    ProductDate: '2022-10-20',
  },
}

const warrantyFixture = (extRemark) => ({
  statusCode: 200,
  data: {
    detailinfo: {
      warranty: [
        { ServiceProductName: '笔记本标准服务', StartDate: '2024-05-28', EndDate: '2025-05-28', Remark: '整机1年保修' },
      ],
      onsite: [],
      other: [
        { ServiceProductName: '消费笔记本二年全面保修送修', StartDate: '2025-05-28', EndDate: '2026-05-28', Remark: extRemark },
        { ServiceProductName: '智询常伴', StartDate: '2024-05-28', EndDate: '2044-05-28', Remark: '预装软件线上咨询服务' },
      ],
    },
  },
})

function fetchFor(routes) {
  return async (url) => {
    for (const [pattern, body] of routes) {
      if (url.includes(pattern)) return typeof body === 'function' ? body(url) : json(body)
    }
    throw new Error(`夹具里没有 ${url}`)
  }
}

test('normalizeSn 只放行形状合理的主机编号，BIOS 占位符要被拦下', () => {
  assert.equal(normalizeSn(' ps00cc2j '), 'PS00CC2J')
  assert.throws(() => normalizeSn('Default string'), (e) => e instanceof ToolkitError && e.code === 'INVALID_SN')
  assert.throws(() => normalizeSn(''), ToolkitError)
})

test('保修：基础保修有效 → 电池随整机在保', async () => {
  const fetch = fetchFor([
    ['getmachineinfo', MACHINE],
    ['drivewarrantyinfo', warrantyFixture('（不包含电池）')],
  ])
  const r = await lookupWarranty('PS00CC2J', { fetch, today: '2025-01-01' })
  assert.equal(r.battery_covered, true)
  assert.match(r.battery_note, /2025-05-28/)
  assert.equal(r.machine.mtm, '82TL007KCD')
  assert.equal(r.machine.purchase_date, '2024-05-28')
})

test('保修：只剩注明「不包含电池」的延保 → 电池保外，整机仍在保', async () => {
  const fetch = fetchFor([
    ['getmachineinfo', MACHINE],
    ['drivewarrantyinfo', warrantyFixture('送修升级至整机二年保修（不包含电池）')],
  ])
  const r = await lookupWarranty('PS00CC2J', { fetch, today: '2025-12-01' })
  assert.equal(r.machine_in_warranty, true)
  assert.equal(r.battery_covered, false)
  assert.match(r.battery_note, /不包含电池/)
})

test('保修：延保没写电池 → 不确定，不替联想打包票', async () => {
  const fetch = fetchFor([
    ['getmachineinfo', MACHINE],
    ['drivewarrantyinfo', warrantyFixture('整机二年保修')],
  ])
  const r = await lookupWarranty('PS00CC2J', { fetch, today: '2025-12-01' })
  assert.equal(r.battery_covered, null)
  assert.match(r.battery_note, /门店核定/)
})

test('保修：全部硬件保修到期 → 保外，且不被 20 年期的软件咨询服务干扰', async () => {
  const fetch = fetchFor([
    ['getmachineinfo', MACHINE],
    ['drivewarrantyinfo', warrantyFixture('（不包含电池）')],
  ])
  const r = await lookupWarranty('PS00CC2J', { fetch, today: '2026-09-11' })
  assert.equal(r.machine_in_warranty, false)
  assert.equal(r.battery_covered, false)
  assert.match(r.battery_note, /2026-05-28/, '最后到期日应是硬件延保，不是智询常伴的 2044')
  assert.doesNotMatch(r.battery_note, /2044/)
})

test('保修：联想查不到 SN 时报可识别错误，而不是当成保外', async () => {
  const fetch = fetchFor([
    ['getmachineinfo', { statusCode: 200404, message: 'not found', data: null }],
    ['drivewarrantyinfo', { statusCode: 200404, data: null }],
  ])
  await assert.rejects(
    () => lookupWarranty('ZZZZZZZZ', { fetch }),
    (e) => e instanceof ToolkitError && e.code === 'SN_NOT_FOUND',
  )
})

test('保修：网络失败要区分于接口形状变化', async () => {
  const dead = async () => {
    throw new Error('fetch failed')
  }
  await assert.rejects(() => lookupWarranty('PS00CC2J', { fetch: dead }), (e) => e.code === 'NETWORK')

  const weird = fetchFor([
    ['getmachineinfo', MACHINE],
    ['drivewarrantyinfo', { statusCode: 200, data: { totally: 'different' } }],
  ])
  await assert.rejects(() => lookupWarranty('PS00CC2J', { fetch: weird }), (e) => e.code === 'UPSTREAM_SHAPE')
})

const PRICE = {
  statusCode: 200,
  data: {
    主板: { machinePriceData: { standard: { media_price: 3836 } }, faultPrice: null },
    电池: {
      machinePriceData: { standard: { media_price: 399, name: '原厂标准备件' }, preference: null, depot: null },
      faultPrice: { name: '联想保外原厂电池维修服务膨胀金', pc_link: 'https://item.lenovo.com.cn/product/1040512.html', price: '80' },
    },
  },
}

test('备件价：只取电池项，膨胀金作为定金单独返回，不和备件价混在一起', async () => {
  const r = await lookupBatteryPrice('PS00CC2J', { fetch: fetchFor([['getSmartFaultPrice', PRICE]]) })
  assert.equal(r.available, true)
  assert.equal(r.standard_price_cny, 399)
  assert.equal(r.repair_deposit.price_cny, 80)
  assert.equal(r.parts_listed, 2)
})

test('备件价：联想没公示时 available=false 而不是报错', async () => {
  const r = await lookupBatteryPrice('PS00CC2J', {
    fetch: fetchFor([['getSmartFaultPrice', { statusCode: 200, data: {} }]]),
  })
  assert.equal(r.available, false)
  assert.match(r.reason, /维护中/)
})

const STATIONS = {
  statusCode: 200,
  data: [
    { StationCode: '2', StationName: '远店', address: 'B', phone: '1', ServiceTime: '10-20', Distance: 5.1 },
    { StationCode: '1', StationName: '近店', address: 'A', phone: '2', ServiceTime: '10-19', Distance: 1.9 },
  ],
}

test('门店：按距离升序，城市名自动补「市」，无坐标时标记距离为估算', async () => {
  let seen
  const fetch = async (url) => {
    seen = url
    return json(STATIONS)
  }
  const r = await findNearestStores({ city: '北京', limit: 1 }, { fetch })
  assert.match(decodeURIComponent(seen), /city=北京市/)
  assert.equal(r.stores.length, 1)
  assert.equal(r.stores[0].name, '近店')
  assert.equal(r.distance_is_estimate, true)

  const r2 = await findNearestStores({ city: '北京市', lat: 39.9, lng: 116.4 }, { fetch })
  assert.equal(r2.distance_is_estimate, false)
})

test('门店：联想返回 200404 时给空列表和说明，不抛错', async () => {
  const r = await findNearestStores(
    { city: '圣何塞' },
    { fetch: fetchFor([['station/list', { statusCode: '200404', message: 'not find station', data: [] }]]) },
  )
  assert.deepEqual(r.stores, [])
  assert.equal(r.note, 'not find station')
})

test('IP 定位：境外出口或失败都返回 null，让上层改问用户', async () => {
  const abroad = fetchFor([['ip-api', { status: 'success', countryCode: 'US', city: 'San Jose', lat: 1, lon: 2 }]])
  assert.equal(await locateByIp({ fetch: abroad }), null)
  const cn = fetchFor([['ip-api', { status: 'success', countryCode: 'CN', city: '北京', regionName: '北京', lat: 39.9, lon: 116.4 }]])
  assert.equal((await locateByIp({ fetch: cn })).city, '北京')
  const dead = async () => {
    throw new Error('nope')
  }
  assert.equal(await locateByIp({ fetch: dead }), null)
})

test('故障描述：确定性拼接，含结论与数字，不超过表单长度', () => {
  const d = buildFaultDescription({
    conclusion: '建议更换电池',
    deviceModel: 'Yoga Pro 14s ARH7',
    designMah: '4890',
    fullMah: '3700',
    healthPct: '75',
    cycleCount: '412',
    warrantyNote: '电池按保外处理',
    batteryPriceCny: 399,
  })
  assert.match(d, /建议更换电池/)
  assert.match(d, /健康度 75%/)
  assert.match(d, /¥399/)
  assert.ok(d.length <= 300)
  assert.equal(
    buildFaultDescription({ conclusion: 'x' }),
    buildFaultDescription({ conclusion: 'x' }),
    '同样输入必须给同样输出',
  )
})

test('转人工是 mock：返回体必须自报 mock=true，回执字段齐全', () => {
  const r = mockHumanHandoff({ sn: 'PS00CC2J', summary: '摘要' })
  assert.equal(r.mock, true)
  assert.match(r.ticket_id, /^LNV-\d{8}-\d{4}$/)
  assert.ok(r.queue_position >= 1 && r.eta_minutes >= 2)
  assert.equal(r.summary_forwarded, true)
})

const LIVE_SN = process.env.LENOVO_LIVE_SN

test('线上联通性（LENOVO_LIVE_SN 指定时才跑）', { skip: !LIVE_SN }, async () => {
  const w = await lookupWarranty(LIVE_SN)
  assert.ok(w.machine.model, '应查到机型')
  assert.ok(Array.isArray(w.items) && w.items.length > 0)
  const p = await lookupBatteryPrice(LIVE_SN)
  assert.equal(typeof p.available, 'boolean')
})
