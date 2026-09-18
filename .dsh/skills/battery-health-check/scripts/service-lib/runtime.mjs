/**
 * 运行环境前置检查：只有一条规则——Node 22 或更新。
 *
 * 规则只有一条，是因为多一条分支弱一点的 agent 就会在分支上打转（实跑里它为 Node 20 能不能用
 * 折腾了一整轮，而真正的故障根本不在这）。但"一刀切"有个代价：不少宿主 shell 里解析到的 node
 * 是自带的旧版本，机器上其实装着新版。所以这里先在几个固定位置找一个够新的 node，找到就
 * 用它重新执行自己，模型完全无感；实在没有才报 NODE_TOO_OLD，把安装命令直接写进 message。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { ToolkitError } from './errors.mjs'

export const NODE_MIN_MAJOR = 22
const REEXEC_FLAG = 'LENOVO_BATTERY_SERVICE_REEXEC'

export const INSTALL_HINT = process.platform === 'win32'
  ? '安装 Node 22 或更新：winget install OpenJS.NodeJS.LTS（或到 https://nodejs.org 下载 LTS 安装包）；装完重跑同一条命令，不用改 PATH'
  : process.platform === 'darwin'
    ? '安装 Node 22 或更新：brew install node（或到 https://nodejs.org 下载 LTS 安装包）；装完重跑同一条命令'
    : '安装 Node 22 或更新（发行版包管理器或 https://nodejs.org 的 LTS 版本）；装完重跑同一条命令'

const major = version => Number(String(version).replace(/^v/, '').split('.')[0])

export const nodeIsNewEnough = (version = process.versions.node) => major(version) >= NODE_MIN_MAJOR

/** 列出某个目录下的版本子目录（nvm / fnm / volta 的布局），不存在就返回空。 */
function versionDirs(base, ...rest) {
  try {
    return readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(base, d.name, ...rest))
  } catch { return [] }
}

/** 常见的 node 安装位置。只看固定路径和 PATH，不做全盘搜索。 */
export function nodeCandidates(env = process.env) {
  const home = homedir()
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const fromPath = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean).map(dir => join(dir, exe))
  const fixed = process.platform === 'win32'
    ? [
        join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', exe),
        join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', exe),
        join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'nodejs', exe),
        ...(env.NVM_SYMLINK ? [join(env.NVM_SYMLINK, exe)] : []),
        ...versionDirs(env.NVM_HOME || join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'nvm'), exe),
        ...versionDirs(join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Volta', 'tools', 'image', 'node'), exe),
        ...versionDirs(join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'fnm', 'node-versions'), 'installation', exe),
      ]
    : [
        '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node',
        ...versionDirs('/opt/homebrew/opt').filter(p => /node(@\d+)?$/.test(p)).map(p => join(p, 'bin', exe)),
        ...versionDirs('/usr/local/opt').filter(p => /node(@\d+)?$/.test(p)).map(p => join(p, 'bin', exe)),
        ...versionDirs(join(home, '.nvm', 'versions', 'node'), 'bin', exe),
        ...versionDirs(join(home, '.volta', 'tools', 'image', 'node'), 'bin', exe),
        ...versionDirs(join(home, '.fnm', 'node-versions'), 'installation', 'bin', exe),
        ...versionDirs(join(home, '.local', 'share', 'fnm', 'node-versions'), 'installation', 'bin', exe),
      ]
  return [...new Set([...fixed, ...fromPath])].filter(p => p !== process.execPath && existsSync(p))
}

function probeVersion(executable) {
  const result = spawnSync(executable, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  const version = result.status === 0 ? String(result.stdout).trim() : ''
  return /^\d+\.\d+\.\d+/.test(version) ? version : null
}

/** 找机器上最新的、且够新的 node；没有返回 null。 */
export function findNewerNode(env = process.env) {
  let best = null
  for (const candidate of nodeCandidates(env)) {
    const version = probeVersion(candidate)
    if (!version || !nodeIsNewEnough(version)) continue
    if (!best || major(version) > major(best.version)) best = { executable: candidate, version }
  }
  return best
}

/**
 * 当前 Node 够新就直接返回；不够新就找一个够新的重新执行同一条命令并退出。
 * 找不到抛 NODE_TOO_OLD。返回 false 表示已经交给新进程处理（调用方应直接结束）。
 */
export function ensureNode(scriptPath, args, { env = process.env, exit = code => process.exit(code), currentVersion = process.versions.node } = {}) {
  if (nodeIsNewEnough(currentVersion)) return true
  const found = env[REEXEC_FLAG] ? null : findNewerNode(env)
  if (!found) {
    throw new ToolkitError(`当前 Node ${process.version} 过旧。${INSTALL_HINT}`, 'NODE_TOO_OLD')
  }
  const result = spawnSync(found.executable, [scriptPath, ...args], {
    stdio: 'inherit', windowsHide: true, env: { ...env, [REEXEC_FLAG]: '1' },
  })
  exit(result.status ?? 1)
  return false
}
