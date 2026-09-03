import { spawn } from "node:child_process";
import net from "node:net";
import { wifiGetStatus } from "../device/collector.js";
import { PowerShellError, runPowerShellJson } from "../../shared/powershell.js";
import { failure, success } from "../../shared/result.js";
function asObjects(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "object" && item !== null) : [];
}
function average(values) {
    return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}
async function pingOnce(address, timeoutMs) {
    if (net.isIP(address) === 0)
        return null;
    return await new Promise((resolve) => {
        const child = spawn("ping.exe", ["-n", "1", "-w", String(timeoutMs), address], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
        });
        const chunks = [];
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            child.kill();
            finish(null);
        }, timeoutMs + 500);
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.once("error", () => finish(null));
        child.once("close", (code) => {
            if (code !== 0)
                return finish(null);
            const match = Buffer.concat(chunks).toString().match(/[=<]\s*(\d+)\s*ms/i);
            finish(match?.[1] ? Number(match[1]) : 0);
        });
    });
}
async function sampleLatencies(gateway, count) {
    const samples = [];
    const startedAt = Date.now();
    for (let index = 1; index <= count; index += 1) {
        const waitMs = startedAt + index * 1000 - Date.now();
        if (waitMs > 0)
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        samples.push(await pingOnce(gateway, 700));
    }
    return samples;
}
async function sampleTraffic(interfaceAlias, count) {
    const result = await runPowerShellJson(String.raw `
$alias = $env:XBB_INTERFACE_ALIAS
$count = ${count}
$intervalMs = 1000
$samples = @()
$previous = Get-NetAdapterStatistics -Name $alias -ErrorAction Stop
$previousAt = [System.Diagnostics.Stopwatch]::StartNew()
$previousSeconds = $previousAt.Elapsed.TotalSeconds
for ($index = 1; $index -le $count; $index++) {
  Start-Sleep -Milliseconds $intervalMs
  $current = Get-NetAdapterStatistics -Name $alias -ErrorAction Stop
  $nowSeconds = $previousAt.Elapsed.TotalSeconds
  $elapsed = [math]::Max([double]0.001, [double]($nowSeconds - $previousSeconds))
  $received = [math]::Max([double]0, [double](([double]$current.ReceivedBytes - [double]$previous.ReceivedBytes) / $elapsed))
  $sent = [math]::Max([double]0, [double](([double]$current.SentBytes - [double]$previous.SentBytes) / $elapsed))
  $samples += [pscustomobject]@{
    elapsed_seconds = [math]::Round($nowSeconds, 2)
    download_bytes_per_second = [math]::Round($received, 0)
    upload_bytes_per_second = [math]::Round($sent, 0)
  }
  $previous = $current
  $previousSeconds = $nowSeconds
}
[pscustomobject]@{ samples = @($samples) }
`, {
        env: { XBB_INTERFACE_ALIAS: interfaceAlias },
        timeoutMs: count * 1000 + 45_000,
    });
    return Array.isArray(result.samples) ? result.samples : [result.samples];
}
export function summarizeNetworkSamples(samples) {
    const downloads = samples.map((sample) => sample.download_bytes_per_second);
    const uploads = samples.map((sample) => sample.upload_bytes_per_second);
    const latencies = samples.flatMap((sample) => sample.latency_ms === null ? [] : [sample.latency_ms]);
    const jitterValues = latencies.slice(1).map((value, index) => Math.abs(value - (latencies[index] ?? value)));
    return {
        average_download_bytes_per_second: Math.round(average(downloads)),
        average_upload_bytes_per_second: Math.round(average(uploads)),
        peak_download_bytes_per_second: Math.round(Math.max(0, ...downloads)),
        peak_upload_bytes_per_second: Math.round(Math.max(0, ...uploads)),
        average_latency_ms: latencies.length === 0 ? null : Math.round(average(latencies) * 10) / 10,
        jitter_ms: jitterValues.length === 0 ? null : Math.round(average(jitterValues) * 10) / 10,
        packet_loss_percent: samples.length === 0 ? null : Math.round(((samples.length - latencies.length) / samples.length) * 1000) / 10,
    };
}
export async function networkMonitorFromStatus(status, durationSeconds) {
    const duration = Math.max(5, Math.min(60, Math.trunc(durationSeconds)));
    if ((status.status === "error" || status.status === "permission_denied") && !status.data) {
        return { ...status, data: null };
    }
    const interfaces = asObjects(status.data?.interfaces);
    const active = interfaces.find((item) => item.connected === true);
    const alias = typeof active?.interface_alias === "string" ? active.interface_alias : null;
    const gateways = Array.isArray(active?.gateway) ? active.gateway : [];
    const gateway = typeof gateways[0] === "string" ? gateways[0] : "";
    if (!alias) {
        return failure("unsupported", "wifi_not_connected", "没有可采样的已连接 Wi-Fi 适配器。");
    }
    try {
        const [traffic, latencies] = await Promise.all([
            sampleTraffic(alias, duration),
            gateway ? sampleLatencies(gateway, duration) : Promise.resolve(Array(duration).fill(null)),
        ]);
        const samples = traffic.map((sample, index) => ({ ...sample, latency_ms: latencies[index] ?? null }));
        const data = {
            duration_seconds: duration,
            interval_ms: 1000,
            sample_count: samples.length,
            samples,
            summary: summarizeNetworkSamples(samples),
            measurement_kind: "active Wi-Fi adapter throughput; not an internet speed test",
            source: "Windows Get-NetAdapterStatistics and gateway ICMP sampling",
        };
        return success(data, [
            "上传/下载表示 Wi-Fi 网卡在采样期间的实际吞吐量，不代表宽带套餐速度或测速结果。",
            ...status.warnings,
        ]);
    }
    catch (error) {
        if (error instanceof PowerShellError && error.kind === "timeout") {
            return failure("error", "network_monitor_timeout", "网络采样执行超时。");
        }
        const category = error instanceof PowerShellError ? error.kind : "unexpected_runtime_error";
        return failure("error", "network_monitor_failed", `无法完成 Wi-Fi 吞吐量采样（${category}）。`);
    }
}
export async function networkMonitor(durationSeconds) {
    return await networkMonitorFromStatus(await wifiGetStatus(), durationSeconds);
}
//# sourceMappingURL=network-monitor.js.map
