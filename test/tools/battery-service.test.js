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
  createAppointmentSession,
  dropSession,
  findNearestStores,
  getSession,
  listAppointmentSlots,
  listAppointmentStores,
  locateByIp,
  lookupBatteryPrice,
  lookupWarranty,
  mockHumanHandoff,
  normalizeSn,
  putSession,
  submitAppointment,
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

test('备件价：只取电池项，膨胀金作为抵扣券单独返回，不和备件价混在一起', async () => {
  const r = await lookupBatteryPrice('PS00CC2J', { fetch: fetchFor([['getSmartFaultPrice', PRICE]]) })
  assert.equal(r.available, true)
  assert.equal(r.standard_price_cny, 399)
  assert.equal(r.parts_listed, 2)

  // 膨胀金是「可优惠额度」而不是附加费用；倍数不在接口里，所以不能在代码里写死
  assert.equal(r.repair_credit.pay_cny, 80)
  assert.equal(r.repair_credit.kind, 'deduction_voucher')
  assert.match(r.repair_credit.note, /抵扣券|优惠/)
  assert.match(r.repair_credit.note, /核实/)
  assert.equal(r.repair_credit.deduction_cny, undefined, '抵扣额不在接口里，不许臆造')
  assert.equal(r.repair_deposit, undefined, '旧的「定金」口径必须彻底消失')
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

test('故障描述：确定性拼接，含结论与数字，且必须塞得进 100 字的表单', () => {
  const d = buildFaultDescription({
    conclusion: '建议更换电池',
    batteryModel: 'L21D4PE0',
    designMah: '70000',
    fullMah: '60670',
    healthPct: '86.7',
    cycleCount: '140',
    unit: 'mWh',
  })
  assert.match(d, /建议更换电池/)
  assert.match(d, /86\.7%/)
  assert.match(d, /循环140次/)
  assert.match(d, /mWh/, '单位要跟平台走，Windows 是 mWh 不是 mAh')
  assert.ok(d.length <= 100, `故障描述 ${d.length} 字，超了联想表单的 100 字上限`)
  assert.equal(
    buildFaultDescription({ conclusion: 'x' }),
    buildFaultDescription({ conclusion: 'x' }),
    '同样输入必须给同样输出',
  )
})

test('故障描述：装不下的字段整段丢弃，不能截出半句话', () => {
  const d = buildFaultDescription({
    conclusion: '需要送修检测'.repeat(12), // 单这一段就 72 字
    healthPct: '86.7',
    cycleCount: '140',
    batteryModel: 'L21D4PE0',
  })
  assert.ok(d.length <= 100)
  // 结论塞进去之后就没地方放电池型号了，那它就该整段不出现，而不是出现半个
  assert.ok(!/电池型号L?$|电池型号L21D?$/.test(d), `尾部被截断了：${d}`)
  for (const seg of d.split('，')) {
    assert.ok(seg.length > 0)
  }
})

test('转人工是 mock：返回体必须自报 mock=true，回执字段齐全', () => {
  const r = mockHumanHandoff({ sn: 'PS00CC2J', summary: '摘要' })
  assert.equal(r.mock, true)
  assert.match(r.ticket_id, /^LNV-\d{8}-\d{4}$/)
  assert.ok(r.queue_position >= 1 && r.eta_minutes >= 2)
  assert.equal(r.summary_forwarded, true)
})

// --- 预约链路 ---

const APPOINT_OK = [
  ['shop/login/check', { statusCode: 200, data: { key: 'USER_TOKEN' } }],
  ['oauth/token', { statusCode: 200, data: { access_token: 'OAUTH_TOKEN' } }],
  ['user/check-login-status', { statusCode: 200, data: { Lenovoid: 'uid-1', mobile: '13800001111' } }],
]

test('建立预约会话：从整条 document.cookie 里挑出 passport，并换到两个 token', async () => {
  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url, body: init.body, headers: init.headers })
    for (const [p, b] of APPOINT_OK) if (url.includes(p)) return json(b)
    throw new Error(`未预期的 ${url}`)
  }
  const s = await createAppointmentSession('leid=x; cerpreg-passport=ABC123DEF; Hm_lvt=9', { fetch })
  assert.equal(s.token, 'USER_TOKEN')
  assert.equal(s.oauthToken, 'OAUTH_TOKEN')
  assert.equal(s.lenovoid, 'uid-1')
  assert.equal(s.mobile_masked, '138****1111', '手机号对外要打码')

  assert.equal(JSON.parse(seen[0].body).cookie, 'ABC123DEF', '只能把 passport 这一条发出去')
  // 单复数写错就会被联想当成未授权，这里钉死
  const who = seen.find((r) => r.url.includes('check-login-status'))
  assert.equal(who.headers.Authorizations, 'USER_TOKEN')
  assert.equal(who.headers.Authenticates, 'OAUTH_TOKEN')
  assert.equal(who.headers.Authorization, undefined)
})

test('建立预约会话：登录态失效要报 LOGIN_REQUIRED，而不是笼统的失败', async () => {
  const fetch = fetchFor([['shop/login/check', { statusCode: 2001, message: 'not login' }]])
  await assert.rejects(
    () => createAppointmentSession('cerpreg-passport=x', { fetch }),
    (e) => e instanceof ToolkitError && e.code === 'LOGIN_REQUIRED',
  )
  await assert.rejects(
    () => createAppointmentSession('  ', { fetch }),
    (e) => e.code === 'LOGIN_REQUIRED',
  )
})

test('会话句柄：token 不进模型上下文，过期后明确报错', () => {
  const id = putSession({ token: 'T', oauthToken: 'O', lenovoid: 'u' })
  assert.match(id, /^bs_/)
  assert.equal(getSession(id).token, 'T')

  assert.throws(() => getSession('bs_nope'), (e) => e.code === 'SESSION_EXPIRED')
  assert.equal(dropSession(id), true)
  assert.throws(() => getSession(id), (e) => e.code === 'SESSION_EXPIRED')
})

/**
 * 可预约门店接口的字段名和免登录那个 station/list 完全不同——
 * 实跑时才发现 address/phone 一直是空的，因为我按 station/list 的 Address/Phone 猜的。
 */
test('可预约门店：按 RepairAddress/HotPhone/StationTitle 取值，不传坐标时距离置 null', async () => {
  const raw = {
    statusCode: 200,
    data: [
      {
        StationCode: '21000500',
        StationName: '北京源晨动力技术服务有限公司',
        StationTitle: '联想服务中心海淀区知春路店',
        RepairAddress: '海淀区知春路17号联想客户服务中心',
        HotPhone: '010-62059288',
        BusinessHours: '周一至周日9:00-18:00',
        GoogLeMapX: '39.982485',
        GoogLeMapY: '116.353099',
        Distance: 0,
      },
    ],
  }
  const fetch = fetchFor([['repair/appointment/station', raw]])
  const s = (await listAppointmentStores({ token: 'T', oauthToken: 'O' }, { sn: 'X' }, { fetch }))[0]
  assert.equal(s.name, '联想服务中心海淀区知春路店', '要报门店招牌名，不是承接公司工商名')
  assert.equal(s.company, '北京源晨动力技术服务有限公司')
  assert.equal(s.address, '海淀区知春路17号联想客户服务中心')
  assert.equal(s.phone, '010-62059288')
  assert.equal(s.hours, '周一至周日9:00-18:00')
  // 不传坐标时联想对每条都回 0，照抄就成了「每家店都在你脚下」
  assert.equal(s.distance_km, null)

  const withCoords = (
    await listAppointmentStores({ token: 'T', oauthToken: 'O' }, { sn: 'X', lat: 39.9, lng: 116.4 }, { fetch })
  )[0]
  assert.equal(withCoords.distance_km, 0)
})

test('可预约时段：当天一律不可选，约满的也不可选', async () => {
  const fetch = fetchFor([
    [
      'repair/appointment/nearly',
      {
        statusCode: 200,
        data: [
          { year: 2026, month: '09', day: '11', week: '星期五', time_date: [{ time: '10:00-11:00', free: 5 }] },
          {
            year: 2026, month: '09', day: '12', week: '星期六',
            time_date: [{ time: '10:00-11:00', free: 3 }, { time: '11:00-12:00', free: 0 }],
          },
        ],
      },
    ],
  ])
  const days = await listAppointmentSlots({ token: 'T', oauthToken: 'O', lenovoid: 'u' }, { stationCode: '21006256' }, { fetch })
  assert.equal(days[0].slots[0].available, false, '当天不可预约')
  assert.equal(days[1].slots[0].available, true)
  assert.equal(days[1].slots[1].available, false, 'free=0 是约满')
})

const SESSION = { token: 'T', oauthToken: 'O', lenovoid: 'uid-1' }
const baseSubmit = {
  sn: 'PS00CC2J', desc: '电池健康度86.7%', signature: 'SIG', bigClassId: 1, bigClass: '维修服务',
  stationCode: '21006256', repairTime: '2026-9-12 10:00', appointmentDate: '2026-9-12',
  timeBucket: '10:00-11:00', name: '张三', phone: '13800001111',
}

test('提交预约：到店单带门店和时段，service_mode_code=30', async () => {
  let sent
  const fetch = async (url, init) => {
    sent = JSON.parse(init.body)
    return json({ statusCode: 200, data: { so_no: 'SO123' } })
  }
  const r = await submitAppointment(SESSION, baseSubmit, { fetch })
  assert.equal(r.submitted, true)
  assert.equal(r.result.so_no, 'SO123')
  assert.equal(sent.service_mode_code, 30)
  assert.equal(sent.station_code, '21006256')
  assert.equal(sent.uid, 'uid-1')
  assert.equal(sent.service_mall_encrypted_data, 'SIG')
  assert.equal(sent.so_type, 1)
})

test('提交预约：上门单清掉门店字段，带地址，service_mode_code=10', async () => {
  let sent
  const fetch = async (url, init) => {
    sent = JSON.parse(init.body)
    return json({ statusCode: 200, data: {} })
  }
  await submitAppointment(
    SESSION,
    { ...baseSubmit, mode: 'door', address: '某路 1 号', province: '北京市', city: '北京市', county: '东城区' },
    { fetch },
  )
  assert.equal(sent.service_mode_code, 10)
  assert.equal(sent.station_code, '')
  assert.equal(sent.address, '某路 1 号')
})

test('提交预约：缺联系人/手机号/时间/门店时本地就拦下，不空打联想接口', async () => {
  const boom = async () => {
    throw new Error('不该发出请求')
  }
  const cases = [
    [{ ...baseSubmit, name: '' }, 'MISSING_CONTACT'],
    [{ ...baseSubmit, phone: '138' }, 'MISSING_CONTACT'],
    [{ ...baseSubmit, repairTime: '' }, 'MISSING_TIME'],
    [{ ...baseSubmit, stationCode: '' }, 'MISSING_STATION'],
    [{ ...baseSubmit, mode: 'door', address: '' }, 'MISSING_ADDRESS'],
  ]
  for (const [payload, code] of cases) {
    await assert.rejects(() => submitAppointment(SESSION, payload, { fetch: boom }), (e) => e.code === code)
  }
})

test('提交预约：故障描述超 100 字要在发出前截断', async () => {
  let sent
  const fetch = async (url, init) => {
    sent = JSON.parse(init.body)
    return json({ statusCode: 200, data: {} })
  }
  await submitAppointment(SESSION, { ...baseSubmit, desc: '啊'.repeat(250) }, { fetch })
  assert.equal(sent.desc.length, 100)
})

test('提交预约：重复预约报 ALREADY_BOOKED，不要让上层傻重试', async () => {
  const fetch = async () => json({ statusCode: 444, message: '已预约' })
  await assert.rejects(
    () => submitAppointment(SESSION, baseSubmit, { fetch }),
    (e) => e.code === 'ALREADY_BOOKED',
  )
})

const LIVE_SN = process.env.LENOVO_LIVE_SN

test('线上联通性（LENOVO_LIVE_SN 指定时才跑）', { skip: !LIVE_SN }, async () => {
  const w = await lookupWarranty(LIVE_SN)
  assert.ok(w.machine.model, '应查到机型')
  assert.ok(Array.isArray(w.items) && w.items.length > 0)
  const p = await lookupBatteryPrice(LIVE_SN)
  assert.equal(typeof p.available, 'boolean')
})
