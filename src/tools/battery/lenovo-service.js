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
    // 「膨胀金」是保外维修的预付定金商品，不是电池价格；两者要分开讲，别让客户以为电池只要 80 块
    repair_deposit: fee
      ? { name: fee.name || null, price_cny: Number(fee.price) || null, url: fee.pc_link || null }
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
  deviceModel,
  batteryModel,
  designMah,
  fullMah,
  healthPct,
  cycleCount,
  warrantyNote,
  batteryPriceCny,
} = {}) {
  const lines = [
    `【电池健康检测】结论：${conclusion || '建议更换电池'}`,
    `机型 ${deviceModel || '未知'}，电池 ${batteryModel || '未知'}`,
    `设计容量 ${designMah || '?'}mAh，满充 ${fullMah || '?'}mAh，健康度 ${healthPct || '?'}%，循环 ${cycleCount || '?'} 次`,
  ]
  if (warrantyNote) lines.push(`保修：${warrantyNote}`)
  if (batteryPriceCny != null && Number.isFinite(Number(batteryPriceCny))) {
    lines.push(`官网备件价：电池 ¥${Number(batteryPriceCny)}`)
  }
  lines.push('诉求：更换原厂电池')
  return lines.join('；').slice(0, 300)
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
