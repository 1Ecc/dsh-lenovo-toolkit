/**
 * 电池健康工具组的注册。
 *
 * 每个工具组导出一个 register(ctx)，由 src/index.js 统一调用。
 * 加新工具组时照抄这个形状即可，不需要动插件入口的结构。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { toText } from '../../shared/errors.js'
import { envelopeOutput, imageEnvelopeOutput } from '../../shared/tool-output.js'
import { failure, success } from '../../shared/result.js'
import { collect, detectPlatform, historyFile, readRules, renderTrend, summarize } from './collector.js'
import {
  buildFaultDescription,
  createAppointmentSession,
  dropSession,
  findNearestStores,
  getRepairService,
  getSession,
  getSubmitSignature,
  listAppointmentDevices,
  listAppointmentSlots,
  listAppointmentStores,
  locateByIp,
  lookupBatteryPrice,
  lookupWarranty,
  mockHumanHandoff,
  putSession,
  submitAppointment,
} from './lenovo-service.js'

export const group = 'battery'

/**
 * 服务链路工具会把主机编号发到联想官方接口。序列号是 AGENTS.md 第 5 条意义上的用户数据，
 * 所以沿用 actions 组的「逐次确认」约定：模型必须先告诉用户要发什么、发到哪，用户同意后才传 confirmed=true。
 */
const sendSnConfirmation =
  '本工具会把主机编号发送到联想官方接口（newsupport.lenovo.com.cn）。调用前必须向用户说明这一点并取得同意，只有确认后才能传 confirmed=true。'

function requireConfirmed(confirmed) {
  if (confirmed) return null
  return failure(
    'permission_denied',
    'confirmation_required',
    '需要先向用户说明将把主机编号发送到联想官方接口并取得明确同意，然后以 confirmed=true 重试。',
  )
}

/** 把 ToolkitError 收敛成 envelope，让模型能区分「没查到」「接口变了」「网络不通」 */
function toEnvelopeFailure(err) {
  const code = err?.code || 'unknown'
  const status = code === 'NETWORK' ? 'unsupported' : 'error'
  return failure(status, code.toLowerCase(), toText(err))
}

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
        '渲染容量衰减趋势图并**直接返回 SVG 图片**，用于在报告的「一、电池健康概览」里内联展示，' +
        '不要只把路径丢给用户。历史点足够时用日期轴画真实曲线，否则用循环次数轴并叠加厂商规格参考线；' +
        '单个实测点时画成推算区间而非确定的单一预测值。' +
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
      output: imageEnvelopeOutput('image/svg+xml', 'svg'),
      async execute(args) {
        try {
          const r = await renderTrend({ metricsPath: args.metricsPath, outPath: args.outPath })
          return { envelope: success({ path: r.path, bytes: r.svg.length }), svg: r.svg }
        } catch (err) {
          // 没装 Python 只是趋势图缺席，不该让整次检测失败——所以返回 envelope 而不是抛
          return {
            envelope: failure('error', (err?.code || 'render_failed').toLowerCase(), toText(err)),
            svg: null,
          }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'battery_health_rules',
      description:
        '取判读规则文档。interpretation=健康度分级、衰减速率公式、异常信号清单、结论四档；' +
        'platform=各平台数据源与字段口径；offers=服务链路的触发条件与纪律；' +
        'service=保修/备件价/预约/转人工的接口与操作流程。' +
        '下健康度结论前必须先读 interpretation，不要凭印象判断。',
      parameters: {
        which: {
          type: 'string',
          description: 'interpretation（默认）/ platform / offers / service',
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

  ctx.tools.register(
    defineTool({
      name: 'battery_warranty_lookup',
      description:
        `按主机编号查联想官方保修状态：机型、购机日期、各保修项目起止与剩余天数，并单独判定电池是否在保` +
        `（延保条款常写明不包含电池，整机在保不等于电池在保；无法判定时 battery_covered 为 null，须如实转述）。` +
        `主机编号取 battery_health_collect 返回的 device_serial。仅在诊断结论触发或用户明确表达换电池/保修意向后调用。${sendSnConfirmation}`,
      parameters: {
        sn: { type: 'string', required: true, description: '主机编号（机身底部标签 S/N，或 metrics 的 device_serial）' },
        confirmed: { type: 'boolean', required: true, description: '用户明确同意把主机编号发给联想后才可为 true' },
      },
      output: envelopeOutput,
      async execute(args) {
        const denied = requireConfirmed(args.confirmed)
        if (denied) return denied
        try {
          const r = await lookupWarranty(args.sn)
          const warnings = []
          if (r.battery_covered === null) warnings.push('电池是否在保无法从条款判定，需门店核定')
          return success(r, warnings)
        } catch (err) {
          return toEnvelopeFailure(err)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'battery_part_price_lookup',
      description:
        `按主机编号查联想官网公示的原厂电池备件价（不含工时），以及保外维修定金（膨胀金）商品。` +
        `available=false 表示联想暂未公示该机型价格，此时引导打 400-990-8888 或到店询价，不要估价。${sendSnConfirmation}`,
      parameters: {
        sn: { type: 'string', required: true, description: '主机编号' },
        confirmed: { type: 'boolean', required: true, description: '用户明确同意把主机编号发给联想后才可为 true' },
      },
      output: envelopeOutput,
      async execute(args) {
        const denied = requireConfirmed(args.confirmed)
        if (denied) return denied
        try {
          const r = await lookupBatteryPrice(args.sn)
          return success(r, r.available ? [] : [r.reason])
        } catch (err) {
          return toEnvelopeFailure(err)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'battery_service_stores',
      description:
        '查离用户最近的联想服务门店（免登录）。不传 city 时先按出口 IP 定位城市；定位失败会返回 city_required，' +
        '此时问用户所在城市再调一次。返回门店编码、地址、电话、营业时间、距离；distance_is_estimate=true 时距离只是城市中心估算。' +
        '同时按传入的检测数字生成预约工单用的故障描述 fault_description。',
      parameters: {
        city: { type: 'string', description: '城市名，如「北京」「杭州」。不传则按 IP 定位' },
        limit: { type: 'number', description: '返回门店数，默认 3' },
        conclusion: { type: 'string', description: '诊断结论档位，如「建议更换电池」' },
        deviceModel: { type: 'string', description: 'metrics.device_model' },
        batteryModel: { type: 'string', description: 'metrics.battery_model' },
        designMah: { type: 'string', description: 'metrics.design_capacity_mah' },
        fullMah: { type: 'string', description: 'metrics.full_charge_capacity_mah' },
        healthPct: { type: 'string', description: '对客户陈述用的健康度（系统口径）' },
        cycleCount: { type: 'string', description: 'metrics.cycle_count' },
        warrantyNote: { type: 'string', description: 'battery_warranty_lookup 返回的 battery_note' },
        batteryPriceCny: { type: 'number', description: 'battery_part_price_lookup 返回的 standard_price_cny' },
      },
      output: envelopeOutput,
      async execute(args) {
        try {
          let loc = null
          if (!args.city) {
            loc = await locateByIp()
            if (!loc) {
              return failure('error', 'city_required', '无法按 IP 定位城市，请询问用户所在城市后重试')
            }
          }
          const r = await findNearestStores({
            city: args.city || loc.city,
            lat: loc?.lat,
            lng: loc?.lng,
            limit: args.limit || 3,
          })
          const data = {
            ...r,
            located_by: loc ? loc.method : 'user',
            fault_description: buildFaultDescription({
              conclusion: args.conclusion,
              deviceModel: args.deviceModel,
              batteryModel: args.batteryModel,
              designMah: args.designMah,
              fullMah: args.fullMah,
              healthPct: args.healthPct,
              cycleCount: args.cycleCount,
              warrantyNote: args.warrantyNote,
              batteryPriceCny: args.batteryPriceCny,
            }),
          }
          return success(data, r.distance_is_estimate ? ['距离按城市中心估算，仅供排序参考'] : [])
        } catch (err) {
          return toEnvelopeFailure(err)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'battery_service_handoff',
      description:
        '把电池检测结论转交联想人工服务，返回转接回执（工单号、排队位置、预计等待）。' +
        '仅在用户明确要求转人工时调用；调用前要征得同意并说明会转交的摘要内容。',
      parameters: {
        sn: { type: 'string', description: '主机编号（可选）' },
        summary: { type: 'string', required: true, description: '转交给人工的检测摘要，不含手机号等个人信息' },
        reason: { type: 'string', description: '转人工原因' },
      },
      output: envelopeOutput,
      async execute(args) {
        return success(mockHumanHandoff({ sn: args.sn, summary: args.summary, reason: args.reason }))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'battery_appointment_start',
      description:
        '用用户浏览器里的 cerpreg-passport cookie 建立预约会话，返回 sessionId、账号下已绑定的设备列表，' +
        '以及目标 SN 可预约的维修服务类别。cookie 的拿法：用 open_url 打开 ' +
        'https://serviceorder.lenovo.com.cn/h5/#/serviceOrderPC/selectService 让**用户自己登录**，' +
        '登录后在该页读 document.cookie 里的 cerpreg-passport；没有浏览器自动化能力就请用户手动复制。' +
        '**绝不要去读浏览器的 cookie 数据库，也绝不要代用户输入账号密码。** ' +
        'cookie 只用于换 token，不落盘；token 存在进程内，只通过 sessionId 引用。' +
        '设备列表里没有目标 SN 时，要让用户先在页面上「绑定设备」。',
      parameters: {
        cookie: {
          type: 'string',
          required: true,
          description: 'cerpreg-passport 的值；整条 document.cookie 也可以，会自动挑出需要的那条',
        },
        sn: { type: 'string', description: '要预约的主机编号；传了就一并返回该机可预约的服务类别' },
      },
      output: envelopeOutput,
      async execute(args) {
        try {
          const session = await createAppointmentSession(args.cookie)
          const sessionId = putSession(session)
          const devices = await listAppointmentDevices(session)
          const data = {
            session_id: sessionId,
            lenovoid: session.lenovoid,
            account_mobile_masked: session.mobile_masked,
            devices,
            expires_in_minutes: 30,
          }
          const warnings = []
          if (args.sn) {
            const sn = String(args.sn).trim().toUpperCase()
            data.sn_bound = devices.some((d) => String(d.sn || '').toUpperCase() === sn)
            if (data.sn_bound) {
              data.service = await getRepairService(session, sn)
            } else {
              warnings.push(`账号下没有绑定 ${sn}，需先让用户在预约页「绑定设备」再继续`)
            }
          }
          return success(data, warnings)
        } catch (err) {
          return toEnvelopeFailure(err)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'battery_appointment_options',
      description:
        '取预约要填的可选项：可预约门店（按 city/county 过滤），以及传了 stationCode 时该门店未来几天的可预约时段。' +
        '标 available=false 的时段是约满或当天不可约。**时段必须原样列给用户挑，不要替用户选。** ' +
        '需要先调 battery_appointment_start 拿 sessionId。',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'battery_appointment_start 返回的 session_id' },
        sn: { type: 'string', required: true, description: '主机编号' },
        city: { type: 'string', description: '市，如「北京市」' },
        county: { type: 'string', description: '区/县' },
        stationCode: { type: 'string', description: '门店编码；传了才返回该门店的可预约时段' },
      },
      output: envelopeOutput,
      async execute(args) {
        try {
          const session = getSession(args.sessionId)
          const stores = await listAppointmentStores(session, {
            sn: args.sn,
            city: args.city,
            county: args.county,
          })
          const data = { stores }
          if (args.stationCode) {
            data.station_code = args.stationCode
            data.days = await listAppointmentSlots(session, { stationCode: args.stationCode })
          }
          return success(data, stores.length ? [] : ['该区域没有可接预约的网点，换个区县或改用上门服务'])
        } catch (err) {
          return toEnvelopeFailure(err)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'battery_appointment_submit',
      description:
        '提交联想服务预约单（到店或上门）。**这是不可撤回的对外动作**：调用前必须把整单（门店、时段、' +
        '联系人、手机号、故障描述）向用户复述一遍并得到明确同意，然后才能传 confirmed=true。' +
        '故障描述用 battery_service_stores 生成的 fault_description（上限 100 字）。' +
        '提交成功后把工单号反馈给用户；返回 already_booked 表示该设备已有预约单，不要重试。',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'battery_appointment_start 返回的 session_id' },
        sn: { type: 'string', required: true, description: '主机编号' },
        desc: { type: 'string', required: true, description: '故障描述，≤100 字' },
        name: { type: 'string', required: true, description: '联系人昵称（向用户索取，不要编）' },
        phone: { type: 'string', required: true, description: '11 位手机号（向用户索取）' },
        appointmentDate: { type: 'string', required: true, description: 'battery_appointment_options 返回的 date，如 2026-09-12' },
        timeBucket: { type: 'string', required: true, description: '所选时段，原样取 slots[].time，如 10:00-11:00' },
        mode: { type: 'string', description: 'store 到店（默认）/ door 上门' },
        stationCode: { type: 'string', description: '到店必填：门店编码' },
        address: { type: 'string', description: '上门必填：详细地址' },
        province: { type: 'string', description: '上门：省' },
        city: { type: 'string', description: '上门：市' },
        county: { type: 'string', description: '上门：区/县' },
        confirmed: { type: 'boolean', required: true, description: '用户对这一单明确说了提交之后才可为 true' },
      },
      output: envelopeOutput,
      async execute(args) {
        if (!args.confirmed) {
          return failure(
            'permission_denied',
            'confirmation_required',
            '提交预约是不可撤回的操作。请先把门店、时段、联系人、手机号、故障描述复述给用户确认，再以 confirmed=true 重试。',
          )
        }
        try {
          const session = getSession(args.sessionId)
          const service = await getRepairService(session, args.sn)
          const device = (await listAppointmentDevices(session)).find(
            (d) => String(d.sn || '').toUpperCase() === String(args.sn).toUpperCase(),
          )
          if (!device) {
            return failure('error', 'device_not_bound', `账号下没有绑定 ${args.sn}，请先在预约页绑定设备`)
          }
          const smallClassId = service.children?.[0]?.id
          const signature = await getSubmitSignature(session, {
            sn: args.sn,
            bigClassId: service.big_class_id,
            smallClassId: service.category_type === 2 ? smallClassId : undefined,
          })
          const store =
            args.mode === 'door'
              ? null
              : (await listAppointmentStores(session, { sn: args.sn, city: args.city, county: args.county })).find(
                  (s) => String(s.code) === String(args.stationCode),
                )
          const r = await submitAppointment(session, {
            sn: args.sn,
            materialNo: device.material_no,
            desc: args.desc,
            signature,
            bigClassId: service.big_class_id,
            bigClass: service.big_class,
            smallClassId: service.category_type === 2 ? smallClassId : '',
            smallClass: service.category_type === 2 ? service.children?.[0]?.name : '',
            categoryType: service.category_type,
            mode: args.mode === 'door' ? 'door' : 'store',
            stationCode: args.stationCode,
            lat: store?.lat,
            lng: store?.lng,
            appointmentDate: args.appointmentDate,
            timeBucket: args.timeBucket,
            province: args.province,
            city: args.city,
            county: args.county,
            address: args.address,
            name: args.name,
            phone: args.phone,
          })
          // 单已经提交了，登录凭据就没有留着的理由了
          dropSession(args.sessionId)
          return success({ ...r, store: store ? { code: store.code, name: store.name, address: store.address } : null })
        } catch (err) {
          return toEnvelopeFailure(err)
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
