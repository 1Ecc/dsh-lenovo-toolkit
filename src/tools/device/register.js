import { defineTool } from '@deepseek-ai/dsh-tools'

import { envelopeOutput } from '../../shared/tool-output.js'
import { deviceGetInfo } from './collector.js'

export const group = 'device'

export function register(ctx) {
  ctx.tools.register(defineTool({
    name: 'device_get_info',
    description: '读取 Windows 本机厂商、型号、系统、CPU、GPU、内存和物理存储信息；不读取序列号。',
    parameters: {},
    output: envelopeOutput,
    async execute() { return deviceGetInfo() },
  }))
}
