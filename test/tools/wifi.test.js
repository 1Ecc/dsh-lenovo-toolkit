import { test } from 'node:test'
import assert from 'node:assert/strict'

import { wifiDiagnoseFromStatus, wifiGetStatus } from '../../src/tools/wifi/collector.js'
import { summarizeNetworkSamples } from '../../src/tools/wifi/network-monitor.js'
import { buildWifiReportData } from '../../src/tools/wifi/report.js'
import { assertUnsupportedOffWindows } from '../helpers/windows.js'

test('wifiGetStatus 在非 Windows 上优雅降级', async (t) => {
  await assertUnsupportedOffWindows(t, () => wifiGetStatus())
})

test('没有物理网卡时不去 ping、不去查 DNS', async () => {
  // 这是纯逻辑分支，任何平台都能测：没网卡还硬跑连通性检测，
  // 只会把「这台机器没有 Wi-Fi」误报成「网络故障」。
  const envelope = await wifiDiagnoseFromStatus({
    status: 'unsupported',
    data: null,
    warnings: ['系统未检测到物理 Wi-Fi 适配器。'],
  })
  assert.equal(envelope.data.adapter_status, 'not_found')
  for (const key of ['gateway_connectivity', 'dns_resolution', 'internet_connectivity']) {
    assert.equal(envelope.data[key], 'not_run', `${key} 应当是 not_run 而不是失败`)
  }
  assert.equal(envelope.data.gateway_latency_ms, null)
})

test('网卡存在但未连接时同样不跑连通性检测', async () => {
  const envelope = await wifiDiagnoseFromStatus({
    status: 'success',
    data: { interfaces: [{ connected: false, gateway: [] }] },
    warnings: [],
  })
  assert.equal(envelope.data.adapter_status, 'disconnected')
  assert.equal(envelope.data.internet_connectivity, 'not_run')
})

test('采集本身出错时原样透传，不伪装成诊断结论', async () => {
  // 「检测没跑起来」和「检测跑了但网络有问题」必须能被上层区分开，
  // 否则模型会把一次权限失败讲成「你的网络断了」。
  const denied = { status: 'permission_denied', data: null, warnings: [], error: { code: 'windows_access_denied' } }
  assert.equal(await wifiDiagnoseFromStatus(denied), denied)
})

test('网络采样摘要保持原来的确定性计算', () => {
  const summary = summarizeNetworkSamples([
    { elapsed_seconds: 1, download_bytes_per_second: 100, upload_bytes_per_second: 20, latency_ms: 10 },
    { elapsed_seconds: 2, download_bytes_per_second: 300, upload_bytes_per_second: 40, latency_ms: null },
  ])
  assert.equal(summary.average_download_bytes_per_second, 200)
  assert.equal(summary.peak_upload_bytes_per_second, 40)
  assert.equal(summary.average_latency_ms, 10)
  assert.equal(summary.packet_loss_percent, 50)
})

test('体检报告不得带出 SSID、IP、DNS 和网关', () => {
  // 报告是要被截图发出去的，脱敏不是可选项。
  const report = buildWifiReportData(
    {
      interfaces: [{
        connected: true,
        ssid_or_profile: 'MySecretHomeWiFi',
        ipv4: ['192.168.31.77'],
        dns: ['192.168.31.1'],
        gateway: ['192.168.31.1'],
        signal_strength_percent: 80,
        adapter: 'Intel Wi-Fi 6E AX211',
        link_speed: '1.2 Gbps',
      }],
    },
    { adapter_status: 'connected', gateway_connectivity: 'reachable', dns_resolution: 'resolved', internet_connectivity: 'reachable', gateway_latency_ms: 3 },
  )
  const serialized = JSON.stringify(report)
  for (const secret of ['MySecretHomeWiFi', '192.168.31.77', '192.168.31.1']) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/\./g, '\\.')), `报告里泄漏了 ${secret}`)
  }
})
