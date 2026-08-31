/**
 * 电池健康工具组的注册。
 *
 * 每个工具组导出一个 register(ctx)，由 src/index.js 统一调用。
 * 加新工具组时照抄这个形状即可，不需要动插件入口的结构。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { toText } from '../../shared/errors.js'
import { collect, detectPlatform, historyFile, readRules, renderTrend, summarize } from './collector.js'

export const group = 'battery'

export function register(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'battery_health_collect',
      description:
        '采集本机电池数据：机型、电池型号、设计容量、当前满充容量、健康度（系统口径与电量计实测两个口径）、' +
        '循环次数、温度与寿命统计。同时生成系统官方电池报告并累积历史快照。支持 macOS 与 Windows。' +
        '拿到结果后请用 battery_health_rules 取判读规则再下结论，不要直接凭数值判断。',
      parameters: {
        outDir: {
          type: 'string',
          description: '输出目录。不传则写到系统临时目录下的带时间戳目录。',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, v) => [
          { type: 'text', text: summarize(v.metrics) },
          {
            type: 'text',
            text:
              `\n官方电池报告：${v.metrics.official_report || '未生成'}\n` +
              `历史快照：${v.metrics.history_file || historyFile()}\n` +
              `原始数据目录：${v.metrics.raw_dir || '未生成'}`,
          },
        ],
      },
      async execute(args) {
        try {
          const r = await collect({ outDir: args.outDir })
          return {
            platform: r.platform,
            outDir: r.outDir,
            metricsPath: r.metricsPath,
            metrics: r.metrics,
          }
        } catch (err) {
          throw new Error(toText(err))
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'battery_health_trend',
      description:
        '渲染容量衰减趋势图（SVG，浏览器可直接打开）。历史点足够时用日期轴画真实曲线，' +
        '否则用循环次数轴并叠加厂商规格参考线。单个实测点时画成推算区间而非确定的单一预测值。' +
        '需要先调用 battery_health_collect 拿到 metricsPath。依赖 python3（仅标准库）。',
      parameters: {
        metricsPath: {
          type: 'string',
          required: true,
          description: 'battery_health_collect 返回的 metricsPath',
        },
        outPath: {
          type: 'string',
          description: '输出 SVG 路径。不传则与 metrics.env 同目录，命名为 battery-trend.svg。',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, v) => [{ type: 'text', text: `趋势图已生成：${v.path}` }],
      },
      async execute(args) {
        try {
          return await renderTrend({ metricsPath: args.metricsPath, outPath: args.outPath })
        } catch (err) {
          throw new Error(toText(err))
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'battery_health_rules',
      description:
        '取判读规则文档。interpretation=健康度分级、衰减速率公式、异常信号清单、结论四档；' +
        'platform=各平台数据源与字段口径；offers=服务推荐的触发条件与纪律。' +
        '下健康度结论前必须先读 interpretation，不要凭印象判断。',
      parameters: {
        which: {
          type: 'string',
          description: 'interpretation（默认）/ platform / offers',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        try {
          return readRules(args.which || 'interpretation')
        } catch (err) {
          throw new Error(toText(err))
        }
      },
    }),
  )

  // Linux 等平台上工具会明确报错而不是静默失败，这里提前说清楚，省得用户装完一脸问号
  if (detectPlatform() === 'unsupported') {
    ctx.logger?.('lenovo-toolkit')?.warn?.(
      `当前平台 ${process.platform} 暂不支持电池检测，工具已注册但调用会返回明确错误`,
    )
  }
}
