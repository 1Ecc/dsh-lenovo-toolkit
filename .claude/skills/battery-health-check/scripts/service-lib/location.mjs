import { ToolkitError } from './errors.mjs'

const TENCENT_SUGGEST_URL = 'https://apis.map.qq.com/ws/place/v1/suggestion'
const TENCENT_IP_URL = 'https://apis.map.qq.com/ws/location/v1/ip'
const LENOVO_STORES_URL = 'https://newsupport.lenovo.com.cn/serverNet.html'
const FETCH_TIMEOUT_MS = 10_000

// 这是联想官方网点页 js/tmap.js 公开给浏览器的地图 key，不是用户凭据。
// 独立 Skill 复用同一地址选择能力，避免为了查门店提前启动登录浏览器。
const LENOVO_TENCENT_MAP_KEY = 'GI5BZ-WBYKW-QO3RF-Y4MF3-3FD27-PFBJV'

function boundedLimit(value) {
  const n = Number(value)
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), 10) : 5
}

async function getTencentJson(url, fetchImpl, what) {
  let response
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json', referer: LENOVO_STORES_URL },
    })
  } catch (error) {
    throw new ToolkitError(`${what}失败：${error?.cause?.message || error.message}`, 'LOCATION_NETWORK')
  }
  if (!response.ok) throw new ToolkitError(`${what}返回 HTTP ${response.status}`, 'LOCATION_UPSTREAM')

  let body
  try {
    body = await response.json()
  } catch {
    throw new ToolkitError(`${what}返回的不是 JSON`, 'LOCATION_UPSTREAM')
  }
  if (Number(body?.status) !== 0) {
    throw new ToolkitError(`${what}返回 ${body?.status ?? '未知状态'}：${body?.message || ''}`, 'LOCATION_UPSTREAM')
  }
  return body
}

export async function locateCurrent({ fetch: fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(TENCENT_IP_URL)
  url.search = new URLSearchParams({ key: LENOVO_TENCENT_MAP_KEY, output: 'json' }).toString()
  const body = await getTencentJson(url, fetchImpl, '自动定位')
  const result = body?.result
  const lat = Number(result?.location?.lat)
  const lng = Number(result?.location?.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !result?.ad_info?.city) {
    throw new ToolkitError('自动定位没有返回有效城市和坐标', 'LOCATION_UPSTREAM')
  }
  return {
    title: [result.ad_info.city, result.ad_info.district].filter(Boolean).join(''),
    address: null,
    province: result.ad_info.province || null,
    city: result.ad_info.city,
    district: result.ad_info.district || null,
    lat,
    lng,
    source: 'ip',
    precise: false,
    provider: '腾讯位置服务（联想官方网点页同源）',
  }
}

export async function searchLocations(
  { query, region, limit = 5 } = {},
  { fetch: fetchImpl = globalThis.fetch } = {},
) {
  const keyword = String(query ?? '').trim()
  const city = String(region ?? '').trim() || '全国'
  if (!keyword) throw new ToolkitError('需要地址、地标或区县名称', 'LOCATION_REQUIRED')

  const url = new URL(TENCENT_SUGGEST_URL)
  url.search = new URLSearchParams({
    key: LENOVO_TENCENT_MAP_KEY,
    keyword,
    region: city,
    page_size: String(boundedLimit(limit)),
    output: 'json',
  }).toString()

  const body = await getTencentJson(url, fetchImpl, '地址搜索')

  return (Array.isArray(body.data) ? body.data : [])
    .filter((item) => Number.isFinite(Number(item?.location?.lat)) && Number.isFinite(Number(item?.location?.lng)))
    .slice(0, boundedLimit(limit))
    .map((item, index) => ({
      id: String(item.id || `candidate-${index + 1}`),
      title: item.title || null,
      address: item.address || null,
      province: item.province || null,
      city: item.city || city,
      district: item.district || null,
      lat: Number(item.location.lat),
      lng: Number(item.location.lng),
      category: item.category || null,
      provider: '腾讯位置服务（联想官方网点页同源）',
    }))
}
