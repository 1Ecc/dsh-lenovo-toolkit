/**
 * 能力域：性能与进程。对应 skill `performance-diagnosis`。
 *
 * 两个工具都返回**时点快照**，这一点在 warnings 里显式说出来是刻意的：
 * 卡顿投诉里最常见的误判就是拿一次采样当成「长期高占用」的证据。
 */
import { runPowerShellJson } from '../../shared/powershell.js'
import { success } from '../../shared/result.js'
import { executionFailure } from '../../shared/windows-failure.js'

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
