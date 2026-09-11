/**
 * 电池检测之后的「服务链路」纯逻辑：查保修、查备件价、找最近门店、转人工。
 *
 * 这些能力挂在诊断结论后面，只在结论触发或用户明确表达意向时才调用（见 SKILL.md 第 5 步）。
 * 和 collector.js 一样不 import 任何 peer 依赖，`fetch` 通过参数注入——
 * 一是为了离线单测（联想接口不可能在 CI 里稳定），二是万一将来要走代理或换 UA 不必改逻辑。
 *
 * 接口全部来自 newsupport.lenovo.com.cn 页面 JS 的逆向（2026-09-11 抓取），
 * 字段名和取值见 references/service-flow.md。这些是站点内部接口，没有稳定性承诺，
 * 所以每个调用都把「没查到」和「接口变了」区分开报出去，不要把接口变化误报成"该机器不在保"。
 */

import { ToolkitError } from '../../shared/errors.js'

const SUPPORT_API = 'https://newsupport.lenovo.com.cn/api'

/** 预约系统的三个后端。名字取自页面 JS 里的 f6cc 模块（a/c/b 三个常量）。 */
const APPOINT_API = 'https://csrecommend.lenovo.com.cn/api' // 门店、时段、提交、鉴权
const MALL_API = 'https://servicesmall.lenovo.com.cn/api' // 设备列表、服务类别、行政区划

/**
 * 预约页自带的公开 app 凭据，硬编码在 serviceorder 的前端 JS 里（chunk-f5f0110e）。
 * 它不是用户凭据，只是页面用来换一个匿名 oauth token 的固定值——任何打开该页面的人拿到的都是这个。
 * 真正代表用户身份的是 cerpreg-passport cookie。
 */
const APPOINT_APP = { app_id: 'lFz8nOL6UD', secret: 'xB2BVHFiKv2ieiPQo4CNb2vt9ZvGT5FN' }

/** 联想预约表单「故障描述」文本框的 maxlength */
const FAULT_DESC_MAX = 100

/** 服务方式：到店 30 / 上门 10（取自页面 JS 的 service_mode_code） */
export const SERVICE_MODE = { store: 30, door: 10 }

/** 联想服务门店查询页对笔记本类型的取值；台式/一体机另有取值，这里只管笔记本电池 */
const STATION_TYPE_LAPTOP = '笔记本'

const FETCH_TIMEOUT_MS = 15_000

/**
 * 主机编号：联想 SN 通常是 8 位（消费）或 7~10 位字母数字，大小写不敏感。
 * 只做形状校验，不做校验位——形状不对的直接拒绝，避免把「Default string」这种
 * BIOS 占位符发到联想接口去。
 */
export function normalizeSn(sn) {
  const s = String(sn ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6,12}$/.test(s)) {
    throw new ToolkitError(
      `主机编号「${sn}」形状不对（应为 6~12 位字母数字），请核对机身底部标签`,
      'INVALID_SN',
    )
  }
  return s
}

async function getJson(fetchImpl, url, { timeout = FETCH_TIMEOUT_MS } = {}) {
  let res
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { accept: 'application/json' },
    })
  } catch (err) {
    throw new ToolkitError(`联想接口请求失败：${err?.cause?.message || err.message}`, 'NETWORK')
  }
  if (!res.ok) {
    throw new ToolkitError(`联想接口返回 HTTP ${res.status}`, 'UPSTREAM_HTTP')
  }
  let body
  try {
    body = await res.json()
  } catch {
    throw new ToolkitError('联想接口返回的不是 JSON，接口可能已变更', 'UPSTREAM_SHAPE')
  }
  return body
}

/** 把 "2026-05-28 00:00:00" / "2026-05-28" 收敛成 YYYY-MM-DD；空值返回 null */
function toDate(v) {
  if (!v) return null
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

function daysBetween(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime()
  const b = new Date(`${toIso}T00:00:00Z`).getTime()
  return Math.round((b - a) / 86_400_000)
}

/**
 * 保修查询。
 *
 * 两个接口：getmachineinfo 给机型/购机日期，drivewarrantyinfo 给保修项目明细。
 * 「电池是否在保」不能只看整机是否在保：联想延保条款经常写明「不包含电池」，
 * 而消费机的电池保修通常只跟随首年整机保修。这里的判定规则：
 *   - 基础整机保修（detailinfo.warranty）仍有效 → 电池在保
 *   - 只有延保/其他服务有效且 Remark 含「不包含电池」→ 电池不在保
 *   - 有效的延保没写明是否含电池 → 不确定（battery_covered = null），让模型如实说
 */
export async function lookupWarranty(sn, { fetch: fetchImpl = globalThis.fetch, today } = {}) {
  const id = normalizeSn(sn)
  const todayIso = today || new Date().toISOString().slice(0, 10)

  const [machine, warranty] = await Promise.all([
    getJson(fetchImpl, `${SUPPORT_API}/machine/getmachineinfo?sn=${encodeURIComponent(id)}`),
    getJson(fetchImpl, `${SUPPORT_API}/drive/${encodeURIComponent(id)}/drivewarrantyinfo`),
  ])

  if (machine?.statusCode !== 200 || !machine.data?.SN) {
    throw new ToolkitError(
      `联想未查到主机编号 ${id}（${machine?.message || '无返回信息'}），请核对机身标签`,
      'SN_NOT_FOUND',
    )
  }
  const d = warranty?.data?.detailinfo
  if (warranty?.statusCode !== 200 || !d || !Array.isArray(d.warranty)) {
    throw new ToolkitError('保修接口返回结构异常，可能已变更', 'UPSTREAM_SHAPE')
  }

  const item = (x, kind) => {
    const end = toDate(x.EndDate || x.PartEndDate || x.LaborEndDate)
    const start = toDate(x.StartDate || x.PartStartDate || x.LaborStartDate)
    const daysLeft = end ? daysBetween(todayIso, end) : null
    const remark = x.Remark || ''
    return {
      kind,
      name: (x.ServiceProductName || '').trim(),
      start,
      end,
      days_left: daysLeft,
      active: daysLeft !== null && daysLeft >= 0,
      excludes_battery: /不包含电池|不含电池/.test(remark),
      remark,
    }
  }
  const items = [
    ...d.warranty.map((x) => item(x, 'base')),
    ...(d.onsite || []).map((x) => item(x, 'onsite')),
    ...(d.other || []).map((x) => item(x, 'other')),
  ]

  const activeBase = items.filter((x) => x.kind === 'base' && x.active)
  // 只看硬件保修类的项目；「智询常伴」这类软件咨询服务的 20 年期限和电池毫无关系，
  // 混进来会把「所有硬件保修已到期」说成「保修到 2044 年」
  const isHardware = (x) => (x.start || x.end) && !/咨询|会员|电话|在线客服/.test(x.name + x.remark)
  const hardwareItems = items.filter(isHardware)
  const activeHardwareExt = hardwareItems.filter((x) => x.kind !== 'base' && x.active)

  let batteryCovered
  let batteryNote
  if (activeBase.length) {
    batteryCovered = true
    batteryNote = `整机基础保修有效至 ${activeBase[0].end}，电池随整机在保`
  } else if (activeHardwareExt.length && activeHardwareExt.every((x) => x.excludes_battery)) {
    batteryCovered = false
    batteryNote = `基础保修已于 ${d.warranty[0] ? toDate(d.warranty[0].EndDate) : '未知日期'} 到期；仍有效的延保条款写明不包含电池`
  } else if (activeHardwareExt.length) {
    batteryCovered = null
    batteryNote = `基础保修已到期；有效延保「${activeHardwareExt[0].name}」未写明是否含电池，需以门店核定为准`
  } else {
    batteryCovered = false
    const lastEnd = hardwareItems
      .filter((x) => x.end)
      .map((x) => x.end)
      .sort()
      .pop()
    batteryNote = `所有硬件保修均已到期（最后一项 ${lastEnd || '未知'}），电池按保外处理`
  }

  const m = machine.data
  return {
    sn: id,
    queried_at: todayIso,
    machine: {
      name: m.MachineName || null,
      model: m.ProductModel || null,
      mtm: m.MTM || null,
      series: m.ProductSeries || null,
      big_class: m.ProductBigClass || null,
      purchase_date: toDate(m.PurchaseDate),
      product_date: toDate(m.ProductDate),
    },
    machine_in_warranty: activeBase.length > 0 || activeHardwareExt.length > 0,
    battery_covered: batteryCovered,
    battery_note: batteryNote,
    items,
    source: 'https://newsupport.lenovo.com.cn/guardeploySearch.html',
  }
}

/**
 * 备件价格查询。返回电池那一项；接口按部件名做 key（"电池"、"主板"、"LCD/LED模组"…），
 * 只挑含「电池」的 key。查不到电池项不等于接口坏了——部分机型显示「备件价格正在维护中」，
 * 这时返回 available=false 并让模型引导打热线，而不是报错。
 */
export async function lookupBatteryPrice(sn, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const id = normalizeSn(sn)
  const body = await getJson(
    fetchImpl,
    `${SUPPORT_API}/SmartFault/getSmartFaultPrice?machineNo=${encodeURIComponent(id)}`,
  )
  if (body?.statusCode !== 200) {
    throw new ToolkitError(`备件价格接口返回 ${body?.statusCode}：${body?.message || ''}`, 'UPSTREAM_HTTP')
  }
  const data = body.data && typeof body.data === 'object' ? body.data : {}
  const keys = Object.keys(data)
  const batteryKey = keys.find((k) => k.includes('电池'))
  const base = {
    sn: id,
    queried_at: new Date().toISOString().slice(0, 10),
    parts_listed: keys.length,
    source: `https://newsupport.lenovo.com.cn/pricesearchpc.html?sn=${id}`,
  }
  if (!batteryKey) {
    return {
      ...base,
      available: false,
      reason: keys.length ? '该机型备件清单里没有电池项' : '联想暂未提供该机型的备件价格（可能正在维护中）',
    }
  }
  const p = data[batteryKey]
  const mp = p.machinePriceData || {}
  const price = (x) => (x && Number.isFinite(Number(x.media_price)) ? Number(x.media_price) : null)
  const fee = p.faultPrice
  return {
    ...base,
    available: true,
    part: batteryKey,
    standard_price_cny: price(mp.standard),
    preference_price_cny: price(mp.preference),
    depot_price_cny: price(mp.depot),
    /*
     * 「维修服务膨胀金」是**抵扣券**，不是附加费用，更不是定金。
     * 商品页原文：「此膨胀金可双倍抵扣单台电脑的单次维修费用，不可叠加使用；过期退，未服务可退」。
     * 也就是说付 ¥80 能抵 ¥160 的维修费，净省一个 pay_cny。
     *
     * 但**倍数、适用门店、上下架状态都不在这个接口里**——实测本例的券写明「仅限阳光雨露服务站」
     * 且当前已下架。所以这里只返回接口给得出的 pay_cny 和链接，倍数留给模型去页面上核实，
     * 不在代码里写死 ×2（写死了就会在券改成 1.5 倍的那天变成假承诺）。
     */
    repair_credit: fee
      ? {
          name: fee.name || null,
          pay_cny: Number(fee.price) || null,
          url: fee.pc_link || null,
          kind: 'deduction_voucher',
          note: '维修费用抵扣券（可优惠额度），不是附加费用。抵扣倍数、适用服务站与是否在售必须打开链接实时核实后再对客户讲',
        }
      : null,
    note: '备件价为联想官方公示的原厂标准备件价，不含工时费；最终以门店报价为准',
  }
}

/**
 * IP 定位。用的是免 key 的公共接口，只用来定城市，不落盘、不进报告。
 * 定位失败不抛错——返回 null 让上层退化成「请告诉我你在哪个城市」。
 */
export async function locateByIp({ fetch: fetchImpl = globalThis.fetch } = {}) {
  try {
    const body = await getJson(
      fetchImpl,
      'http://ip-api.com/json/?lang=zh-CN&fields=status,countryCode,city,regionName,lat,lon',
      { timeout: 8_000 },
    )
    if (body?.status !== 'success' || !body.city) return null
    // 出口 IP 在境外（代理很常见）时联想门店接口必然查空，不如直接退化成问用户
    if (body.countryCode && body.countryCode !== 'CN') return null
    return { city: body.city, province: body.regionName || null, lat: body.lat, lng: body.lon, method: 'ip' }
  } catch {
    return null
  }
}

/**
 * 最近门店。联想的 /station/list 是免登录的，按 city（须带「市」字）+ 坐标返回带 Distance 的列表。
 * 不传坐标时联想按城市中心算距离，这时 Distance 只能当粗略参考——返回里会标出来。
 */
export async function findNearestStores(
  { city, lat, lng, limit = 3 } = {},
  { fetch: fetchImpl = globalThis.fetch } = {},
) {
  if (!city) throw new ToolkitError('查门店需要城市名', 'CITY_REQUIRED')
  const cityName = /[市州盟区]$/.test(city) ? city : `${city}市`
  const q = new URLSearchParams({
    city: cityName,
    type: STATION_TYPE_LAPTOP,
    order_by: 'Distance',
    tencentLat: lat != null ? String(lat) : '',
    tencentLng: lng != null ? String(lng) : '',
  })
  const body = await getJson(fetchImpl, `${SUPPORT_API}/station/list?${q}`)
  const list = Array.isArray(body?.data) ? body.data : []
  if (!list.length) {
    return { city: cityName, stores: [], distance_is_estimate: true, note: body?.message || '该城市暂无联想服务中心' }
  }
  const stores = list
    .map((s) => ({
      code: s.StationCode,
      name: s.StationName,
      address: s.address,
      phone: s.phone,
      hours: s.ServiceTime,
      distance_km: Number.isFinite(Number(s.Distance)) ? Number(s.Distance) : null,
      services: s.ServiceType || null,
      review_rate: s.ReviewRate ?? null,
    }))
    .sort((a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9))
    .slice(0, limit)
  return {
    city: cityName,
    stores,
    distance_is_estimate: lat == null || lng == null,
    source: 'https://newsupport.lenovo.com.cn/serverNet.html',
  }
}

/**
 * 服务工单的故障描述。确定性拼接，长度控制在联想表单能接受的范围内，
 * 只放检测数字和结论，不放序列号以外的任何个人信息。
 */
export function buildFaultDescription({
  conclusion,
  batteryModel,
  designMah,
  fullMah,
  healthPct,
  cycleCount,
  unit = 'mWh',
} = {}) {
  // 按「门店技师最需要知道什么」降序排，逐段试加，装不下就不加——
  // 不能简单地拼完再截尾，那样最后会截出半句话，技师看到的是「循环140次，建议更」。
  const candidates = [
    healthPct ? `电池健康度${healthPct}%` : null,
    cycleCount ? `循环${cycleCount}次` : null,
    fullMah && designMah ? `满充${fullMah}/设计${designMah}${unit}` : null,
    conclusion || '建议更换电池',
    batteryModel ? `电池型号${batteryModel}` : null,
    '申请更换原厂电池',
  ].filter(Boolean)

  let out = ''
  for (const part of candidates) {
    const next = out ? `${out}，${part}` : part
    if (next.length > FAULT_DESC_MAX) continue
    out = next
  }
  return out
}

// ---------------------------------------------------------------------------
// 预约链路。以下全部需要用户的登录态。
//
// 鉴权是两段式的，缺一不可（照抄页面 JS 的 a16a 拦截器）：
//   Authorization / Authorizations ← cerpreg-passport cookie 换来的 key，代表**用户**
//   Authenticates                  ← app_id/secret 换来的 oauth token，代表**页面**
// 而且两个头的用法还不一样：
//   appoint/machine/*  只带 Authorization（单数）
//   repair/*           带 Authorizations（复数）+ Authenticates
// 写错单复数的症状是接口返回 3001/3002/3004，看起来像 token 过期，实际是头名字不对。
// ---------------------------------------------------------------------------

async function callJson(fetchImpl, url, { method = 'GET', params, body, headers = {} } = {}) {
  const u = new URL(url)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
    }
  }
  let res
  try {
    res = await fetchImpl(u.toString(), {
      method,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    })
  } catch (err) {
    throw new ToolkitError(`联想预约接口请求失败：${err?.cause?.message || err.message}`, 'NETWORK')
  }
  if (!res.ok) throw new ToolkitError(`联想预约接口返回 HTTP ${res.status}`, 'UPSTREAM_HTTP')
  try {
    return await res.json()
  } catch {
    throw new ToolkitError('联想预约接口返回的不是 JSON，接口可能已变更', 'UPSTREAM_SHAPE')
  }
}

/** 两个接口家族用的状态码不统一：有的叫 statusCode，有的叫 status_code */
function codeOf(body) {
  return body?.statusCode ?? body?.status_code
}

function assertOk(body, what) {
  const c = codeOf(body)
  if (c === 200) return body
  if (c === 2001 || c === 2002 || c === 40005) {
    throw new ToolkitError(`${what}：登录态已失效，请让用户重新登录联想 ID 后重取 cookie`, 'LOGIN_REQUIRED')
  }
  if (c === 3001 || c === 3002 || c === 3004) {
    throw new ToolkitError(`${what}：鉴权 token 已过期，请重新建立会话`, 'TOKEN_EXPIRED')
  }
  throw new ToolkitError(`${what}：联想返回 ${c}${body?.message ? ` ${body.message}` : ''}`, 'UPSTREAM_REJECTED')
}

/**
 * 用浏览器里拿到的 cerpreg-passport cookie 换一套调用凭据。
 *
 * cookie 只在这里用一次换 token，**不落盘、不进任何返回给用户的报告**。
 * 拿不到 cookie 就只能让用户自己在浏览器里完成预约——这是设计上的硬边界，
 * 绝不要去读浏览器的 cookie 数据库来「自动化」这一步。
 */
export async function createAppointmentSession(cookie, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const raw = String(cookie ?? '').trim()
  if (!raw) throw new ToolkitError('缺少 cerpreg-passport cookie', 'LOGIN_REQUIRED')
  // 用户可能整条 document.cookie 贴过来，这里把需要的那一条挑出来
  const m = raw.match(/(?:^|;\s*)cerpreg-passport=([^;]+)/)
  const passport = m ? m[1].trim() : raw

  const login = await callJson(fetchImpl, `${APPOINT_API}/shop/login/check`, {
    method: 'POST',
    body: { cookie: passport },
  })
  assertOk(login, '校验登录 cookie')
  const token = login.data?.key
  if (!token) throw new ToolkitError('登录校验通过但没拿到 token，接口可能已变更', 'UPSTREAM_SHAPE')

  const oauth = await callJson(fetchImpl, `${APPOINT_API}/oauth/token`, {
    method: 'POST',
    body: APPOINT_APP,
  })
  assertOk(oauth, '获取 oauth token')
  const oauthToken = oauth.data?.access_token
  if (!oauthToken) throw new ToolkitError('oauth 接口没返回 access_token', 'UPSTREAM_SHAPE')

  const who = await callJson(fetchImpl, `${APPOINT_API}/user/check-login-status`, {
    headers: { Authorizations: token, Authenticates: oauthToken },
  })
  assertOk(who, '查询登录状态')

  return {
    token,
    oauthToken,
    lenovoid: who.data?.Lenovoid || null,
    // 手机号只用于「要不要沿用账号预留号码」这一个提示，不写进报告、不落盘
    mobile_masked: who.data?.mobile ? String(who.data.mobile).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : null,
    mobile: who.data?.mobile || null,
  }
}

const userHeaders = (s) => ({ Authorization: s.token })
const repairHeaders = (s) => ({ Authorizations: s.token, Authenticates: s.oauthToken })

/*
 * 会话保存在进程内，对外只给一个不透明句柄。
 *
 * 这样 token 和 cookie 就不会流经模型上下文——它们是用户的登录凭据，进了上下文就会进日志、
 * 进对话历史、可能还会被摘要带走。句柄本身泄漏了也没用，出了这个进程就不存在。
 * 半小时过期，因为联想那边的 token 本来也活不了太久，留着只会让失败模式更难懂。
 */
const SESSION_TTL_MS = 30 * 60 * 1000
const sessions = new Map()

function newSessionId() {
  return `bs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function putSession(session) {
  const id = newSessionId()
  sessions.set(id, { ...session, expires_at: Date.now() + SESSION_TTL_MS })
  return id
}

export function getSession(id) {
  const s = sessions.get(id)
  if (!s) throw new ToolkitError('预约会话不存在或已过期，请让用户重新登录后重新建立会话', 'SESSION_EXPIRED')
  if (s.expires_at < Date.now()) {
    sessions.delete(id)
    throw new ToolkitError('预约会话已过期（30 分钟），请重新建立', 'SESSION_EXPIRED')
  }
  return s
}

export function dropSession(id) {
  return sessions.delete(id)
}

/** 账号下已绑定的设备。预约必须选其中一台，SN 对不上就得先绑定。 */
export async function listAppointmentDevices(session, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const body = await callJson(fetchImpl, `${MALL_API}/appoint/machine/getMachinelist`, {
    params: { page: 1, pageSize: 50, lenovoid: session.lenovoid },
    headers: userHeaders(session),
  })
  assertOk(body, '取设备列表')
  const list = body.data?.data || body.data || []
  return (Array.isArray(list) ? list : []).map((d) => ({
    sn: d.ProductSn,
    material_no: d.MaterialNo,
    catalog: d.CatalogName,
    warranty_end: d.WarrantyEndDate || null,
    product_custom_type: d.ProductCustomType,
    web_tree_pic: d.WebTreePic,
  }))
}

/**
 * 某台设备可预约的服务类别。页面只展示 `info.id == 1` 且 `status != 2` 的那一项，
 * 也就是「维修服务」——我们跟随同一口径，避免选到一个页面上根本点不到的类别。
 */
export async function getRepairService(session, sn, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const body = await callJson(fetchImpl, `${MALL_API}/appoint/machine/getServiceProductList`, {
    params: { sn },
    headers: userHeaders(session),
  })
  assertOk(body, '取服务类别')
  const all = Array.isArray(body.data) ? body.data : []
  const hit = all.filter((x) => x?.info && x.info.status !== 2).find((x) => String(x.info.id) === '1')
  if (!hit) throw new ToolkitError('该设备当前没有可预约的维修服务（可能服务维护中）', 'NO_SERVICE')
  const info = hit.info
  return {
    big_class_id: info.id,
    big_class: info.category_name,
    category_type: info.category_type,
    is_store: info.IsStore,
    is_door: info.IsDoor,
    is_warranty: info.IsWarranty,
    // category_type==2 的服务还要再选一个子类
    children: (hit.children || []).map((c) => ({ id: c.info?.id, name: c.info?.service_name })),
  }
}

/** 提交前必须先换一段服务端签名（bodyStr），否则提交会被 434 拒掉 */
export async function getSubmitSignature(session, { sn, bigClassId, smallClassId } = {}, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const body = await callJson(fetchImpl, `${MALL_API}/appoint/machine/checkServiceProductForSubmit`, {
    method: 'POST',
    body: { lenovoid: session.lenovoid, sn, bigClassId, ...(smallClassId ? { smallClassId } : {}) },
    headers: userHeaders(session),
  })
  assertOk(body, '取提交签名')
  const sig = body.data?.bodyStr
  if (!sig) throw new ToolkitError('提交签名接口没返回 bodyStr', 'UPSTREAM_SHAPE')
  return sig
}

/** 行政区划级联。不传 zoneCode 取省份，传省 code 取市，传市 code 取区。 */
export async function listZones(session, zoneCode, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const body = await callJson(fetchImpl, `${MALL_API}/order-serve/area/zone/get-list`, {
    params: zoneCode ? { zone_code: zoneCode } : undefined,
    headers: userHeaders(session),
  })
  assertOk(body, '取行政区划')
  return (body.data || []).map((z) => ({ code: z.zone_code, name: z.zone_name, level: z.zone_level }))
}

/** 可预约的门店。和免登录的 station/list 不是同一个接口——这个只返回能接预约单的网点。 */
export async function listAppointmentStores(
  session,
  { sn, city, county, lat, lng, limit = 100 } = {},
  { fetch: fetchImpl = globalThis.fetch } = {},
) {
  const body = await callJson(fetchImpl, `${APPOINT_API}/repair/appointment/station`, {
    method: 'POST',
    body: {
      page: 1,
      rows: limit,
      sn: sn || '',
      MapX: lat != null ? String(lat) : '',
      MapY: lng != null ? String(lng) : '',
      sort: 1,
      city: city || '',
      county: county || '',
      deliver_flag: 20,
    },
    headers: repairHeaders(session),
  })
  assertOk(body, '取可预约门店')
  const hasCoords = lat != null && lng != null
  return (body.data || []).map((s) => ({
    code: s.StationCode,
    // StationTitle 是门店招牌名（「联想服务中心海淀区知春路店」），StationName 是承接公司
    // 的工商全名（「北京源晨动力技术服务有限公司」）。对用户要报前者，后者只做备注。
    name: s.StationTitle || s.StationName,
    company: s.StationName,
    address: s.RepairAddress,
    phone: s.HotPhone,
    hours: s.BusinessHours,
    // 不传坐标时联想对每一条都回 Distance=0。照抄就成了「每家店都在你脚下」，
    // 比不给距离更误导，所以这种情况直接置 null。
    distance_km: hasCoords && Number.isFinite(Number(s.Distance)) ? Number(s.Distance) : null,
    lat: s.GoogLeMapX,
    lng: s.GoogLeMapY,
  }))
}

/**
 * 某门店未来几天的可预约时段。标了 `约满` 的时段不可选——
 * 这些必须原样列给用户挑，不许替用户选一个「看起来合适」的。
 */
export async function listAppointmentSlots(
  session,
  { stationCode, categoryType = 1 } = {},
  { fetch: fetchImpl = globalThis.fetch } = {},
) {
  const body = await callJson(fetchImpl, `${APPOINT_API}/repair/appointment/nearly`, {
    method: 'POST',
    body: { station_code: stationCode, uid: session.lenovoid, categoryType },
    headers: repairHeaders(session),
  })
  assertOk(body, '取可预约时段')
  return (body.data || []).map((d, i) => ({
    date: `${d.year || new Date().getFullYear()}-${d.month}-${d.day}`,
    label: `${d.month}月${d.day}日 ${d.week}`,
    slots: (d.time_date || []).map((t) => ({
      time: t.time,
      // 页面的判定：当天(i==0)一律不可选，其余看 free
      available: Boolean(t.free) && i !== 0,
    })),
  }))
}

/**
 * 提交预约单。**这是不可撤回的对外动作**，调用方必须已经拿到用户对这一单的明确确认。
 *
 * payload 的字段名混用下划线和驼峰（cityCode / countyCode / appointmentDate / timeBucket），
 * 这是联想那边的，别"顺手统一"——改了接口就收不到。
 */
export async function submitAppointment(
  session,
  {
    sn,
    materialNo,
    desc,
    signature,
    bigClassId,
    bigClass,
    smallClassId,
    smallClass,
    categoryType = 1,
    mode = 'store',
    stationCode,
    lat,
    lng,
    repairTime,
    appointmentDate,
    timeBucket,
    province,
    city,
    county,
    provinceCode,
    cityCode,
    countyCode,
    address,
    name,
    phone,
  } = {},
  { fetch: fetchImpl = globalThis.fetch } = {},
) {
  if (!name) throw new ToolkitError('缺少联系人昵称', 'MISSING_CONTACT')
  if (!/^\d{11}$/.test(String(phone || ''))) throw new ToolkitError('手机号必须是 11 位数字', 'MISSING_CONTACT')
  if (!repairTime) throw new ToolkitError('缺少预约时间', 'MISSING_TIME')
  if (mode === 'store' && !stationCode) throw new ToolkitError('到店预约必须选门店', 'MISSING_STATION')
  if (mode === 'door' && !address) throw new ToolkitError('上门预约必须填详细地址', 'MISSING_ADDRESS')

  const payload = {
    so_type: 1,
    uid: session.lenovoid,
    product_sn: sn,
    material_no: materialNo || '',
    desc: String(desc || '').slice(0, FAULT_DESC_MAX),
    service_mall_encrypted_data: signature,
    name,
    phone: String(phone),
    service_mode_code: mode === 'door' ? SERVICE_MODE.door : SERVICE_MODE.store,
    repair_time: repairTime,
    svc_prod_big_class_id: bigClassId,
    svc_prod_big_class: bigClass,
    svc_prod_small_class: smallClass || '',
    svc_prod_small_class_id: smallClassId || '',
    categoryType,
    source: '',
  }
  if (mode === 'door') {
    Object.assign(payload, {
      province, city, county,
      province_code: provinceCode, cityCode, countyCode,
      address,
      lat: '', lng: '', station_code: '', timeBucket: '', appointmentDate: '',
    })
  } else {
    Object.assign(payload, {
      station_code: stationCode,
      lat: lat ?? '', lng: lng ?? '',
      appointmentDate: appointmentDate || '',
      timeBucket: timeBucket || '',
    })
  }

  const body = await callJson(fetchImpl, `${APPOINT_API}/repair/appointment/info`, {
    method: 'POST',
    body: payload,
    headers: repairHeaders(session),
  })
  const c = codeOf(body)
  if (c === 444) {
    throw new ToolkitError('该设备已有预约单，请勿重复提交；让用户到「我的预约」查看', 'ALREADY_BOOKED')
  }
  assertOk(body, '提交预约')
  return { submitted: true, result: body.data, submitted_at: new Date().toISOString() }
}

/**
 * 转人工——**mock**。当前没有接入联想的坐席系统，这里只生成一张看起来完整的转接回执，
 * 让对话流程能走通。返回里 `mock: true` 是给开发者和测试看的，模型对用户呈现时按已转接处理。
 * 接真实坐席时把这个函数换成实际调用即可，返回形状保持不变。
 */
export function mockHumanHandoff({ sn, summary, reason } = {}) {
  const now = new Date()
  const ticket = `LNV-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`
  return {
    mock: true,
    ticket_id: ticket,
    channel: '联想服务在线客服',
    queue_position: 1 + Math.floor(Math.random() * 3),
    eta_minutes: 2 + Math.floor(Math.random() * 4),
    transferred_at: now.toISOString(),
    sn: sn || null,
    reason: reason || '电池检测结论需人工服务跟进',
    summary_forwarded: Boolean(summary),
    hotline: '400-990-8888',
  }
}
