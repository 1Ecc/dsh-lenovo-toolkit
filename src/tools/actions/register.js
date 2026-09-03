import { defineTool } from '@deepseek-ai/dsh-tools'

import { envelopeOutput } from '../../shared/tool-output.js'
import { copyDiagnosticReport, openApp, openSystemSettings, openUrl } from './collector.js'

export const group = 'actions'

const confirmation = '调用前必须向用户说明具体动作并取得明确同意；只有确认后才能传 confirmed=true。'

export function register(ctx) {
  ctx.tools.register(defineTool({
    name: 'open_system_settings',
    description: `打开受控的 Windows 设置页面，不修改设置。${confirmation}`,
    parameters: {
      page: { type: 'string', required: true, description: 'power / network / storage / apps / display / bluetooth / windows_update' },
      confirmed: { type: 'boolean', required: true, description: '用户明确同意本次具体操作后才可为 true' },
    },
    output: envelopeOutput,
    async execute(args) { return openSystemSettings(args.page, args.confirmed) },
  }))

  ctx.tools.register(defineTool({
    name: 'open_app',
    description: `只允许打开任务管理器或 Lenovo Vantage，不接受任意路径和命令。${confirmation}`,
    parameters: {
      app: { type: 'string', required: true, description: 'task_manager 或 lenovo_vantage' },
      confirmed: { type: 'boolean', required: true, description: '用户明确同意本次具体操作后才可为 true' },
    },
    output: envelopeOutput,
    async execute(args) { return openApp(args.app, args.confirmed) },
  }))

  ctx.tools.register(defineTool({
    name: 'open_url',
    description: `只允许打开 HTTPS 的联想和微软官方白名单 URL。${confirmation}`,
    parameters: {
      url: { type: 'string', required: true, description: '要打开的官方 HTTPS URL' },
      confirmed: { type: 'boolean', required: true, description: '用户明确同意打开该 URL 后才可为 true' },
    },
    output: envelopeOutput,
    async execute(args) { return openUrl(args.url, args.confirmed) },
  }))

  ctx.tools.register(defineTool({
    name: 'copy_diagnostic_report',
    description: `把不超过 12000 字符的诊断摘要写入系统剪贴板。${confirmation}`,
    parameters: {
      report: { type: 'string', required: true, description: '已去除不必要敏感信息的诊断摘要' },
      confirmed: { type: 'boolean', required: true, description: '用户明确同意复制该摘要后才可为 true' },
    },
    output: envelopeOutput,
    async execute(args) { return copyDiagnosticReport(args.report, args.confirmed) },
  }))
}
