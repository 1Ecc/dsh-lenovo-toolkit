<#
电池健康度采集器 —— Windows

设计目标：零第三方依赖。只用系统自带的 powercfg + CIM/WMI，这样在客户机器上不需要装任何东西。

用法：
  powershell -NoProfile -ExecutionPolicy Bypass -File collect_windows.ps1 [-OutDir <目录>]

产出：
  <OutDir>\metrics.env                  KEY=VALUE 指标（同时打印到 stdout）
  <OutDir>\battery-report.html          官方完整电池报告（powercfg /batteryreport，浏览器可打开）
  <OutDir>\battery-report.xml           同一份报告的机器可读版本
  <OutDir>\history.tsv                  容量历史（直接来自 powercfg，Windows 自带数周~数月的真实记录）
  <OutDir>\raw\                         原始数据

退出码：0 成功；2 未检测到电池；3 非 Windows

注意：powercfg 的容量单位是 mWh（macOS 侧是 mAh），metrics 里用 capacity_unit 字段标明，
不要跨平台直接比较绝对数值。
#>

[CmdletBinding()]
param(
    [string]$OutDir = ""
)

$ErrorActionPreference = 'Continue'

if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
    Write-Error "本脚本仅适用于 Windows"
    exit 3
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $env:USERPROFILE ("Documents\battery-health-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$RawDir = Join-Path $OutDir 'raw'
New-Item -ItemType Directory -Force -Path $RawDir | Out-Null

$HistDir = Join-Path $env:USERPROFILE '.battery-health-check'
New-Item -ItemType Directory -Force -Path $HistDir | Out-Null

# ---------- 官方电池报告 ----------
$ReportHtml = Join-Path $OutDir 'battery-report.html'
$ReportXml  = Join-Path $OutDir 'battery-report.xml'
& powercfg.exe /batteryreport /output "$ReportHtml"          2>&1 | Out-File (Join-Path $RawDir 'powercfg_html.log') -Encoding utf8
& powercfg.exe /batteryreport /output "$ReportXml" /xml      2>&1 | Out-File (Join-Path $RawDir 'powercfg_xml.log')  -Encoding utf8

# ---------- CIM/WMI ----------
function Get-CimSafe {
    param([string]$Class, [string]$Namespace = 'root\CIMV2')
    try { Get-CimInstance -Namespace $Namespace -ClassName $Class -ErrorAction Stop } catch { $null }
}

$cs       = Get-CimSafe 'Win32_ComputerSystem'        | Select-Object -First 1
$csp      = Get-CimSafe 'Win32_ComputerSystemProduct' | Select-Object -First 1
$bios     = Get-CimSafe 'Win32_BIOS'                  | Select-Object -First 1
$board    = Get-CimSafe 'Win32_BaseBoard'             | Select-Object -First 1
$os       = Get-CimSafe 'Win32_OperatingSystem'       | Select-Object -First 1
$batt     = Get-CimSafe 'Win32_Battery'               | Select-Object -First 1
$static   = Get-CimSafe 'BatteryStaticData'           -Namespace 'root\WMI' | Select-Object -First 1
$fullChg  = Get-CimSafe 'BatteryFullChargedCapacity'  -Namespace 'root\WMI' | Select-Object -First 1
$cycle    = Get-CimSafe 'BatteryCycleCount'           -Namespace 'root\WMI' | Select-Object -First 1
$status   = Get-CimSafe 'BatteryStatus'               -Namespace 'root\WMI' | Select-Object -First 1

# 落一份原始 CIM 数据，便于后续复核。
# Windows PowerShell 5.1 解析数组中的连续哈希表时需要显式语句分隔符；先保存数组并用分号分隔。
$cimPairs = @(
    @{n='Win32_ComputerSystem';        o=$cs};
    @{n='Win32_ComputerSystemProduct'; o=$csp};
    @{n='Win32_BIOS';                  o=$bios};
    @{n='Win32_BaseBoard';             o=$board};
    @{n='Win32_Battery';               o=$batt};
    @{n='BatteryStaticData';           o=$static};
    @{n='BatteryFullChargedCapacity';  o=$fullChg};
    @{n='BatteryCycleCount';           o=$cycle};
    @{n='BatteryStatus';               o=$status}
)
foreach ($pair in $cimPairs) {
    if ($pair.o) { $pair.o | Format-List * | Out-File (Join-Path $RawDir ($pair.n + '.txt')) -Encoding utf8 }
}

# ---------- 解析 powercfg XML ----------
# powercfg 的 XML 带默认命名空间，所以一律用 local-name() 匹配，避免命名空间前缀的坑。
$xmlDesign = $null; $xmlFull = $null; $xmlCycles = $null
$xmlSerial = $null; $xmlManufacturer = $null; $xmlChemistry = $null; $xmlBattId = $null
$historyRows = @()

if (Test-Path $ReportXml) {
    try {
        [xml]$rx = Get-Content -Raw -Path $ReportXml
        Copy-Item $ReportXml (Join-Path $RawDir 'battery-report.xml') -Force -ErrorAction SilentlyContinue

        function Node-Text {
            param($parent, [string]$name)
            if (-not $parent) { return $null }
            # 同名的属性和子元素都可能出现，两种都试
            $attr = $parent.SelectSingleNode("@*[local-name()='$name']")
            if ($attr -and -not [string]::IsNullOrWhiteSpace($attr.Value)) { return $attr.Value }
            $el = $parent.SelectSingleNode("*[local-name()='$name']")
            if ($el -and -not [string]::IsNullOrWhiteSpace($el.InnerText)) { return $el.InnerText }
            return $null
        }

        $battNode = $rx.SelectSingleNode("//*[local-name()='Battery']")
        if ($battNode) {
            $xmlDesign       = Node-Text $battNode 'DesignCapacity'
            $xmlFull         = Node-Text $battNode 'FullChargeCapacity'
            $xmlCycles       = Node-Text $battNode 'CycleCount'
            $xmlSerial       = Node-Text $battNode 'SerialNumber'
            $xmlManufacturer = Node-Text $battNode 'Manufacturer'
            $xmlChemistry    = Node-Text $battNode 'Chemistry'
            $xmlBattId       = Node-Text $battNode 'Id'
        }

        # 容量历史：Windows 自带的真实历史记录，是这个平台相对 macOS 最大的优势
        foreach ($h in $rx.SelectNodes("//*[local-name()='HistoryEntry']")) {
            $start = Node-Text $h 'StartDate'
            $end   = Node-Text $h 'EndDate'
            $d     = Node-Text $h 'DesignCapacity'
            $f     = Node-Text $h 'FullChargeCapacity'
            if (-not $d -or -not $f) {
                # 有些版本把容量包在 <EnergyDrain> / <FullChargeCapacity> 子节点里，再往下找一层
                $sub = $h.SelectSingleNode("*[local-name()='FullChargeCapacity']")
                if ($sub) { $f = if ($sub.InnerText) { $sub.InnerText } else { $sub.GetAttribute('Full') } }
                $subd = $h.SelectSingleNode("*[local-name()='DesignCapacity']")
                if ($subd) { $d = if ($subd.InnerText) { $subd.InnerText } else { $subd.GetAttribute('Design') } }
            }
            if ($d -and $f -and ([double]$d) -gt 0) {
                $historyRows += [pscustomobject]@{
                    date       = if ($end) { ($end -split 'T')[0] } else { ($start -split 'T')[0] }
                    cycles     = ''
                    fcc        = [int]$f
                    design     = [int]$d
                    health_os  = [math]::Round(([double]$f) * 100 / ([double]$d), 1)
                    health_raw = [math]::Round(([double]$f) * 100 / ([double]$d), 1)
                }
            }
        }
    } catch {
        Write-Warning "解析 powercfg XML 失败: $_"
    }
}

# ---------- 汇总取值：XML 优先，WMI 兜底 ----------
function First-Value { foreach ($v in $args) { if ($v -ne $null -and "$v".Trim() -ne '' -and "$v" -ne '0') { return $v } } return $null }

<#
设备标识的取值。

这里踩过的坑：**`Win32_ComputerSystemProduct.Name` 不一定是完整 MTM。**
在 ThinkPad 上它常是完整 10 位（`21HMA00WCD`），但在消费线（Yoga / 小新 / 拯救者）上
只有 4 位机型代码（实测 Yoga Pro 14s ARH7 返回 `82TL`，完整 MTM 其实是 `82TL007KCD`）。
把 4 位的机型代码当 MTM 报给客户，或拿去查备件/保修，都会对不上。

完整 MTM 在本机任何 WMI 类里都取不到（Name/Model/SystemSKUNumber/BaseBoard 全试过），
**只能靠主机编号去联想在线接口换**（battery_warranty_lookup 返回的 machine.mtm）。
所以这里只输出能确定的东西：
  device_machine_type  4 位机型代码，一定有
  device_mtm           完整 MTM，本地取不到时留空——留空比填一个半截的值安全
#>
function Clean-Id {
    param([string]$v)
    if ([string]::IsNullOrWhiteSpace($v)) { return '' }
    $t = $v.Trim()
    # OEM 没把值烧进 SMBIOS 时 BIOS 会返回这些占位符。它们看起来像数据，其实不是，
    # 一旦当成主机编号发到联想接口就会查无此机，还会让用户以为是自己抄错了。
    if ($t -match '^(Default string|To be filled by O\.E\.M\.|System Serial Number|Serial Number|Not Applicable|Not Specified|None|N/A|Unknown|0+|\.+)$') { return '' }
    return $t
}

$deviceSerial = First-Value (Clean-Id $bios.SerialNumber) (Clean-Id $csp.IdentifyingNumber) (Clean-Id $board.SerialNumber)
if (-not $deviceSerial) { $deviceSerial = '' }

$cspName = Clean-Id $csp.Name
$machineType = ''
$mtm = ''
if ($cspName -match '^[0-9A-Za-z]{7,}$') {
    # 完整 MTM：前 4 位就是机型代码
    $mtm = $cspName
    $machineType = $cspName.Substring(0, 4)
} elseif ($cspName -match '^[0-9A-Za-z]{4}$') {
    $machineType = $cspName
}
if (-not $machineType) {
    $m = Clean-Id $cs.Model
    if ($m -match '^[0-9A-Za-z]{4}$') { $machineType = $m }
}
# SystemSKUNumber 形如 LENOVO_MT_82TL_BU_idea_FM_Yoga Pro 14s ARH7，兜底能再刨出机型代码
if (-not $machineType -and "$($cs.SystemSKUNumber)" -match '_MT_([0-9A-Za-z]+)') { $machineType = $Matches[1] }

$designCap = First-Value $xmlDesign $static.DesignedCapacity $batt.DesignVoltage
if ($static -and $static.DesignedCapacity) { $designCap = First-Value $xmlDesign $static.DesignedCapacity }
$fullCap   = First-Value $xmlFull $fullChg.FullChargedCapacity
$cycleCnt  = First-Value $xmlCycles $cycle.CycleCount
$battSerial = First-Value $xmlSerial $static.SerialNumber $batt.DeviceID
$battMfr    = First-Value $xmlManufacturer $static.ManufactureName
$battModel  = First-Value $static.DeviceName $batt.Name $xmlBattId
$chemistry  = First-Value $xmlChemistry $static.Chemistry

$healthPct = $null
if ($designCap -and $fullCap -and ([double]$designCap) -gt 0) {
    $healthPct = [math]::Round(([double]$fullCap) * 100 / ([double]$designCap), 1)
}

if (-not $designCap -and -not $fullCap) {
    Write-Error "未检测到电池（台式机、电池已拆除，或驱动未暴露电池信息）"
    exit 2
}

# ---------- 历史 ----------
$HistFile = Join-Path $OutDir 'history.tsv'
"date`tcycles`tfcc_mah`tdesign_mah`thealth_os`thealth_raw`tbattery_serial" | Out-File $HistFile -Encoding utf8
foreach ($r in ($historyRows | Sort-Object date)) {
    "$($r.date)`t$($r.cycles)`t$($r.fcc)`t$($r.design)`t$($r.health_os)`t$($r.health_raw)`t$battSerial" |
        Out-File $HistFile -Append -Encoding utf8
}
# 把本次快照也追加进去（powercfg 的历史按周聚合，最新一次读数不一定已经进表）
$today = Get-Date -Format 'yyyy-MM-dd'
"$today`t$cycleCnt`t$fullCap`t$designCap`t$healthPct`t$healthPct`t$battSerial" |
    Out-File $HistFile -Append -Encoding utf8
Copy-Item $HistFile (Join-Path $HistDir 'history.tsv') -Force -ErrorAction SilentlyContinue

# ---------- 输出指标 ----------
$lines = @(
    "schema_version=1"
    "collected_at=$(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')"
    "platform=windows"
    "capacity_unit=mWh"
    "os_version=$($os.Caption) $($os.Version) (Build $($os.BuildNumber))"
    "device_vendor=$($cs.Manufacturer)"
    "device_model=$(First-Value $csp.Version $cs.SystemFamily)"
    "device_model_identifier=$($cs.Model)"
    "device_model_number=$($csp.Name)"
    "device_machine_type=$machineType"
    "device_mtm=$mtm"
    "device_sku=$($cs.SystemSKUNumber)"
    "device_board_product=$($board.Product)"
    "device_bios_version=$($bios.SMBIOSBIOSVersion)"
    "device_serial=$deviceSerial"
    "device_chip=$((Get-CimSafe 'Win32_Processor' | Select-Object -First 1).Name)"
    "battery_model=$battModel"
    "battery_serial=$battSerial"
    "battery_manufacturer=$battMfr"
    "battery_chemistry=$chemistry"
    "design_capacity_mah=$designCap"
    "full_charge_capacity_mah=$fullCap"
    "health_pct_os=$healthPct"
    "health_pct_raw=$healthPct"
    "cycle_count=$cycleCnt"
    "design_cycle_count="
    "condition=$($batt.Status)"
    "state_of_charge_pct=$($batt.EstimatedChargeRemaining)"
    "voltage_mv=$($batt.DesignVoltage)"
    "official_report=$ReportHtml"
    "official_report_xml=$ReportXml"
    "history_file=$HistFile"
    "history_points=$($historyRows.Count)"
    "raw_dir=$RawDir"
    "outdir=$OutDir"
)
$metricsPath = Join-Path $OutDir 'metrics.env'
$lines | Out-File $metricsPath -Encoding utf8
$lines | ForEach-Object { Write-Output $_ }

exit 0
