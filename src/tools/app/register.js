import { defineTool } from '@deepseek-ai/dsh-tools'

import { envelopeOutput } from '../../shared/tool-output.js'
import { appList } from './collector.js'

export const group = 'app'

export function register(ctx) {
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
