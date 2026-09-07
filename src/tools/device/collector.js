/**
 * 能力域：设备概况。对应 skill `device-overview`。
 *
 * 只回答「这台机器是什么」——厂商、型号、系统、CPU、GPU、内存、物理盘。
 * 刻意不读序列号：型号足以支撑服务推荐，序列号只会把这份报告变成敏感数据。
 */
import { runPowerShellJson } from '../../shared/powershell.js'
import { success } from '../../shared/result.js'
import { executionFailure } from '../../shared/windows-failure.js'

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
