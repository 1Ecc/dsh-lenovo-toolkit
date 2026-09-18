#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createService, safeMessage } from './service.mjs'
import { ToolkitError } from './service-lib/errors.mjs'

const ROOT = join(tmpdir(), 'lenovo-battery-service')
const HOST = '127.0.0.1'
const MAX_LINE = 64 * 1024
const IDLE_MS = 35 * 60 * 1000
const scriptPath = fileURLToPath(import.meta.url)

const sessionFile = id => join(ROOT, `${id}.json`)
const publicError = (error, action) => {
  const code = error?.code || 'INVALID_REQUEST'
  return {
    ok: false,
    ...(action ? { action } : {}),
    ...(error?.stage ? { stage: error.stage } : {}),
    code,
    message: error instanceof ToolkitError ? safeMessage(code) : '请求格式或运行环境异常',
  }
}

async function readSession(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) throw new ToolkitError('会话编号无效，请重新启动服务会话', 'SESSION_NOT_FOUND')
  try {
    const value = JSON.parse(await readFile(sessionFile(id), 'utf8'))
    if (value.id !== id || !value.port || !value.token) throw new Error('invalid session')
    return value
  } catch {
    throw new ToolkitError('服务会话不存在或已结束，请重新启动', 'SESSION_NOT_FOUND')
  }
}

async function send(port, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: HOST, port })
    let text = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new ToolkitError('服务会话连接超时，请检查会话状态', 'SESSION_UNAVAILABLE'))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.end(`${JSON.stringify(payload)}\n`))
    socket.on('data', chunk => {
      text += chunk
      if (text.length > MAX_LINE) socket.destroy(new Error('response too large'))
    })
    socket.on('error', error => {
      clearTimeout(timer)
      reject(error instanceof ToolkitError ? error : new ToolkitError('服务会话不可用，请重新启动', 'SESSION_UNAVAILABLE'))
    })
    socket.on('end', () => {
      clearTimeout(timer)
      try { resolve(JSON.parse(text.trim())) }
      catch { reject(new ToolkitError('服务会话返回异常，请重新启动', 'SESSION_UNAVAILABLE')) }
    })
  })
}

async function cleanupStaleSessions() {
  for (const name of await readdir(ROOT).catch(() => [])) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue
    const path = join(ROOT, name)
    try {
      const metadata = JSON.parse(await readFile(path, 'utf8'))
      const response = await send(metadata.port, { token: metadata.token, request: { action: 'status' } }, 500)
      if (response.ok) continue
    } catch {}
    await rm(path, { force: true }).catch(() => {})
  }
}

async function start() {
  await mkdir(ROOT, { recursive: true })
  await cleanupStaleSessions()
  const id = randomUUID()
  const token = randomUUID()
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, HOST, resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise(resolve => probe.close(resolve))
  if (!port) throw new ToolkitError('无法分配本机服务端口', 'SESSION_UNAVAILABLE')
  const child = spawn(process.execPath, [scriptPath, 'host', id, String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, LENOVO_SERVICE_SESSION_TOKEN: token },
  })
  child.unref()
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    try {
      const response = await send(port, { token, request: { action: 'status' } })
      if (response.ok) {
        console.log(JSON.stringify({ ok: true, action: 'start', data: { session_id: id, pid: child.pid, expires_after_idle_minutes: 35 } }))
        return
      }
    } catch {}
  }
  await rm(sessionFile(id), { force: true })
  child.kill()
  throw new ToolkitError('服务会话启动失败', 'SESSION_UNAVAILABLE')
}

async function call(id) {
  const metadata = await readSession(id)
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > MAX_LINE) throw new ToolkitError('请求过大', 'INVALID_JSON')
  }
  let request
  try { request = JSON.parse(input.trim().replace(/^\uFEFF/, '')) }
  catch { throw new ToolkitError('请求不是有效的 JSON', 'INVALID_JSON') }
  const response = await send(metadata.port, { token: metadata.token, request })
  console.log(JSON.stringify(response))
}

async function host(id, portValue) {
  const token = process.env.LENOVO_SERVICE_SESSION_TOKEN
  const port = Number(portValue)
  if (!/^[0-9a-f-]{36}$/i.test(id || '') || !token || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ToolkitError('服务会话启动参数无效', 'SESSION_FORBIDDEN')
  }
  const metadata = { id, port, token, created_at: new Date().toISOString() }
  await writeFile(sessionFile(id), JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600 })
  await chmod(sessionFile(id), 0o600).catch(() => {})
  const runtime = createService()
  let idleTimer
  let closing = false
  let requests = Promise.resolve()
  const finish = async server => {
    if (closing) return
    closing = true
    clearTimeout(idleTimer)
    await runtime.handle({ action: 'close' }).catch(() => {})
    await rm(sessionFile(id), { force: true }).catch(() => {})
    server.close(() => process.exit(0))
  }
  // 客户端写完单个请求后会关闭写入端；保留返回方向直到服务端写完一个响应。
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.setEncoding('utf8')
    let input = ''
    socket.on('data', chunk => {
      input += chunk
      if (input.length > MAX_LINE) socket.destroy()
    })
    socket.on('end', () => {
      requests = requests.then(async () => {
        let envelope, response
        try {
          envelope = JSON.parse(input.trim().replace(/^\uFEFF/, ''))
          if (envelope.token !== metadata.token) throw new ToolkitError('服务会话鉴权失败', 'SESSION_FORBIDDEN')
          if (!envelope.request || typeof envelope.request !== 'object' || Array.isArray(envelope.request)) throw new ToolkitError('请求格式错误', 'INVALID_JSON')
          const data = await runtime.handle(envelope.request)
          response = { ok: true, action: envelope.request.action, data }
        } catch (error) {
          response = publicError(error, envelope?.request?.action)
        }
        socket.end(`${JSON.stringify(response)}\n`)
        clearTimeout(idleTimer)
        if (envelope?.request?.action === 'close') await finish(server)
        else idleTimer = setTimeout(() => finish(server), IDLE_MS)
      }).catch(() => socket.end(`${JSON.stringify({ ok: false, code: 'INVALID_REQUEST', message: '请求格式或运行环境异常' })}\n`))
    })
  })
  server.on('error', async () => {
    await rm(sessionFile(id), { force: true }).catch(() => {})
    process.exit(1)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(metadata.port, HOST, resolve)
  })
  idleTimer = setTimeout(() => finish(server), IDLE_MS)
}

async function main() {
  const [command, id, port] = process.argv.slice(2)
  if (command === 'start') return start()
  if (command === 'call') return call(id)
  if (command === 'host') return host(id, port)
  console.log('用法：node service-session.mjs start；将单个 JSON 请求写入 stdin 后运行 node service-session.mjs call <session_id>')
}

try { await main() }
catch (error) {
  console.log(JSON.stringify(publicError(error)))
  process.exitCode = 1
}
