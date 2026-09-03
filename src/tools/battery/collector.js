/**
 * 电池检测的纯逻辑层 —— 不依赖 Cordis，也不依赖任何 peer 依赖。
 *
 * 这样拆是为了可测：DSH 的 @deepseek-ai/dsh-tools 是 peer 依赖，开发机上不一定装得到，
 * 如果把它 import 到同一个文件里，整个模块就没法在本地跑测试了。
 * register.js 负责对接 Cordis，这里只负责"把脚本跑起来并把结果解析成对象"。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { ToolkitError } from '../../shared/errors.js'
import { readSkillDoc, skillScript } from '../../shared/paths.js'

const execFileAsync = promisify(execFile)

/** 本工具对应的 skill 名，也是 .dsh/skills/ 下的目录名 */
export const SKILL = 'battery-health-check'

const COLLECT_TIMEOUT_MS = 120_000
const RENDER_TIMEOUT_MS = 60_000

/** 采集脚本的退出码约定，和 collect_macos.sh / collect_windows.ps1 保持一致 */
const EXIT_NO_BATTERY = 2
const EXIT_WRONG_PLATFORM = 3

/** 当前平台，unsupported 表示 Linux 等暂未覆盖的系统 */
export function detectPlatform() {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'unsupported'
}

/** 生成一个带时间戳的默认输出目录，放在系统临时目录下，避免污染用户工程 */
export function defaultOutDir() {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  return join(tmpdir(), `battery-health-${ts}`)
}

/**
 * 解析采集脚本产出的 metrics.env。
 *
 * 用 KEY=VALUE 而不是 JSON，是因为采集脚本必须零依赖——bash 里生成/解析 JSON 太痛苦。
 * 值里可能含 `=`（比如路径），所以只在第一个 `=` 处切分。
 */
export function parseMetrics(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i <= 0) continue
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
  }
  return out
}

/** 把字符串字段转成数字；空值和非数字都返回 null，不要返回 NaN 污染下游 */
export function num(v) {
  if (v === undefined || v === null) return null
  const s = String(v).replace('%', '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * 跑采集脚本，返回 { platform, metrics, outDir, stdout }。
 *
 * macOS 走 bash，Windows 走 powershell。两边脚本的 stdout 格式一致，
 * 所以上层不需要关心平台差异。
 */
export async function collect({ outDir } = {}) {
  const platform = detectPlatform()
  if (platform === 'unsupported') {
    throw new ToolkitError(
      `暂不支持当前平台 ${process.platform}，目前覆盖 macOS 与 Windows`,
      'UNSUPPORTED_PLATFORM',
    )
  }

  const dir = outDir ? resolve(outDir) : defaultOutDir()
  const script = skillScript(
    SKILL,
    platform === 'macos' ? 'collect_macos.sh' : 'collect_windows.ps1',
  )

  const [cmd, args] =
    platform === 'macos'
      ? ['bash', [script, '--outdir', dir]]
      : ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutDir', dir]]

  let stdout
  try {
    ;({ stdout } = await execFileAsync(cmd, args, {
      timeout: COLLECT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }))
  } catch (err) {
    // 退出码是脚本主动约定的语义，要翻译成人能看懂的话，而不是把 shell 报错原样抛出去
    if (err.code === EXIT_NO_BATTERY) {
      throw new ToolkitError('未检测到电池。台式机、电池已拆除，或系统未暴露电池信息', 'NO_BATTERY')
    }
    if (err.code === EXIT_WRONG_PLATFORM) {
      throw new ToolkitError('采集脚本与当前系统不匹配', 'UNSUPPORTED_PLATFORM')
    }
    if (err.killed) {
      throw new ToolkitError('采集超时，脚本可能被系统权限弹窗阻塞', 'TIMEOUT')
    }
    throw new ToolkitError(`采集失败：${err.stderr || err.message}`, 'COLLECT_FAILED')
  }

  // 优先读落盘的 metrics.env。脚本同时打到 stdout，但若外部工具往 stdout 掺了东西，
  // 文件是更可靠的那一份。
  const metricsPath = join(dir, 'metrics.env')
  const raw = existsSync(metricsPath) ? readFileSync(metricsPath, 'utf8') : stdout
  return { platform, outDir: dir, metricsPath, metrics: parseMetrics(raw), stdout }
}

/**
 * 渲染容量衰减趋势 SVG。
 *
 * 依赖 python3（只用标准库）。找不到解释器时抛出可识别的错误码，
 * 让上层能给出"跳过趋势图、其余照常输出"的降级提示，而不是让整次检测失败。
 */
export async function renderTrend({ metricsPath, outPath, historyPath } = {}) {
  if (!metricsPath || !existsSync(metricsPath)) {
    throw new ToolkitError(`找不到 metrics 文件：${metricsPath}`, 'METRICS_MISSING')
  }
  const script = skillScript(SKILL, 'render_trend.py')
  const out = outPath ? resolve(outPath) : join(dirname(metricsPath), 'battery-trend.svg')
  const args = [script, '--metrics', metricsPath, '--out', out]
  if (historyPath) args.push('--history', historyPath)

  // Windows 的“应用执行别名”可能让 python3 看似存在、执行却立即失败；先用 --version
  // 验证解释器真的可用，避免把“没装 Python”误报成趋势图脚本执行失败。
  const interpreters =
    process.platform === 'win32'
      ? [
          ['py', ['-3']],
          ['python', []],
          ['python3', []],
        ]
      : [
          ['python3', []],
          ['python', []],
        ]

  for (const [py, prefix] of interpreters) {
    try {
      await execFileAsync(py, [...prefix, '--version'], { timeout: 10_000 })
    } catch {
      continue
    }

    try {
      await execFileAsync(py, [...prefix, ...args], { timeout: RENDER_TIMEOUT_MS })
      return { path: out }
    } catch (err) {
      throw new ToolkitError(`趋势图渲染失败：${err.stderr || err.message}`, 'RENDER_FAILED')
    }
  }
  throw new ToolkitError(
    '当前进程无法调用 Python 3。趋势图需要 Python 3（仅用标准库），其余检测结果不受影响',
    'PYTHON_MISSING',
  )
}

/** 读取判读规则文档，让模型在没装 skill 的情况下也能拿到分级标准 */
export function readRules(which = 'interpretation') {
  const files = {
    interpretation: 'references/interpretation.md',
    offers: 'references/lenovo-offers.md',
    platform: 'references/platform-notes.md',
  }
  const rel = files[which]
  if (!rel) {
    throw new ToolkitError(
      `未知的规则文档 ${which}，可选：${Object.keys(files).join(' / ')}`,
      'UNKNOWN_RULES',
    )
  }
  return readSkillDoc(SKILL, rel)
}

/**
 * 把 metrics 压成一段人类可读的概览。
 *
 * 只做客观陈述，不下健康度结论——分级判断依赖 interpretation.md 里的规则，
 * 那是模型的活。这里多嘴一句"电池不行了"，就等于绕开了那套规则。
 */
export function summarize(metrics) {
  const m = metrics
  const hOs = num(m.health_pct_os)
  const hRaw = num(m.health_pct_raw)
  const unit = m.capacity_unit || 'mAh'
  const lines = [
    `设备：${[m.device_vendor, m.device_model, m.device_model_identifier && `(${m.device_model_identifier})`]
      .filter(Boolean)
      .join(' ')}`,
    `电池：${m.battery_model || '未知'}${m.battery_serial ? ` / SN ${m.battery_serial}` : ''}`,
    `设计容量：${m.design_capacity_mah || '未知'} ${unit}`,
    `当前满充容量：${m.full_charge_capacity_mah || '未知'} ${unit}`,
    `健康度：系统口径 ${hOs ?? '未提供'}%${hRaw !== null ? ` / 电量计实测 ${hRaw}%` : ''}`,
    `循环次数：${m.cycle_count || '未提供'}${m.design_cycle_count ? ` / 设计 ${m.design_cycle_count}` : ''}`,
  ]
  if (hOs !== null && hRaw !== null && Math.abs(hOs - hRaw) >= 3) {
    lines.push(
      `⚠ 两种健康度口径相差 ${Math.abs(hOs - hRaw).toFixed(1)} 个百分点，` +
        `含义不同，须按 interpretation.md 第一节处理后再对客户陈述`,
    )
  }
  return lines.join('\n')
}

/** 历史快照文件的位置，多次检测会在这里累积出真实衰减曲线 */
export function historyFile() {
  return join(homedir(), '.battery-health-check', 'history.tsv')
}
