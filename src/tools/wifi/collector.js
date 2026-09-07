/**
 * 能力域：Wi-Fi 与网络连通性。对应 skill `wifi-diagnosis` 与 `wifi-health-report`。
 *
 * 这些函数原先住在 device 单体采集器里，wifi 组的四个模块都得跨目录去 import。
 * 搬到本组之后依赖回到同级目录，「Wi-Fi 能力都在 wifi/ 下」这件事才成立。
 * 采集与判定逻辑逐字保留，未做改动——它在 Windows 11 上验证过。
 *
 * `wifiDiagnoseFromStatus` 与 `wifiDiagnose` 分开导出是刻意的：
 * 报告类工具已经拿到过 status，不该为了出报告再打一次网卡。
 */
import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import net from 'node:net'

import { runPowerShellJson } from '../../shared/powershell.js'
import { success } from '../../shared/result.js'
import { executionFailure } from '../../shared/windows-failure.js'

export async function wifiGetStatus() {
    try {
        const data = await runPowerShellJson(String.raw `
$wifiAdapters = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object {
  $_.Status -ne 'Not Present' -and ($_.NdisPhysicalMedium -eq 9 -or $_.Name -match 'Wi-Fi|WLAN|Wireless|无线' -or $_.InterfaceDescription -match 'Wi-Fi|WLAN|Wireless|802\.11|无线')
})
$profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)
$signal = $null
$netsh = @(& netsh.exe wlan show interfaces 2>$null)
$percentLine = $netsh | Where-Object { $_ -match ':\s*\d+\s*%' } | Select-Object -First 1
if ($percentLine -and $percentLine -match '(\d+)\s*%') { $signal = [int]$matches[1] }
$items = @($wifiAdapters | ForEach-Object {
  $adapter = $_
  $profile = $profiles | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex } | Select-Object -First 1
  $ipConfig = $null
  try { $ipConfig = Get-NetIPConfiguration -InterfaceIndex $adapter.ifIndex -ErrorAction Stop } catch { $ipConfig = $null }
  [pscustomobject]@{
    interface_index = [int]$adapter.ifIndex
    adapter = $adapter.InterfaceDescription
    interface_alias = $adapter.Name
    connected = ($adapter.Status -eq 'Up' -and $null -ne $profile)
    ssid_or_profile = if ($profile) { $profile.Name } else { $null }
    signal_strength_percent = if ($adapter.Status -eq 'Up') { $signal } else { $null }
    ipv4 = @($ipConfig.IPv4Address | ForEach-Object { $_.IPAddress })
    dns = @($ipConfig.DNSServer.ServerAddresses)
    gateway = @($ipConfig.IPv4DefaultGateway | ForEach-Object { $_.NextHop })
    link_speed = $adapter.LinkSpeed
  }
})
[pscustomobject]@{ supported = ($wifiAdapters.Count -gt 0); interfaces = $items; source = 'Windows NetAdapter/IPConfiguration and netsh' }
`, { timeoutMs: 45_000 });
        if (data.supported === false) {
            return {
                status: "unsupported",
                collected_at: new Date().toISOString(),
                data,
                warnings: ["系统未检测到物理 Wi-Fi 适配器。"],
                error: null,
            };
        }
        const interfaces = Array.isArray(data.interfaces) ? data.interfaces : [];
        const warnings = interfaces.some((item) => item.connected === true && item.signal_strength_percent === null)
            ? ["当前 Windows 环境未提供 Wi-Fi 信号强度。"]
            : [];
        return success(data, warnings);
    }
    catch (error) {
        return executionFailure(error);
    }
}

async function pingGateway(address) {
    if (net.isIP(address) === 0)
        return { state: "unavailable", latency_ms: null };
    return await new Promise((resolve) => {
        const child = spawn("ping.exe", ["-n", "1", "-w", "1500", address], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
        });
        const output = [];
        const timer = setTimeout(() => {
            child.kill();
            resolve({ state: "unreachable", latency_ms: null });
        }, 3_000);
        child.stdout.on("data", (chunk) => output.push(chunk));
        child.once("error", () => {
            clearTimeout(timer);
            resolve({ state: "error", latency_ms: null });
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            const text = Buffer.concat(output).toString();
            const match = text.match(/[=<]\s*(\d+)\s*ms/i);
            resolve({
                state: code === 0 ? "reachable" : "unreachable",
                latency_ms: match?.[1] ? Number(match[1]) : null,
            });
        });
    });
}

async function dnsCheck() {
    try {
        await Promise.race([
            lookup("www.microsoft.com"),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000)),
        ]);
        return "resolved";
    }
    catch {
        return "failed";
    }
}

async function tcpCheck() {
    return await new Promise((resolve) => {
        const socket = net.createConnection({ host: "www.microsoft.com", port: 443 });
        const done = (state) => {
            socket.destroy();
            resolve(state);
        };
        socket.setTimeout(3_000, () => done("unreachable"));
        socket.once("connect", () => done("reachable"));
        socket.once("error", () => done("unreachable"));
    });
}

export async function wifiDiagnoseFromStatus(status) {
    if (status.status === "error" || status.status === "permission_denied")
        return status;
    if (status.status === "unsupported" || !status.data) {
        return success({
            adapter_status: "not_found",
            gateway_connectivity: "not_run",
            dns_resolution: "not_run",
            internet_connectivity: "not_run",
            gateway_latency_ms: null,
            source: "Windows network APIs",
        }, status.warnings);
    }
    const interfaces = Array.isArray(status.data.interfaces) ? status.data.interfaces : [];
    const active = interfaces.find((item) => item.connected === true);
    if (!active) {
        return success({
            adapter_status: "disconnected",
            gateway_connectivity: "not_run",
            dns_resolution: "not_run",
            internet_connectivity: "not_run",
            gateway_latency_ms: null,
            source: "Windows network APIs",
        });
    }
    const gateways = Array.isArray(active.gateway) ? active.gateway : [];
    const gateway = typeof gateways[0] === "string" ? gateways[0] : "";
    const [gatewayResult, dnsResolution, internetConnectivity] = await Promise.all([
        gateway ? pingGateway(gateway) : Promise.resolve({ state: "unavailable", latency_ms: null }),
        dnsCheck(),
        tcpCheck(),
    ]);
    return success({
        adapter_status: "connected",
        gateway_connectivity: gatewayResult.state,
        dns_resolution: dnsResolution,
        internet_connectivity: internetConnectivity,
        gateway_latency_ms: gatewayResult.latency_ms,
        test_targets: ["default gateway", "www.microsoft.com:443"],
        source: "Windows network APIs and Node.js network checks",
    }, ["网络诊断只反映当前连接；VPN、代理或防火墙可能影响结果。"]);
}

export async function wifiDiagnose() {
    return await wifiDiagnoseFromStatus(await wifiGetStatus());
}
