/**
 * 联想专业工具集 —— DeepSeek Harness 插件入口。
 *
 * 这个插件是一个容器：**一个工具组 = 一个能力域**，落在 src/tools/<能力域>/ 下，
 * 各自导出 register(ctx)，这里统一挂载。加新能力域只需要往 GROUPS 里加一行，
 * 不需要改这个文件的结构。
 *
 * 能力域按「用户会分开问的问题」切分，而不是按实现方便切分：
 * 「我这台是什么配置」「怎么这么卡」「盘满了」「装没装某某软件」是四个独立诉求，
 * 各自对应一个 skill，所以代码也分开。切在一起会让 skill 与工具组失去一一对应，
 * 加一个能力就得改一堆无关文件——那正是 H4 假设（边际成本下降）要证伪的东西。
 *
 * actions 是唯一的例外：它不对应某个诊断 skill，而是被各 skill 复用的
 * 「需逐次确认的低风险操作」出口，所以按职责而非诉求单列一组。
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
import * as performance from './tools/performance/register.js'
import * as storage from './tools/storage/register.js'
import * as app from './tools/app/register.js'
import * as wifi from './tools/wifi/register.js'
import * as actions from './tools/actions/register.js'

export const name = 'lenovo-toolkit'

/** 等 tools 服务就绪后再挂载，否则 ctx.tools 可能还不存在 */
export const inject = ['tools']

/** 已启用的能力域。新增专业能力时在这里追加一行。 */
const GROUPS = [battery, device, performance, storage, app, wifi, actions]

export function apply(ctx) {
  for (const g of GROUPS) g.register(ctx)
}
