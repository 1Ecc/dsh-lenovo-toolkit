/**
 * 服务链路的状态存储。
 *
 * 每次工具调用都是一个新进程，而 stores → login → auth → prepare → submit 要跨 4–5 个用户回合
 * 保持登录 token、已选门店和待确认单据。以前用一个后台守护进程持有这些，但"进程能不能活过
 * 一次工具调用"由宿主决定，有的宿主在命令结束时直接回收整棵进程树——守护进程必死。
 * 文件不受宿主管，所以状态落文件，每个动作：读 → 做 → 写 → 退出。
 *
 * 文件里有登录 token 和待确认单据里的手机号，因此：只放在用户目录、0600、35 分钟不动即作废、
 * close 或提交完成后删除；内容不回显到模型输出。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const STATE_VERSION = 1
export const STATE_IDLE_MS = 35 * 60 * 1000
export const DEFAULT_STATE_PATH = join(homedir(), '.battery-health-check', 'service-state.json')

export const freshState = () => ({
  version: STATE_VERSION, updated_at: null,
  sn: null, location: null, places: [], nearby_stores: [], preferred_store: null,
  browser: null, session: null, device: null, service: null,
  stores: [], days: [], slot_station: null,
  draft: null, attempted: false, receipt: null,
})

/** 内存存储：--stdio 模式和单测用，生命周期就是进程本身。 */
export function memoryStore() {
  let state = null
  return {
    async load() { return state },
    async save(next) { state = next },
    async clear() { state = null },
  }
}

/** 文件存储：跨进程保持状态。过期文件视为不存在，并把里面的浏览器句柄交给调用方收尾。 */
export function fileStore(path = DEFAULT_STATE_PATH, { now = Date.now, onStale } = {}) {
  return {
    path,
    async load() {
      let state
      try { state = JSON.parse(await readFile(path, 'utf8')) } catch { return null }
      if (state?.version !== STATE_VERSION) { await rm(path, { force: true }).catch(() => {}); return null }
      const updated = Date.parse(state.updated_at || '') || 0
      if (now() - updated > STATE_IDLE_MS) {
        await rm(path, { force: true }).catch(() => {})
        if (onStale) await onStale(state).catch(() => {})
        return null
      }
      return state
    },
    async save(state) {
      state.updated_at = new Date(now()).toISOString()
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
      await rename(temp, path)
    },
    async clear() { await rm(path, { force: true }).catch(() => {}) },
  }
}
