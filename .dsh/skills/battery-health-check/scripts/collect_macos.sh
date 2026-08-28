#!/bin/bash
# 电池健康度采集器 —— macOS
#
# 设计目标：零第三方依赖。只用 macOS 自带的 system_profiler / ioreg / plutil / pmset，
# 因为这个脚本要跑在客户机器上，不能假设装了 Python、Homebrew 或任何工具链。
#
# 用法：
#   collect_macos.sh [--outdir <目录>]
#
# 产出：
#   <outdir>/metrics.env                   KEY=VALUE 指标（同时打印到 stdout）
#   <outdir>/battery-report-macos.txt      官方完整电池报告（system_profiler 全量 + 关键寄存器）
#   <outdir>/raw/                          原始数据（plist / 文本），便于复核与二次分析
#   ~/.battery-health-check/history.tsv    历史快照，多次运行后可画出真实衰减曲线
#
# 退出码：0 成功；2 未检测到电池（台式机 / 电池被拔出）；3 非 macOS

set -uo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: 本脚本仅适用于 macOS，当前系统是 $(uname -s)" >&2
  exit 3
fi

OUTDIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --outdir) OUTDIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$OUTDIR" ]; then
  OUTDIR="$HOME/Documents/battery-health-$(date +%Y%m%d-%H%M%S)"
fi
RAW="$OUTDIR/raw"
mkdir -p "$RAW" || { echo "ERROR: 无法创建输出目录 $OUTDIR" >&2; exit 1; }

HIST_DIR="$HOME/.battery-health-check"
HIST="$HIST_DIR/history.tsv"
mkdir -p "$HIST_DIR"

# ---------- 采集原始数据 ----------
ioreg -rn AppleSmartBattery -a               > "$RAW/AppleSmartBattery.plist" 2>/dev/null
system_profiler -xml  SPPowerDataType        > "$RAW/SPPowerDataType.plist"   2>/dev/null
system_profiler -xml  SPHardwareDataType     > "$RAW/SPHardwareDataType.plist" 2>/dev/null
system_profiler -detailLevel full SPPowerDataType > "$RAW/SPPowerDataType.txt" 2>/dev/null
system_profiler SPHardwareDataType           > "$RAW/SPHardwareDataType.txt"  2>/dev/null
pmset -g rawbatt                             > "$RAW/pmset_rawbatt.txt"       2>/dev/null
pmset -g batt                                > "$RAW/pmset_batt.txt"          2>/dev/null

# 没有电池时 ioreg 会返回空 plist，提前退出好过输出一堆空字段
if [ ! -s "$RAW/AppleSmartBattery.plist" ] || ! grep -q "AppleSmartBattery" "$RAW/AppleSmartBattery.plist" 2>/dev/null; then
  echo "ERROR: 未检测到内置电池（台式机、电池已拆除，或系统限制了 ioreg 访问）" >&2
  exit 2
fi

# ---------- 取值辅助函数 ----------
# plutil 取不到 key 时会把错误文本打到 stdout，所以不能只靠退出码，要把错误文本也过滤掉，
# 否则 "Could not extract value..." 会被当成字段值写进报告里。
_x() {
  local v
  v=$(plutil -extract "$2" raw -o - -- "$1" 2>/dev/null | head -1)
  case "$v" in *"Could not extract"*|*"invalid key path"*) v="" ;; esac
  printf '%s' "$v"
}
bat() { _x "$RAW/AppleSmartBattery.plist" "0.$1"; }
hw()  { _x "$RAW/SPHardwareDataType.plist" "0._items.0.$1"; }
# SPPowerDataType 是若干个 _items 段（电池信息 / 电源设置 / 适配器…），段的顺序会随机型和
# 有没有插电而变，所以按下标写死会漏字段。这里对前几段逐个探，取到第一个非空值。
pwr() {
  local i v
  for i in 0 1 2 3 4 5; do
    v=$(_x "$RAW/SPPowerDataType.plist" "0._items.$i.$1")
    if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  done
}

# ---------- 设备信息 ----------
MACHINE_NAME=$(hw machine_name)
MACHINE_MODEL=$(hw machine_model)
MODEL_NUMBER=$(hw model_number)
DEVICE_SERIAL=$(hw serial_number)
CHIP=$(hw chip_type); [ -z "$CHIP" ] && CHIP=$(hw cpu_type)
OS_NAME=$(sw_vers -productName 2>/dev/null)
OS_VER=$(sw_vers -productVersion 2>/dev/null)
OS_BUILD=$(sw_vers -buildVersion 2>/dev/null)

# ---------- 电池信息 ----------
BAT_DEVICE_NAME=$(bat DeviceName)
BAT_SERIAL=$(bat Serial)
BAT_FW=$(pwr sppower_battery_model_info.sppower_battery_firmware_version)
DESIGN_MAH=$(bat DesignCapacity)
RAW_MAX_MAH=$(bat AppleRawMaxCapacity)
NOMINAL_MAH=$(bat NominalChargeCapacity)
MAXCAP_FIELD=$(bat MaxCapacity)
CYCLES=$(bat CycleCount)
DESIGN_CYCLES=$(bat DesignCycleCount9C)
SOC=$(bat CurrentCapacity)
VOLT_MV=$(bat Voltage)
TEMP_RAW=$(bat Temperature)
PERM_FAIL=$(bat PermanentFailureStatus)
CELL_DISCONNECT=$(bat BatteryCellDisconnectCount)
MAX_TEMP_C=$(bat BatteryData.LifetimeData.MaximumTemperature)
MIN_TEMP_C=$(bat BatteryData.LifetimeData.MinimumTemperature)
OPERATING_TIME_MIN=$(bat BatteryData.LifetimeData.TotalOperatingTime)
CHEM_ID=$(bat BatteryData.ChemID)
IS_CHARGING=$(bat IsCharging)
EXTERNAL=$(bat ExternalConnected)
ADAPTER_NAME=$(pwr sppower_ac_charger_name)
ADAPTER_W=$(pwr sppower_ac_charger_watts)

HEALTH_OS_RAW=$(pwr sppower_battery_health_info.sppower_battery_health_maximum_capacity)
HEALTH_OS=$(printf '%s' "$HEALTH_OS_RAW" | tr -dc '0-9.')
CONDITION=$(pwr sppower_battery_health_info.sppower_battery_health)

# Intel Mac 的 MaxCapacity 直接就是满充容量(mAh)；Apple Silicon 上它恒为 100（百分比刻度）。
# 用数量级来判断走哪条路，比判断芯片型号更耐用。
FCC_MAH="$RAW_MAX_MAH"
if [ -n "$MAXCAP_FIELD" ] && [ "$MAXCAP_FIELD" -gt 1000 ] 2>/dev/null; then
  FCC_MAH="$MAXCAP_FIELD"
fi

# 温度：ioreg 单位是 0.01°C
TEMP_C=""
if [ -n "$TEMP_RAW" ]; then
  TEMP_C=$(awk -v t="$TEMP_RAW" 'BEGIN{printf "%.1f", t/100}')
fi

OPERATING_TIME_H=""
if [ -n "$OPERATING_TIME_MIN" ]; then
  OPERATING_TIME_H=$(awk -v m="$OPERATING_TIME_MIN" 'BEGIN{printf "%.0f", m/60}')
fi

# 电量计实测健康度 = 满充容量 / 设计容量
HEALTH_RAW=""
if [ -n "$FCC_MAH" ] && [ -n "$DESIGN_MAH" ] && [ "$DESIGN_MAH" -gt 0 ] 2>/dev/null; then
  HEALTH_RAW=$(awk -v f="$FCC_MAH" -v d="$DESIGN_MAH" 'BEGIN{printf "%.1f", f*100/d}')
fi

[ -z "$DESIGN_CYCLES" ] && DESIGN_CYCLES=1000

# ---------- 官方完整电池报告 ----------
REPORT="$OUTDIR/battery-report-macos.txt"
{
  echo "================================================================"
  echo " macOS 电池报告（系统原生数据，未做任何加工）"
  echo " 生成时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo " 设备: ${MACHINE_NAME} (${MACHINE_MODEL}) / SN ${DEVICE_SERIAL}"
  echo " 系统: ${OS_NAME} ${OS_VER} (${OS_BUILD})"
  echo "================================================================"
  echo
  echo "【1】system_profiler SPPowerDataType -detailLevel full"
  echo "----------------------------------------------------------------"
  cat "$RAW/SPPowerDataType.txt" 2>/dev/null
  echo
  echo "【2】pmset -g rawbatt（电量计实时读数）"
  echo "----------------------------------------------------------------"
  cat "$RAW/pmset_rawbatt.txt" 2>/dev/null
  echo
  echo "【3】pmset -g batt"
  echo "----------------------------------------------------------------"
  cat "$RAW/pmset_batt.txt" 2>/dev/null
  echo
  echo "【4】ioreg AppleSmartBattery 关键寄存器"
  echo "----------------------------------------------------------------"
  printf '%-32s %s\n' \
    "DesignCapacity (mAh)"        "$DESIGN_MAH" \
    "AppleRawMaxCapacity (mAh)"   "$RAW_MAX_MAH" \
    "NominalChargeCapacity (mAh)" "$NOMINAL_MAH" \
    "CycleCount"                  "$CYCLES" \
    "DesignCycleCount9C"          "$DESIGN_CYCLES" \
    "Voltage (mV)"                "$VOLT_MV" \
    "Temperature (C)"             "$TEMP_C" \
    "Lifetime MaxTemperature (C)" "$MAX_TEMP_C" \
    "Lifetime MinTemperature (C)" "$MIN_TEMP_C" \
    "TotalOperatingTime (h)"      "$OPERATING_TIME_H" \
    "PermanentFailureStatus"      "$PERM_FAIL" \
    "BatteryCellDisconnectCount"  "$CELL_DISCONNECT" \
    "ChemID"                      "$CHEM_ID"
  echo
  echo "完整 ioreg 原始 plist 见: raw/AppleSmartBattery.plist"
} > "$REPORT" 2>/dev/null

# ---------- 历史快照 ----------
TODAY=$(date '+%Y-%m-%d')
NOW=$(date '+%Y-%m-%dT%H:%M:%S%z')
if [ ! -f "$HIST" ]; then
  printf 'date\tcycles\tfcc_mah\tdesign_mah\thealth_os\thealth_raw\tbattery_serial\n' > "$HIST"
fi
# 同一天只留一条，避免反复运行把曲线压成一坨点
if ! awk -F'\t' -v d="$TODAY" -v s="$BAT_SERIAL" 'NR>1 && $1==d && $7==s{found=1} END{exit !found}' "$HIST" 2>/dev/null; then
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$TODAY" "$CYCLES" "$FCC_MAH" "$DESIGN_MAH" "$HEALTH_OS" "$HEALTH_RAW" "$BAT_SERIAL" >> "$HIST"
fi
cp "$HIST" "$OUTDIR/history.tsv" 2>/dev/null

# ---------- 输出指标 ----------
METRICS="$OUTDIR/metrics.env"
{
  echo "schema_version=1"
  echo "collected_at=$NOW"
  echo "platform=macos"
  echo "os_version=$OS_NAME $OS_VER ($OS_BUILD)"
  echo "device_vendor=Apple"
  echo "device_model=$MACHINE_NAME"
  echo "device_model_identifier=$MACHINE_MODEL"
  echo "device_model_number=$MODEL_NUMBER"
  echo "device_serial=$DEVICE_SERIAL"
  echo "device_chip=$CHIP"
  echo "battery_model=$BAT_DEVICE_NAME"
  echo "battery_serial=$BAT_SERIAL"
  echo "battery_firmware=$BAT_FW"
  echo "design_capacity_mah=$DESIGN_MAH"
  echo "full_charge_capacity_mah=$FCC_MAH"
  echo "nominal_charge_capacity_mah=$NOMINAL_MAH"
  echo "health_pct_os=$HEALTH_OS"
  echo "health_pct_raw=$HEALTH_RAW"
  echo "cycle_count=$CYCLES"
  echo "design_cycle_count=$DESIGN_CYCLES"
  echo "condition=$CONDITION"
  echo "state_of_charge_pct=$SOC"
  echo "voltage_mv=$VOLT_MV"
  echo "temperature_c=$TEMP_C"
  echo "lifetime_max_temp_c=$MAX_TEMP_C"
  echo "lifetime_min_temp_c=$MIN_TEMP_C"
  echo "total_operating_time_h=$OPERATING_TIME_H"
  echo "permanent_failure_status=$PERM_FAIL"
  echo "cell_disconnect_count=$CELL_DISCONNECT"
  echo "is_charging=$IS_CHARGING"
  echo "external_connected=$EXTERNAL"
  echo "adapter_name=$ADAPTER_NAME"
  echo "adapter_watts=$ADAPTER_W"
  echo "official_report=$REPORT"
  echo "history_file=$HIST"
  echo "raw_dir=$RAW"
  echo "outdir=$OUTDIR"
} | tee "$METRICS"

exit 0
