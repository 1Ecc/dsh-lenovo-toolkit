/**
 * 包内资源定位。
 *
 * skill 资源（SKILL.md / references / scripts）随 npm 包一起分发，
 * 路径必须从模块自身推导，不能依赖 cwd——插件是被 DSH 从任意目录加载的。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { ToolkitError } from './errors.js'

/** 包根目录（src/shared/ 往上两级） */
export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * skill 资源根目录。
 *
 * 用 .dsh/skills 是因为它同时是 DSH 的项目级 skill 加载路径——同一份文件既被
 * skill 加载器扫到，也被插件当资源读，不需要维护两处。
 */
export const SKILLS_ROOT = join(PKG_ROOT, '.dsh', 'skills')

/** 某个 skill 的目录 */
export function skillDir(skill) {
  return join(SKILLS_ROOT, skill)
}

/** skill 下的脚本路径，顺带校验存在性 */
export function skillScript(skill, filename) {
  const p = join(skillDir(skill), 'scripts', filename)
  if (!existsSync(p)) throw new ToolkitError(`脚本缺失：${p}`, 'SCRIPT_MISSING')
  return p
}

/** 读 skill 下的文档（references/*.md 等） */
export function readSkillDoc(skill, relPath) {
  const p = join(skillDir(skill), relPath)
  if (!existsSync(p)) throw new ToolkitError(`文档缺失：${p}`, 'DOC_MISSING')
  return readFileSync(p, 'utf8')
}
