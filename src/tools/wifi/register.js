import { defineTool } from '@deepseek-ai/dsh-tools'

import { envelopeOutput, imageEnvelopeOutput } from '../../shared/tool-output.js'
import { wifiDiagnose, wifiGetStatus } from '../device/collector.js'
import { generateWifiHtmlReport } from './html-report.js'
import { networkMonitor } from './network-monitor.js'
import { generateWifiHealthReport } from './report.js'

export const group = 'wifi'

export function register(ctx) {
  ctx.tools.register(defineTool({
    name: 'wifi_get_status',
    description: '读取 Windows 物理 Wi-Fi 适配器、连接配置、IP、DNS、网关和可获得的信号强度。',
    parameters: {},
    output: envelopeOutput,
    async execute() { return wifiGetStatus() },
  }))

  ctx.tools.register(defineTool({
    name: 'wifi_diagnose',
    description: '检查 Windows Wi-Fi 适配器、默认网关、DNS 和互联网 TCP 连通性；会连接默认网关及 www.microsoft.com:443。',
    parameters: {},
    output: envelopeOutput,
    async execute() { return wifiDiagnose() },
  }))

  ctx.tools.register(defineTool({
    name: 'network_monitor',
    description: '按秒采样当前 Wi-Fi 网卡的真实上传/下载吞吐和默认网关延迟；不是主动宽带测速。',
    parameters: {
      duration_seconds: { type: 'number', description: '采样秒数，5 到 60，默认 30' },
    },
    output: envelopeOutput,
    async execute(args) {
      const duration = Math.max(5, Math.min(60, Math.trunc(args.duration_seconds ?? 30)))
      return networkMonitor(duration)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wifi_generate_report',
    description: '生成确定性的脱敏 Wi-Fi SVG 体检图片；隐藏 SSID、IP、DNS 和网关地址。',
    parameters: {},
    output: imageEnvelopeOutput('image/svg+xml', 'svg'),
    async execute() { return generateWifiHealthReport() },
  }))

  ctx.tools.register(defineTool({
    name: 'wifi_generate_html_report',
    description: '执行 5 到 60 秒真实网络采样，生成自包含、脱敏的本地 HTML 动态报告。',
    parameters: {
      duration_seconds: { type: 'number', description: '采样秒数，5 到 60，默认 30' },
    },
    output: envelopeOutput,
    async execute(args) {
      const duration = Math.max(5, Math.min(60, Math.trunc(args.duration_seconds ?? 30)))
      const generated = await generateWifiHtmlReport(duration)
      return generated.envelope
    },
  }))
}
