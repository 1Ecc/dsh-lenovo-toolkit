import { defineTool } from '@deepseek-ai/dsh-tools'

import { envelopeOutput } from '../../shared/tool-output.js'
import { performanceGetStatus, processList } from './collector.js'

export const group = 'performance'

export function register(ctx) {
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
}
