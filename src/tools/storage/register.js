import { defineTool } from '@deepseek-ai/dsh-tools'

import { envelopeOutput } from '../../shared/tool-output.js'
import { storageGetStatus } from './collector.js'

export const group = 'storage'

export function register(ctx) {
  ctx.tools.register(defineTool({
    name: 'storage_get_status',
    description: '读取 Windows 固定卷的文件系统、总容量、已用空间和剩余空间；不扫描用户文件。',
    parameters: {},
    output: envelopeOutput,
    async execute() { return storageGetStatus() },
  }))
}
