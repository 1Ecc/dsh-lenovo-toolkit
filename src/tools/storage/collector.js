/**
 * 能力域：存储空间。对应 skill `storage-diagnosis`。
 *
 * 只读固定卷的容量数字，**不扫描用户文件**——扫目录既慢又越界，
 * 而「哪个盘快满了」这个结论根本不需要知道里面装了什么。
 */
import { runPowerShellJson } from '../../shared/powershell.js'
import { success } from '../../shared/result.js'
import { executionFailure } from '../../shared/windows-failure.js'

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
