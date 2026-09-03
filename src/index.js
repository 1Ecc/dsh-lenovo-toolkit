/**
 * 联想专业工具集 —— DeepSeek Harness 插件入口。
 *
 * 这个插件是一个容器：每类专业能力是 src/tools/<组名>/ 下的一个工具组，
 * 各自导出 register(ctx)，这里统一挂载。加新工具组只需要往 GROUPS 里加一行，
 * 不需要改这个文件的结构。
 *
 * 与 .dsh/skills/ 下的 skill 是互补关系，不是二选一：
 *   - skill 负责"怎么判读、怎么写报告、什么时候推荐"，是给模型看的指令；
 *   - 插件负责"把脚本确定性地跑起来并返回结构化结果"。
 * 只装了插件没装 skill 的用户，可以通过各工具组的 *_rules 工具把判读规则取出来，
 * 所以插件本身是自洽的。
 *
 * 用 ESM JavaScript 而不是 TypeScript 是刻意的：没有构建步骤，从源码装也不需要
 * allowBuilds 授权，和采集脚本"零依赖"的取向一致。
 */

import * as battery from './tools/battery/register.js'
import * as device from './tools/device/register.js'
import * as wifi from './tools/wifi/register.js'
import * as actions from './tools/actions/register.js'

export const name = 'lenovo-toolkit'

/** 等 tools 服务就绪后再挂载，否则 ctx.tools 可能还不存在 */
export const inject = ['tools']

/** 已启用的工具组。新增专业工具时在这里追加。 */
const GROUPS = [battery, device, wifi, actions]

export function apply(ctx) {
  for (const g of GROUPS) g.register(ctx)
}
