import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { runPowerShellJson, PowerShellError } from "../../shared/powershell.js";
import { failure, success } from "../../shared/result.js";
function executionFailure(error) {
    if (error instanceof PowerShellError) {
        if (/Access is denied|拒绝访问|0x80041003/i.test(error.message)) {
            return failure("permission_denied", "windows_access_denied", "Windows 拒绝了该项只读检测。请检查当前用户权限或系统策略。");
        }
        const status = error.kind === "unavailable" ? "unsupported" : "error";
        const messages = {
            unavailable: error.message,
            timeout: "Windows 检测命令执行超时。",
            failed: "Windows 检测命令执行失败。",
            invalid_json: "Windows 检测返回了无法解析的数据。",
            too_large: "Windows 检测结果超过大小限制。",
        };
        return failure(status, `powershell_${error.kind}`, messages[error.kind]);
    }
    return failure("error", "unexpected_error", "设备检测发生了未预期错误。请稍后重试。");
}
export async function deviceGetInfo() {
    try {
        const data = await runPowerShellJson(String.raw `
$computer = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$cpus = @(Get-CimInstance Win32_Processor | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name.Trim()
    cores = [int]$_.NumberOfCores
    logical_processors = [int]$_.NumberOfLogicalProcessors
  }
})
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [pscustomobject]@{ name = $_.Name }
})
$disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object {
  [pscustomobject]@{
    model = $_.Model
    size_bytes = if ($null -eq $_.Size) { $null } else { [int64]$_.Size }
    media_type = $_.MediaType
    interface_type = $_.InterfaceType
  }
})
$typeMap = @{ 1 = 'desktop'; 2 = 'mobile'; 3 = 'workstation'; 4 = 'enterprise_server'; 5 = 'soho_server'; 7 = 'performance_server'; 8 = 'maximum' }
$deviceType = $typeMap[[int]$computer.PCSystemType]
if (-not $deviceType) { $deviceType = 'unknown' }
[pscustomobject]@{
  manufacturer = $computer.Manufacturer
  model = $computer.Model
  device_type = $deviceType
  os = [pscustomobject]@{
    caption = $os.Caption
    version = $os.Version
    build_number = $os.BuildNumber
    architecture = $os.OSArchitecture
  }
  cpu = $cpus
  gpu = $gpus
  memory_gb = [math]::Round(([double]$computer.TotalPhysicalMemory / 1GB), 2)
  storage_devices = $disks
  source = 'Windows CIM'
}`, { timeoutMs: 45_000 });
        return success(data);
    }
    catch (error) {
        return executionFailure(error);
    }
}
export async function performanceGetStatus() {
    try {
        const data = await runPowerShellJson(String.raw `
$os = Get-CimInstance Win32_OperatingSystem
$processors = @(Get-CimInstance Win32_Processor)
$cpuValues = @($processors | Where-Object { $null -ne $_.LoadPercentage } | ForEach-Object { [double]$_.LoadPercentage })
$cpuAverage = if ($cpuValues.Count -gt 0) { [math]::Round((($cpuValues | Measure-Object -Average).Average), 1) } else { $null }
$totalKb = [double]$os.TotalVisibleMemorySize
$freeKb = [double]$os.FreePhysicalMemory
$usedPercent = if ($totalKb -gt 0) { [math]::Round((($totalKb - $freeKb) / $totalKb) * 100, 1) } else { $null }
[pscustomobject]@{
  cpu_usage_percent = $cpuAverage
  memory_usage_percent = $usedPercent
  memory_available_gb = [math]::Round(($freeKb / 1MB), 2)
  uptime_seconds = [int64](((Get-Date) - $os.LastBootUpTime).TotalSeconds)
  logical_processor_count = [int]($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
  sample_kind = 'point_in_time'
  source = 'Windows CIM'
}`);
        return success(data, ["这是当前时点快照，不能单独证明资源长期高占用。"]);
    }
    catch (error) {
        return executionFailure(error);
    }
}
export async function processList(sortBy, limit) {
    try {
        const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
        const sortProperty = sortBy === "cpu" ? "cpu_percent" : "working_set_mb";
        const data = await runPowerShellJson(String.raw `
$logical = [math]::Max(1, [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors)
$rows = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
  Where-Object { $_.IDProcess -gt 0 -and $_.Name -notin @('_Total', 'Idle') } |
  ForEach-Object {
    [pscustomobject]@{
      name = $_.Name
      pid = [int]$_.IDProcess
      cpu_percent = [math]::Round(([double]$_.PercentProcessorTime / $logical), 1)
      working_set_mb = [math]::Round(([double]$_.WorkingSetPrivate / 1MB), 1)
    }
  } |
  Sort-Object -Property '${sortProperty}' -Descending |
  Select-Object -First ${safeLimit})
[pscustomobject]@{
  sort_by = '${sortBy}'
  limit = ${safeLimit}
  processes = $rows
  cpu_metric = 'approximate share of total logical CPU capacity'
  source = 'Windows performance counters'
}`, { timeoutMs: 20_000 });
        return success(data, ["进程 CPU 是采样值；短时进程可能在采集期间启动或退出。"]);
    }
    catch (error) {
        return executionFailure(error);
    }
}
export async function storageGetStatus() {
    try {
        const data = await runPowerShellJson(String.raw `
$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' | ForEach-Object {
  $total = if ($null -eq $_.Size) { $null } else { [int64]$_.Size }
  $free = if ($null -eq $_.FreeSpace) { $null } else { [int64]$_.FreeSpace }
  [pscustomobject]@{
    volume = $_.DeviceID
    label = $_.VolumeName
    filesystem = $_.FileSystem
    total_bytes = $total
    used_bytes = if ($null -eq $total -or $null -eq $free) { $null } else { $total - $free }
    free_bytes = $free
    usage_percent = if ($null -eq $total -or $total -le 0 -or $null -eq $free) { $null } else { [math]::Round((($total - $free) / [double]$total) * 100, 1) }
    drive_type = 'fixed'
  }
})
[pscustomobject]@{ volumes = $volumes; source = 'Windows CIM' }
`);
        return success(data);
    }
    catch (error) {
        return executionFailure(error);
    }
}
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
export async function appList(query, limit) {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2 || normalizedQuery.length > 100) {
        return failure("error", "invalid_query", "query 长度必须为 2 到 100 个字符。", ["不允许无关键词枚举全部软件。"]);
    }
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    try {
        const data = await runPowerShellJson(String.raw `
$query = $env:XBB_APP_QUERY
$paths = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$apps = @(Get-ItemProperty $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and $_.DisplayName.IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
  Sort-Object DisplayName, DisplayVersion -Unique |
  Select-Object -First ${safeLimit} |
  ForEach-Object {
    [pscustomobject]@{ name = $_.DisplayName; version = $_.DisplayVersion; publisher = $_.Publisher }
  })
[pscustomobject]@{ query = $query; limit = ${safeLimit}; apps = $apps; source = 'Windows uninstall registry' }
`, { env: { XBB_APP_QUERY: normalizedQuery } });
        return success(data, ["结果来自卸载注册表；免安装程序和部分商店应用可能不会出现。"]);
    }
    catch (error) {
        return executionFailure(error);
    }
}
//# sourceMappingURL=device-tools.js.map
