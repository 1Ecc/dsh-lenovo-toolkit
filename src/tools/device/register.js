import { defineTool } from '@deepseek-ai/dsh-tools'

import { envelopeOutput } from '../../shared/tool-output.js'
import {
  appList,
  deviceGetInfo,
  performanceGetStatus,
  processList,
  storageGetStatus,
} from './collector.js'

export const group = 'device'

export function register(ctx) {
  ctx.tools.register(defineTool({
    name: 'device_get_info',
    description: '读取 Windows 本机厂商、型号、系统、CPU、GPU、内存和物理存储信息；不读取序列号。',
    parameters: {},
    output: envelopeOutput,
    async execute() { return deviceGetInfo() },
  }))

  ctx.tools.register(defineTool({
    name: 'performance_get_status',
    description: '读取 Windows 当前 CPU、内存和开机时长。结果是时点快照，不能单独证明长期问题。',
    parameters: {},
    output: envelopeOutput,
    async execute() { return performanceGetStatus() },
  }))

  ctx.tools.register(defineTool({
    name: 'process_list',
    description: '按 CPU 或私有工作集列出当前高占用进程，不返回命令行参数或完整路径。',
    parameters: {
      sort_by: { type: 'string', description: 'cpu（默认）或 memory' },
      limit: { type: 'number', description: '返回条数，1 到 20，默认 5' },
    },
    output: envelopeOutput,
    async execute(args) {
      const sortBy = args.sort_by === 'memory' ? 'memory' : 'cpu'
      const limit = Math.max(1, Math.min(20, Math.trunc(args.limit ?? 5)))
      return processList(sortBy, limit)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'storage_get_status',
    description: '读取 Windows 固定卷的文件系统、总容量、已用空间和剩余空间；不扫描用户文件。',
    parameters: {},
    output: envelopeOutput,
    async execute() { return storageGetStatus() },
  }))

  ctx.tools.register(defineTool({
    name: 'app_list',
    description: '按名称关键词查询 Windows 已安装软件。必须提供至少 2 个字符，不允许枚举全部软件。',
    parameters: {
      query: { type: 'string', required: true, description: '应用名称关键词，2 到 100 个字符' },
      limit: { type: 'number', description: '返回条数，1 到 50，默认 10' },
    },
    output: envelopeOutput,
    async execute(args) {
      const limit = Math.max(1, Math.min(50, Math.trunc(args.limit ?? 10)))
      return appList(args.query, limit)
    },
  }))
}
