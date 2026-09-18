#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as api from './service-lib/api.mjs'
import { ToolkitError } from './service-lib/errors.mjs'
import { locateCurrent, searchLocations } from './service-lib/location.mjs'
import { launchBrowser, attachBrowser, readPassport, openPage, closeBrowser, browserAlive, probeBrowser, LOGIN_URL, ORDER_URL, STORES_URL } from './service-lib/browser.mjs'
import { ensureNode, NODE_MIN_MAJOR } from './service-lib/runtime.mjs'
import { DEFAULT_STATE_PATH, fileStore, freshState, memoryStore } from './service-lib/state.mjs'

const fail = (message, code) => { throw new ToolkitError(message, code) }
const HOTLINE = '400-990-8888'
export const ACTIONS = ['status', 'warranty', 'price', 'quote', 'stores', 'select-store', 'login', 'order-page', 'auth', 'zones', 'options', 'prepare', 'submit', 'close']

export async function runtimeCapabilities() {
  return { node_version: process.version, browser_found: await probeBrowser() }
}
const compact = (value) => String(value || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
const publicLocation = (place) => place && ({ id: place.id, title: place.title, address: place.address, city: place.city, district: place.district, source: place.source, precise: place.precise })

function chooseAddressCandidate(query, places) {
  if (places.length === 1) return places[0]
  const q = compact(query)
  const scored = places.map((place) => {
    const title = compact(place.title)
    const address = compact(place.address)
    let score = 0
    if (q === title || q === address) score = 100
    else if (title && q.endsWith(title)) score = 90
    else if (address && (q.includes(address) || address.includes(q))) score = 80
    return { place, score }
  }).sort((a, b) => b.score - a.score)
  return scored[0]?.score >= 80 && scored[0].score > (scored[1]?.score || 0) ? scored[0].place : null
}

function isAreaLocation(query, place) {
  return /(?:省|市|区|县|州|盟)$/.test(String(query || '').trim()) || /行政地名/.test(place?.category || '')
}

/*
 * 所有状态放在一个可序列化对象 s 里，由 store 决定它活在内存（--stdio、单测）还是文件（CLI）。
 * 每个动作：load → 改 s → save；close 则 clear。这样每次工具调用起一个新进程也能接着上一步做。
 */
export function createService({ client = api, locationApi = { locateCurrent, searchLocations }, browserApi: injectedBrowserApi = {}, now = Date.now, store = memoryStore() } = {}) {
  const browserApi = { launchBrowser, attachBrowser, readPassport, openPage, closeBrowser, browserAlive, ...injectedBrowserApi }
  const auth = s => {
    if (!s.session || now() >= s.session.expires) fail('请在专用登录窗口完成登录，再调用 auth；无需复制 cookie', 'LOGIN_REQUIRED')
    return s.session
  }
  const requireDevice = s => { auth(s); if (!s.device || !s.service) fail('请先 auth 并选择已绑定设备', 'DEVICE_REQUIRED') }
  const selectStore = (s, code) => {
    s.preferred_store = s.nearby_stores.find((store) => String(store.code) === String(code || '')) || null
    if (!s.preferred_store) fail('所选门店不在刚才的附近门店列表中，请重新查询', 'STATION_UNAVAILABLE')
    return s.preferred_store
  }
  const requireSn = (s, value) => {
    const sn = value || s.sn
    if (!sn) fail('缺少主机编号', 'INVALID_SN')
    s.sn = client.normalizeSn(sn)
    return s.sn
  }
  const requireBrowser = s => { if (!s.browser) fail('请先 login', 'BROWSER_REQUIRED'); return s.browser }
  /** 真实探测，不信状态文件：浏览器没了就清掉句柄，让后续报错和 status 都反映现实。 */
  const browserOpen = async s => {
    if (!s.browser) return false
    if (await browserApi.browserAlive(s.browser)) return true
    s.browser = null
    return false
  }

  async function queryOptions(s, req) {
    requireDevice(s)
    s.draft = null
    const city = req.city || s.location?.city
    const county = req.county || s.location?.district
    const lat = req.lat ?? s.location?.lat
    const lng = req.lng ?? s.location?.lng
    s.stores = await client.listAppointmentStores(s.session, { sn: s.sn, city, county, lat, lng })
    s.days = []; s.slot_station = null
    const requestedCode = req.stationCode || s.preferred_store?.code
    if (requestedCode) {
      const availableStore = s.stores.find(st => String(st.code) === String(requestedCode))
      if (!availableStore && req.stationCode) fail('所选门店不在当前可预约列表，请重新选择', 'STATION_UNAVAILABLE')
      if (!availableStore) {
        return { state: 'selected_store_unavailable', preferred_store: s.preferred_store, stores: s.stores.slice(0, 5), days: [], service: s.service, message: '所选附近门店当前不在可预约列表中，请从返回的门店里另选一家', next: '让用户从 stores 里改选，再调用 options --stationCode <code>' }
      }
      s.preferred_store = availableStore
      s.days = await client.listAppointmentSlots(s.session, { stationCode: availableStore.code, categoryType: s.service.category_type })
      s.slot_station = String(availableStore.code)
    }
    return {
      ...(requestedCode ? {} : { stores: s.stores }),
      selected_store: requestedCode ? s.preferred_store : null,
      days: s.days, service: s.service, distance_is_estimate: !s.location?.precise,
      next: requestedCode
        ? '只列 available=true 的日期和时段让用户选，同时收集姓名和 11 位手机号，然后 prepare'
        : '让用户从 stores 里选一家，再调用 options --stationCode <code>',
    }
  }

  /** 打开登录页：已有浏览器就复用；连不上（用户关了或宿主回收了）就重新拉起一个。 */
  async function openLogin(s, req) {
    if (await browserOpen(s)) {
      try { await browserApi.openPage(s.browser, LOGIN_URL); return { reused: true } }
      catch (error) { if (error.code !== 'BROWSER_CLOSED') throw error; s.browser = null }
    }
    s.browser = req.endpoint ? await browserApi.attachBrowser(req) : await browserApi.launchBrowser({ browserPath: req.browserPath })
    return { reused: false }
  }

  async function dispatch(s, req) {
    const { action } = req
    switch (action) {
      case 'status': return { ...(await runtimeCapabilities()), authenticated: Boolean(s.session && now() < s.session.expires), browser_open: await browserOpen(s), browser_launched_via: s.browser?.launched_via || null, sn: s.sn, location: publicLocation(s.location), selected_store: s.preferred_store, prepared: Boolean(s.draft), submission_attempted: s.attempted, receipt: s.receipt, next: '状态仅供排错；按 standalone-service.md 主线继续' }
      case 'warranty': return { ...(await client.lookupWarranty(requireSn(s, req.sn))), next: '把 battery_covered / battery_note 写进「服务推荐」；用 machine.mtm 补全报告里的 MTM' }
      case 'price': return { ...(await client.lookupBatteryPrice(requireSn(s, req.sn))), next: 'available=true 报 standard_price_cny（不含工时）；否则引导热线，不估价' }
      case 'quote': {
        const sn = requireSn(s, req.sn)
        const [warranty, price] = await Promise.all([client.lookupWarranty(sn), client.lookupBatteryPrice(sn)])
        return { warranty, price, next: '写「服务推荐」节：保修状态 + 备件价，然后让用户选 预约门店 / 人工热线' }
      }
      case 'stores': {
        s.preferred_store = null
        let selectedLocation
        if (req.lat != null && req.lng != null) {
          selectedLocation = {
            title: req.address || req.city || '宿主定位', address: req.address || null,
            city: req.city, district: req.county || null, lat: Number(req.lat), lng: Number(req.lng),
            source: req.locationSource || 'browser', precise: ['browser', 'user_map'].includes(req.locationSource || 'browser'),
          }
        } else if (req.locationId) {
          selectedLocation = s.places.find((place) => place.id === String(req.locationId))
          if (!selectedLocation) fail('地址候选已失效，请重新查询附近门店', 'LOCATION_SELECTION_REQUIRED')
          selectedLocation = { ...selectedLocation, source: req.locationSource || 'user_map', precise: !isAreaLocation(req.address, selectedLocation) }
        } else if (req.address || req.query) {
          const query = req.address || req.query
          try {
            s.places = await locationApi.searchLocations({ query, region: req.city, limit: req.locationLimit || 5 })
          } catch (error) {
            if (!['LOCATION_NETWORK', 'LOCATION_UPSTREAM'].includes(error.code)) throw error
            return { state: 'location_required', reason: 'address_lookup_failed', message: '位置服务暂时异常，请补充城市和附近地标后重试', manual_map_url: STORES_URL }
          }
          if (!s.places.length) {
            return { state: 'location_required', reason: 'address_not_found', message: '没有识别到这个位置，请补充城市、区县或附近地标', manual_map_url: STORES_URL }
          }
          const chosen = chooseAddressCandidate(query, s.places)
          if (!chosen) {
            return { state: 'location_selection_required', locations: s.places.map(publicLocation), message: '找到多个可能的位置，请选择一个作为查询中心', next: '让用户选一个，再调用 stores --locationId <id>' }
          }
          selectedLocation = { ...chosen, source: isAreaLocation(query, chosen) ? 'unknown' : 'user_map', precise: !isAreaLocation(query, chosen) }
        } else if (s.location) {
          selectedLocation = s.location
        } else {
          try {
            selectedLocation = await locationApi.locateCurrent()
          } catch (error) {
            if (!['LOCATION_NETWORK', 'LOCATION_UPSTREAM'].includes(error.code)) throw error
            return { state: 'location_required', reason: 'auto_location_failed', message: '自动定位失败，请提供城市和中心地址或附近地标', manual_map_url: STORES_URL }
          }
        }
        s.location = selectedLocation
        const result = await client.findNearestStores({ city: s.location.city, lat: s.location.lat, lng: s.location.lng, locationSource: s.location.source, limit: req.limit || 3 })
        s.nearby_stores = result.stores || []
        if (!s.nearby_stores.length && s.location.source === 'ip') {
          return { ...result, state: 'location_required', reason: 'auto_location_no_stores', location: publicLocation(s.location), message: '自动定位附近未返回门店，请提供城市和中心地址或附近地标' }
        }
        return { ...result, location: publicLocation(s.location), next: '先突出最近一家，再列 2–3 家备选；用户选定后调用 login --stationCode <code>' }
      }
      case 'select-store': {
        const store = selectStore(s, req.stationCode)
        return { selected_store: store, next: '调用 login，让用户登录联想 ID 后核验该店可预约时段' }
      }
      case 'login': {
        // 带 stationCode 时等价于 select-store + login，少一次往返。
        if (req.stationCode) selectStore(s, req.stationCode)
        const { reused } = await openLogin(s, req)
        return { state: 'waiting_for_login', browser_reused: reused, browser_launched_via: s.browser.launched_via || null, selected_store: s.preferred_store, message: '已打开专用登录窗口，请用户本人在窗口里登录联想 ID（可能有拼图验证）', next: '等用户说登录完成后调用 auth；不代填账号、密码、验证码，不询问 cookie' }
      }
      case 'order-page': {
        await browserApi.openPage(requireBrowser(s), ORDER_URL)
        return { state: 'order_page_open', next: '等页面完成单点登录后再 auth 一次' }
      }
      case 'auth': {
        if (s.browser && !(await browserOpen(s))) fail('专用浏览器已关闭', 'BROWSER_CLOSED')
        const browser = requireBrowser(s)
        s.session = null; s.device = null; s.service = null; s.draft = null
        const sn = requireSn(s, req.sn)
        const passport = await browserApi.readPassport(browser)
        if (!passport) return { state: 'waiting_for_login', authenticated: false, next: '若用户说已登录，调用 order-page 完成预约站单点登录，再 auth；否则继续等' }
        // 不把原始 cookie、token 或完整账号信息放入返回值。
        const session = await client.createAppointmentSession(passport)
        s.session = { token: session.token, oauthToken: session.oauthToken, lenovoid: session.lenovoid, expires: now() + 30 * 60 * 1000 }
        s.stores = []; s.days = []; s.slot_station = null
        const devices = await client.listAppointmentDevices(s.session)
        s.device = devices.find(d => String(d.sn).toUpperCase() === sn) || null
        if (!s.device) return { authenticated: true, sn_bound: false, sn, next: '用户在预约页自行绑定设备后重新 auth' }
        s.service = await client.getRepairService(s.session, sn)
        const result = { authenticated: true, sn_bound: true, sn, service: s.service, expires_in_minutes: 30 }
        // 已选门店时顺带核验并取时段，省一次 options 往返；失败不影响 auth 本身的结果。
        if (s.preferred_store && req.withOptions !== false) {
          try { result.options = await queryOptions(s, {}) }
          catch (error) { result.options_error = { code: error.code || 'UPSTREAM_REJECTED', message: safeMessage(error.code) } }
        }
        result.next = result.options?.days?.length
          ? '用 options.days 里 available=true 的时段让用户选，同时收集姓名和手机号，然后 prepare'
          : result.options ? result.options.next : '调用 options 核验门店并取时段'
        return result
      }
      case 'zones': return client.listZones(auth(s), req.zoneCode)
      case 'options': return queryOptions(s, req)
      case 'prepare': {
        requireDevice(s)
        if (s.attempted) fail('已经尝试提交，请先核对我的预约，禁止重复下单', 'SUBMISSION_ALREADY_ATTEMPTED')
        if (req.mode && req.mode !== 'store' && req.mode !== 'door') fail('未知服务方式', 'INVALID_MODE')
        const mode = req.mode || 'store'
        if (String(mode === 'store' ? s.service.is_store : s.service.is_door) !== '1') fail('该设备不支持所选服务方式', 'MODE_UNAVAILABLE')
        if (String(s.service.category_type) === '2') fail('此维修类别需要额外子类，请核实接口支持后继续', 'SERVICE_SUBTYPE_REQUIRED')
        if (!String(req.name || '').trim() || !/^\d{11}$/.test(String(req.phone || ''))) fail('需要用户提供联系人和11位手机号', 'MISSING_CONTACT')
        if (!req.desc || String(req.desc).length > 100) fail('故障描述需为1至100字', 'INVALID_DESCRIPTION')
        const station = s.stores.find(st => String(st.code) === String(req.stationCode))
        if (mode === 'store') {
          if (!station || s.slot_station !== String(req.stationCode)) fail('先通过 options 核对门店及时段', 'STATION_UNAVAILABLE')
          if (!s.days.some(d => d.date === req.appointmentDate && d.slots.some(t => t.time === req.timeBucket && t.available))) fail('时段不在已查询的可预约列表中', 'SLOT_UNAVAILABLE')
        } else {
          // 上门的时段来源尚未实机验证，不能把到店时段套给上门。
          fail('上门时段接口尚未验证；请保留接口流程并完成适配，不自动点击网页下单', 'DOOR_SLOTS_UNVERIFIED')
        }
        const payload = {
          sn: s.sn, materialNo: s.device.material_no, bigClassId: s.service.big_class_id,
          bigClass: s.service.big_class, categoryType: s.service.category_type, mode,
          stationCode: station.code, lat: station.lat, lng: station.lng,
          appointmentDate: req.appointmentDate, timeBucket: req.timeBucket,
          desc: String(req.desc), name: String(req.name).trim(), phone: String(req.phone),
        }
        const review = { sn: s.sn, mode, station: { code: station.code, name: station.name, address: station.address, phone: station.phone }, appointmentDate: req.appointmentDate, timeBucket: req.timeBucket, desc: payload.desc, name: payload.name, phone_masked: payload.phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') }
        s.draft = { id: randomUUID(), payload, review, expires: now() + 10 * 60 * 1000 }
        return { draft_id: s.draft.id, review, next: '向用户复述本单（含保外备件价与工时限定），明确确认后用此 draft_id 调 submit --draft_id <id> --confirmed；10 分钟内有效' }
      }
      case 'submit': {
        requireDevice(s)
        if (s.attempted) fail('已经尝试提交，请核对我的预约，勿重试', 'SUBMISSION_ALREADY_ATTEMPTED')
        if (req.confirmed !== true) fail('需要用户确认已经展示的完整预约单', 'CONFIRMATION_REQUIRED')
        if (!s.draft || req.draft_id !== s.draft.id || now() >= s.draft.expires) fail('待确认单据已失效，请重新 prepare', 'DRAFT_EXPIRED')
        const draft = s.draft
        const current = await client.listAppointmentSlots(s.session, { stationCode: draft.payload.stationCode, categoryType: s.service.category_type })
        if (!current.some(d => d.date === draft.payload.appointmentDate && d.slots.some(t => t.time === draft.payload.timeBucket && t.available))) fail('时段已不可约，请重新查询并让用户选择', 'SLOT_UNAVAILABLE')
        const signature = await client.getSubmitSignature(s.session, { sn: s.sn, bigClassId: s.service.big_class_id })
        // 请求超时可能实际已下单，调用前置位并立刻落盘；后续不得自动重发。
        s.attempted = true
        s.draft = null
        await store.save(s)
        const result = await client.submitAppointment(s.session, { ...draft.payload, signature })
        // 上游原始 result 可能包含联系人资料，不向模型透传。
        const order = publicOrder(result.result)
        s.receipt = { submitted: true, submitted_at: result.submitted_at, review: draft.review, order }
        return {
          submitted: true, submitted_at: result.submitted_at, receipt_available: true, review: draft.review, order,
          next: Object.keys(order).length
            ? '告知用户已提交并给出工单号；然后 close'
            : '告知用户已提交但接口未返回工单号，请到「我的预约」核对，不要编造编号；然后 close',
        }
      }
      case 'close': {
        await browserApi.closeBrowser(s.browser)
        Object.assign(s, freshState())
        return { closed: true }
      }
      default: fail('未知 action；使用 --help 查看协议', 'INVALID_ACTION')
    }
  }

  async function handle(req) {
    if (!req || typeof req !== 'object' || Array.isArray(req)) fail('请求格式错误', 'INVALID_JSON')
    const s = (await store.load()) || freshState()
    try { return await dispatch(s, req) }
    finally { if (req.action === 'close') await store.clear(); else await store.save(s) }
  }
  return { handle }
}

function publicOrder(result) {
  if (typeof result === 'string' || typeof result === 'number') return { id: String(result) }
  const out = {}
  for (const key of ['so_no', 'order_id', 'orderId', 'order_no', 'orderNo', 'workOrderNo', 'work_order_no', 'id']) if (['string', 'number'].includes(typeof result?.[key])) out[key] = result[key]
  return out
}

/*
 * 错误文案表：message 说发生了什么，next 说 agent 下一步该做什么。
 * 文案全部由本仓库撰写，不透传上游响应、栈或输入——鉴权和联系方式不能进日志。
 * 表必须覆盖 scripts/ 下抛出的每一个 code（有测试守着），否则弱一点的 agent 会卡在一句"请按文档处理"上。
 */
const ERRORS = {
  // 运行环境 / 请求
  NODE_TOO_OLD: [`需要 Node ${NODE_MIN_MAJOR} 或更新`, '把 message 里的安装命令交给用户执行，装完重跑同一条命令；不要尝试其他 Node 参数'],
  SESSION_EXPIRED: ['预约会话已过期（30 分钟）', '在专用窗口重新 auth 一次'],
  INVALID_JSON: ['请求不是有效的 JSON', '检查 --b64 内容；一般情况下直接用 --key value 传参即可'],
  INVALID_REQUEST: ['请求格式或运行环境异常', '核对 action 与字段后重试一次'],
  INVALID_ACTION: ['未知 action', '查看 standalone-service.md 的动作速查表'],
  // 浏览器
  BROWSER_NOT_FOUND: ['未找到 Chrome/Edge', '让用户指定 browserPath 重试一次；仍失败转热线'],
  BROWSER_LAUNCH_FAILED: ['浏览器启动失败或被系统策略阻止', '如实报告被阻止，不绕过；转热线'],
  BROWSER_UNAVAILABLE: ['无法连接浏览器', '重新 login 一次；仍失败转热线'],
  BROWSER_REQUIRED: ['尚未打开登录浏览器', '先 login'],
  BROWSER_PROTOCOL: ['浏览器操作失败', '重新 login 后 auth'],
  BROWSER_TIMEOUT: ['浏览器操作超时', '重试 auth 一次'],
  BROWSER_CLOSED: ['专用浏览器已关闭（用户关掉了，或宿主在命令结束时回收了它）', `重新 login 一次让用户再登录；若刚 login 完就再次报此错，说明本环境无法在线预约，转热线 ${HOTLINE}`],
  INVALID_BROWSER_ENDPOINT: ['只接受宿主提供的本机浏览器会话', '改用不带 endpoint 的 login 启动专用浏览器'],
  MISSING_BROWSER_TARGET: ['宿主桥接缺少页面 targetId', '改用不带 endpoint 的 login'],
  INVALID_BROWSER_TARGET: ['宿主页面不是联想登录/预约页', '改用不带 endpoint 的 login'],
  // 登录 / 鉴权
  LOGIN_REQUIRED: ['登录未完成或已失效', '等用户在专用窗口登录完成后再 auth；不要求复制 cookie'],
  TOKEN_EXPIRED: ['鉴权 token 已过期', '重新 auth 一次；仍失败报告接口鉴权异常'],
  DEVICE_REQUIRED: ['尚未完成鉴权或设备未绑定', '先 auth；sn_bound=false 时让用户在预约页绑定设备'],
  NO_SERVICE: ['该设备当前没有可预约的维修服务', '告知用户并转热线'],
  // 查询
  INVALID_SN: ['主机编号缺失或形状不对（应为 6~12 位字母数字）', '用 --sn 传本次诊断采集的 device_serial；让用户核对机身底部标签'],
  SN_NOT_FOUND: ['联想未查到该主机编号', '让用户核对机身标签；非联想设备属正常，不重试'],
  NETWORK: ['联想接口网络请求失败', '若是 submit，先让用户到「我的预约」核对再决定；其他动作可重试一次'],
  UPSTREAM_HTTP: ['联想接口返回非 200', '告知联想官网接口暂时不可用，给页面链接让用户自查，不估数据'],
  UPSTREAM_SHAPE: ['联想接口返回结构已变化', '告知接口暂不可用，给页面链接，不估数据'],
  UPSTREAM_REJECTED: ['联想接口拒绝了请求', '报告失败阶段，不编造成功；必要时转热线'],
  CITY_REQUIRED: ['查门店需要城市名', '让用户提供城市和中心地址'],
  INVALID_LOCATION: ['经纬度无效', '不要把 WGS84 坐标当腾讯坐标；改用 stores --city <市> --address <地标>'],
  LOCATION_REQUIRED: ['需要位置信息', '让用户提供城市和中心地址或附近地标'],
  LOCATION_SELECTION_REQUIRED: ['地址候选已失效', '重新 stores --city <市> --address <地标>'],
  LOCATION_NETWORK: ['位置服务网络请求失败', '用响应里的 manual_map_url 兜底，或让用户提供城市和地址'],
  LOCATION_UPSTREAM: ['地址搜索接口异常', '让用户补充位置，或用官网地图链接兜底'],
  // 预约
  STATION_UNAVAILABLE: ['门店不在当前列表中', '重新 stores/options 后让用户改选'],
  SLOT_UNAVAILABLE: ['时段不可约', '重新 options 并让用户重选时段'],
  INVALID_MODE: ['服务方式只能是 store 或 door', '按 service.is_store/is_door 传 mode'],
  MODE_UNAVAILABLE: ['该设备不支持所选服务方式', '按 service.is_store/is_door 改用可用方式'],
  SERVICE_SUBTYPE_REQUIRED: ['此维修类别需要子类', '告知用户当前入口不支持，转热线'],
  DOOR_SLOTS_UNVERIFIED: ['上门时段接口尚未验证，未提交', '改约到店，或转热线'],
  MISSING_CONTACT: ['缺少联系人或 11 位手机号', '向用户收集姓名和手机号后重新 prepare'],
  INVALID_DESCRIPTION: ['故障描述需为 1 至 100 字', '压缩 desc 后重新 prepare'],
  MISSING_TIME: ['缺少预约时间', '传 appointmentDate + timeBucket'],
  MISSING_STATION: ['到店预约必须选门店', '先 options 核验门店'],
  MISSING_ADDRESS: ['上门预约必须填详细地址', '改约到店，或转热线'],
  CONFIRMATION_REQUIRED: ['未取得用户对完整单据的确认', '把 prepare 返回的 review 复述给用户，确认后 submit --draft_id <id> --confirmed'],
  DRAFT_EXPIRED: ['待确认单据已失效（10 分钟）', '重新 prepare 并确认'],
  SUBMISSION_ALREADY_ATTEMPTED: ['已尝试提交过', '让用户到「我的预约」核对，禁止重复提交'],
  ALREADY_BOOKED: ['该设备已有预约单', '让用户到「我的预约」查看，不重复提交'],
}

export const KNOWN_ERROR_CODES = Object.keys(ERRORS)

export function safeMessage(code) {
  return ERRORS[code]?.[0] || `操作未完成（${code}），请按独立服务参考文档处理`
}

export function nextHint(code) {
  return ERRORS[code]?.[1] || '核对 standalone-service.md 的排错表；无法恢复时如实报告并转热线'
}

/** 统一的错误响应：不含栈、输入或上游文本。NODE_TOO_OLD 例外——它的 message 就是安装命令，必须原样给出。 */
export function describeError(error, action) {
  const code = error?.code || 'INVALID_REQUEST'
  const known = error instanceof ToolkitError
  return {
    ok: false,
    ...(action ? { action } : {}),
    ...(error?.stage ? { stage: error.stage } : {}),
    code,
    message: known && code === 'NODE_TOO_OLD' ? error.message : safeMessage(known ? code : 'INVALID_REQUEST'),
    next: nextHint(known ? code : 'INVALID_REQUEST'),
  }
}

// ---------------------------------------------------------------------------
// 命令行入口：node service.mjs <action> [--key value ...] [--ascii] [--b64 <base64 json>]
// ---------------------------------------------------------------------------

const NUMERIC_KEYS = new Set(['lat', 'lng', 'limit', 'locationLimit'])
const stripBom = text => (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)

function coerce(key, value) {
  if (value === true) return true
  if (value === 'true') return true
  if (value === 'false') return false
  if (NUMERIC_KEYS.has(key) && value !== '' && Number.isFinite(Number(value))) return Number(value)
  return value
}

function decodeB64(text) {
  if (!text) fail('--b64 需要 base64 编码的 UTF-8 JSON', 'INVALID_JSON')
  let parsed
  try { parsed = JSON.parse(stripBom(Buffer.from(text, 'base64').toString('utf8').trim())) }
  catch { fail('请求不是有效的 JSON', 'INVALID_JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('请求不是 JSON 对象', 'INVALID_JSON')
  return parsed
}

/** 位置参数是 action，--key value 是字段；--flag 不带值等于 true；--b64 可整体合并一个 JSON 对象。 */
export function parseCli(argv) {
  const req = {}
  const flags = { ascii: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--ascii') { flags.ascii = true; continue }
    if (arg === '--b64') { Object.assign(req, decodeB64(argv[++i])); continue }
    if (arg.startsWith('--b64=')) { Object.assign(req, decodeB64(arg.slice(6))); continue }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2)
      let value
      if (eq > 0) value = arg.slice(eq + 1)
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i]
      else value = true
      if (!key) fail('参数名不能为空', 'INVALID_REQUEST')
      req[key] = coerce(key, value)
      continue
    }
    if (req.action === undefined) { req.action = arg; continue }
    fail(`多余的参数「${arg}」`, 'INVALID_REQUEST')
  }
  return { req, flags }
}

/** --ascii：把非 ASCII 转成 \uXXXX，宿主控制台不是 UTF-8 时仍能原样读到中文。 */
export function emit(value, { ascii = false } = {}) {
  const text = JSON.stringify(value)
  console.log(ascii ? text.replace(/[^ -~]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) : text)
}

export const USAGE = [
  `用法：node service.mjs <action> [--key value ...] [--ascii]     （需要 Node ${NODE_MIN_MAJOR}+）`,
  '',
  '  动作：' + ACTIONS.join(' / '),
  '  例：node service.mjs quote --sn PF4ABCDE',
  '      node service.mjs stores --city 北京市 --address 中关村',
  '      node service.mjs login --stationCode S123',
  '      node service.mjs auth',
  '      node service.mjs prepare --stationCode S123 --appointmentDate 2026-09-16 --timeBucket 10:00-11:00 --name 张三 --phone 13800000000 --desc "电池健康度72%,要求更换原厂电池"',
  '      node service.mjs submit --draft_id <id> --confirmed',
  '      node service.mjs close',
  '',
  '  --ascii            输出把非 ASCII 转成 \\uXXXX，控制台显示乱码时加上',
  '  --b64 <base64>     用 base64 编码的 JSON 对象整体传参（引号难处理时用）',
  '  --stdio            每行一个 JSON 请求的长驻模式，stdin 关闭即结束',
  '',
  `  状态跨调用保存在 ${DEFAULT_STATE_PATH}，close 后删除。详见 references/standalone-service.md`,
].join('\n')

export async function runCli(argv, { store } = {}) {
  const { req, flags } = parseCli(argv)
  try {
    if (!req.action) { console.log(USAGE); process.exitCode = 2; return }
    const statePath = process.env.LENOVO_BATTERY_SERVICE_STATE || DEFAULT_STATE_PATH
    const service = createService({ store: store || fileStore(statePath, { onStale: state => closeBrowser(state.browser) }) })
    const data = await service.handle(req)
    emit({ ok: true, action: req.action, data }, flags)
  } catch (error) {
    emit(describeError(error, req.action), flags)
    process.exitCode = 1
  }
}

export async function runStdio() {
  const runtime = createService({ store: memoryStore() })
  const lines = createInterface({ input: process.stdin, terminal: false })
  console.log(JSON.stringify({ ready: true, protocol: 'jsonl', actions: ACTIONS }))
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let req
      try {
        req = JSON.parse(stripBom(line))
      } catch {
        console.log(JSON.stringify({ ok: false, code: 'INVALID_JSON', message: '请求不是有效的单行 JSON' }))
        continue
      }
      try {
        const data = await runtime.handle(req)
        console.log(JSON.stringify({ ok: true, action: req.action, data }))
      } catch (error) {
        console.log(JSON.stringify(describeError(error, req?.action)))
      }
      if (req?.action === 'close') break
    }
  } finally { await runtime.handle({ action: 'close' }).catch(() => {}); lines.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) console.log(USAGE)
  else {
    let proceed = true
    try { proceed = ensureNode(fileURLToPath(import.meta.url), argv) }
    catch (error) { emit(describeError(error), { ascii: argv.includes('--ascii') }); process.exitCode = 1; proceed = false }
    if (proceed) {
      if (argv.includes('--stdio')) await runStdio()
      else {
        try { await runCli(argv) }
        catch (error) { emit(describeError(error), { ascii: argv.includes('--ascii') }); process.exitCode = 1 }
      }
    }
  }
}
