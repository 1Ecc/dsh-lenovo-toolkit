import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolkitError } from './errors.mjs'
import { NODE_MIN_MAJOR } from './runtime.mjs'

export const LOGIN_URL = 'https://reg.lenovo.com.cn/user_auth/toc/#/login?ticket=fb35b465-917a-42a6-b24a-32e6bd07f0a2&ru=https%3A%2F%2Fnewsupport.lenovo.com.cn%2F'
export const ORDER_URL = 'https://serviceorder.lenovo.com.cn/h5/#/serviceOrderPC/selectService'
export const STORES_URL = 'https://newsupport.lenovo.com.cn/serverNet.html'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/*
 * 浏览器句柄是一个可序列化的描述 { endpoint, targetId, pid, profile, owned }，
 * 存在状态文件里；每个动作都重新连一次 CDP、做完就断开。这样拉起浏览器的进程可以直接退出，
 * 后面的 auth / close 在新进程里照样能接上同一个浏览器窗口。
 */

export function assertBrowserBridge() {
  if (typeof WebSocket !== 'undefined') return
  throw new ToolkitError(`当前 Node ${process.version} 没有全局 WebSocket，需要 Node ${NODE_MIN_MAJOR}+`, 'NODE_TOO_OLD')
}

export async function connectCdp(endpoint) {
  assertBrowserBridge()
  const url = new URL(endpoint)
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new ToolkitError('只连接宿主明确提供的本机浏览器会话', 'INVALID_BROWSER_ENDPOINT')
  }
  const ws = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new ToolkitError('浏览器连接超时', 'BROWSER_UNAVAILABLE')) }, 10000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new ToolkitError('无法连接浏览器', 'BROWSER_UNAVAILABLE')) }, { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    let data
    try { data = JSON.parse(event.data) } catch { return }
    const entry = pending.get(data.id)
    if (!entry) return
    clearTimeout(entry.timer); pending.delete(data.id)
    // CDP 的错误文本可能带页面内容，不能原样回传到会话日志。
    data.error ? entry.reject(new ToolkitError('浏览器操作失败', 'BROWSER_PROTOCOL')) : entry.resolve(data.result)
  })
  ws.addEventListener('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer); entry.reject(new ToolkitError('浏览器已断开', 'BROWSER_CLOSED'))
    }
    pending.clear()
  })
  return {
    call(method, params = {}, sessionId) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new ToolkitError('浏览器操作超时', 'BROWSER_TIMEOUT')) }, 15000)
        pending.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
    close() { ws.close() },
  }
}

const browserCandidates = explicit => explicit ? [explicit] : process.platform === 'win32' ? [
  join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']

/** 只探测路径，不启动；找不到返回 null。 */
export async function probeBrowser(explicit) {
  for (const candidate of browserCandidates(explicit)) { try { await access(candidate); return candidate } catch {} }
  return null
}

async function findBrowser(explicit) {
  const found = await probeBrowser(explicit)
  if (found) return found
  throw new ToolkitError('未找到 Chrome/Edge，请用 browserPath 指定已安装浏览器', 'BROWSER_NOT_FOUND')
}

async function getLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise(resolve => server.close(resolve))
  if (!address || typeof address === 'string' || !address.port) throw new ToolkitError('未取得浏览器调试端口', 'BROWSER_LAUNCH_FAILED')
  return address.port
}

const pidAlive = pid => { try { return Boolean(pid) && process.kill(pid, 0) } catch (error) { return error.code === 'EPERM' } }

/*
 * 浏览器必须在两次工具调用之间一直开着等用户登录，所以不能是本进程的子进程：
 * 有的宿主在命令结束时把整棵进程树杀掉（Chrome 一闪就没），还会因为子进程继承了输出管道句柄而
 * 报"管道未关闭"。Windows 上用 WMI 的 Win32_Process.Create 创建进程——父进程是系统的 WMI 服务，
 * 既不在宿主的进程树里也不继承任何句柄，而且落在当前交互会话里（窗口可见）。WMI 不可用时退回
 * detached spawn（能活过工具调用的宿主里够用）。macOS/Linux 的 detached 会 setsid，同样脱离进程组。
 */
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const psQuote = text => `'${String(text).replace(/'/g, "''")}'`
const winQuote = arg => `"${String(arg).replace(/(\\*)"/g, '$1$1\\"')}"`

function launchViaWmi(executable, args) {
  const commandLine = [executable, ...args].map(winQuote).join(' ')
  const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)} }; if ($r.ReturnValue -ne 0) { exit 1 }; Write-Output $r.ProcessId`
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] })
  const pid = Number(String(result.stdout || '').trim())
  return result.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : null
}

/** 返回 { pid, launched_via }；进程不是本进程的子进程（或至少已 detach）。 */
function launchDetached(executable, args) {
  if (process.platform === 'win32') {
    const pid = launchViaWmi(executable, args)
    if (pid) return { pid, launched_via: 'wmi' }
  }
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true, detached: true })
  child.on('error', () => {})
  child.unref()
  return { pid: child.pid, launched_via: 'spawn' }
}

/** 拉起专用浏览器并打开登录页；返回可序列化句柄，本进程随后可以直接退出。 */
export async function launchBrowser({ browserPath, headless = false, url = LOGIN_URL } = {}) {
  assertBrowserBridge()
  const executable = await findBrowser(browserPath)
  const profile = await mkdtemp(join(tmpdir(), 'lenovo-skill-browser-'))
  const port = await getLoopbackPort()
  // “非零端口 + 普通独立 profile”这组配置已通过联想拼图、登录及鉴权实测，两项尚未拆开做归因验证。
  const { pid, launched_via } = launchDetached(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', ...(headless ? ['--headless=new'] : []), 'about:blank'])
  const kill = () => { try { process.kill(pid) } catch {} }
  let cdp
  try {
    let endpoint
    for (let i = 0; i < 100; i++) {
      if (!pid || (i > 5 && !pidAlive(pid))) throw new ToolkitError('浏览器启动失败或被系统阻止', 'BROWSER_LAUNCH_FAILED')
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        const version = await response.json()
        if (version.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/devtools/browser/`)) {
          endpoint = version.webSocketDebuggerUrl
          break
        }
      } catch {}
      try {
        const [reportedPort, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
        if (/^\d+$/.test(reportedPort) && path?.startsWith('/devtools/browser/')) { endpoint = `ws://127.0.0.1:${reportedPort}${path}`; break }
      } catch {}
      await delay(100)
    }
    if (!endpoint) throw new ToolkitError('未取得浏览器连接地址', 'BROWSER_LAUNCH_FAILED')
    cdp = await connectCdp(endpoint)
    const { targetId } = await cdp.call('Target.createTarget', { url, newWindow: true })
    cdp.close()
    return { endpoint, targetId, pid, profile, owned: true, launched_via }
  } catch (error) {
    cdp?.close(); kill()
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    throw error
  }
}

/** 浏览器是否还活着：自己拉起的看 pid；宿主的看能否连上。不抛错。 */
export async function browserAlive(browser) {
  if (!browser) return false
  if (browser.owned) return pidAlive(browser.pid)
  try { (await connectCdp(browser.endpoint)).close(); return true } catch { return false }
}

/** 宿主已有的浏览器：只核对目标页面是联想站点，不拉起、不关闭。 */
export async function attachBrowser({ endpoint, targetId }) {
  if (!targetId) throw new ToolkitError('宿主需要提供本次联想登录页的 targetId', 'MISSING_BROWSER_TARGET')
  const cdp = await connectCdp(endpoint)
  try {
    const { targetInfo } = await cdp.call('Target.getTargetInfo', { targetId })
    const url = new URL(targetInfo.url)
    if (url.protocol !== 'https:' || !['reg.lenovo.com.cn', 'serviceorder.lenovo.com.cn', 'newsupport.lenovo.com.cn'].includes(url.hostname)) throw new ToolkitError('目标不是联想登录/预约页面', 'INVALID_BROWSER_TARGET')
    return { endpoint, targetId, pid: null, profile: null, owned: false }
  } finally { cdp.close() }
}

/** 连上句柄里的浏览器做一件事再断开；连不上就是浏览器已经没了。 */
async function withPage(browser, fn, connect = connectCdp) {
  let cdp
  try { cdp = await connect(browser.endpoint) }
  catch (error) {
    if (error.code === 'BROWSER_UNAVAILABLE') throw new ToolkitError('专用浏览器已关闭', 'BROWSER_CLOSED')
    throw error
  }
  try {
    let attached
    try { attached = await cdp.call('Target.attachToTarget', { targetId: browser.targetId, flatten: true }) }
    catch { throw new ToolkitError('登录页面已被关闭', 'BROWSER_CLOSED') }
    try { return await fn(cdp, attached.sessionId) }
    finally { await cdp.call('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => {}) }
  } finally { cdp.close() }
}

export async function readPassport(browser, { connect = connectCdp } = {}) {
  return withPage(browser, async (cdp, sessionId) => {
    // 仅取预约站可用的指定 cookie，兼容 HttpOnly；不读取浏览器数据库。
    const { cookies } = await cdp.call('Network.getCookies', { urls: [ORDER_URL] }, sessionId)
    return cookies.find(c => c.name === 'cerpreg-passport')?.value || null
  }, connect)
}

export async function openPage(browser, url) {
  await withPage(browser, (cdp, sessionId) => cdp.call('Page.navigate', { url }, sessionId))
}

/** 关闭专用浏览器并清理临时 profile；宿主的浏览器只断开不关。任何一步失败都不抛。 */
export async function closeBrowser(browser) {
  if (!browser) return
  if (!browser.owned) return
  try {
    const cdp = await connectCdp(browser.endpoint)
    try { await cdp.call('Browser.close') } catch {}
    cdp.close()
  } catch {}
  for (let i = 0; i < 30 && pidAlive(browser.pid); i++) await delay(100)
  if (pidAlive(browser.pid)) { try { process.kill(browser.pid) } catch {} }
  if (browser.profile) await rm(browser.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
}
