# 平台数据源说明

> **非必读。** 字段可疑、数值缺失、要向用户解释数据来源时再查。SKILL.md 已经写了最常遇到的两条
> （Windows 上 `device_mtm` 与 `design_cycle_count` 永远为空），不需要为此来读这份。

## macOS

### 数据来源

| 来源 | 取到什么 |
|---|---|
| `ioreg -rn AppleSmartBattery -a` | 电量计原始寄存器：设计容量、满充容量、循环次数、电压、温度、寿命统计、故障标志 |
| `system_profiler -xml SPPowerDataType` | 系统对外口径的健康度、状态、电池型号、适配器信息 |
| `system_profiler -xml SPHardwareDataType` | 机型、型号标识、Model Number、序列号、芯片 |
| `pmset -g rawbatt` / `-g batt` | 实时充放电状态，交叉验证用 |

采集脚本刻意只用这四样，不依赖 Python、Homebrew 或任何第三方工具——脚本要能直接扔到客户机器上跑。

### 已知的坑

- `plutil` 取不到 key 时把错误文本打到 stdout，退出码也不总是非零；脚本的 `_x()` 会过滤 `Could not extract`，别改回只看退出码。
- `SPPowerDataType` 的 `_items` 分段顺序不固定，脚本对前 6 段逐个探测，不要改回写死下标。
- Intel Mac 的 `MaxCapacity` 是满充容量（mAh），Apple Silicon 上恒为 100（百分比刻度）；脚本按数量级判断（> 1000 视为 mAh）。
- 系统口径健康度普遍低于 `满充/设计`，M 系列尤其明显，不是 bug；判读见 `interpretation-rules.md` 第一节。
- **macOS 没有原生历史容量记录**，脚本用 `~/.battery-health-check/history.tsv` 自建，每天最多一条。首次运行只有一个点，
  趋势图和 `trend_mode=single_point_projection` 会明确标注"推算"。
- `DesignCycleCount9C` 部分机型取不到，脚本按 1000 填并输出 `design_cycle_count_source=assumed`。
- 台式机 / 电池被拆时 `ioreg` 返回空，脚本以退出码 2 退出。

### "官方完整电池报告"是什么

macOS 没有 `powercfg /batteryreport` 那种一键报告。`battery-report-macos.txt` 是系统原生命令的**完整原始输出**拼在一起，
没有加工。对客户说"这是系统自带工具导出的原始数据"，**不要说成"Apple 官方电池报告"**。

## Windows

### 数据来源

| 来源 | 取到什么 |
|---|---|
| `powercfg /batteryreport /output x.html` | **官方完整电池报告**，浏览器可直接打开 |
| `powercfg /batteryreport /output x.xml /xml` | 同一份报告的机器可读版本，含数周~数月的真实容量历史 |
| `root\WMI` 的 `BatteryStaticData` / `BatteryFullChargedCapacity` / `BatteryCycleCount` | 设计容量、满充容量、循环次数 |
| `Win32_ComputerSystem` / `Win32_ComputerSystemProduct` / `Win32_BIOS` | 厂商、机型、MTM、序列号 |

`powercfg` 自带真实容量历史，趋势图直接走日期轴实测曲线（`trend_mode=history_date`），这是 Windows 相对 macOS 的主要优势，报告可以点出来。

### 关键字段差异

- **容量单位是 mWh，不是 mAh。** 字段名仍叫 `*_mah`，以 `capacity_unit` 为准；跨平台只能比百分比。
- **`design_cycle_count` 取不到**（powercfg 和 WMI 都不暴露），脚本留空并输出 `design_cycle_count_source=assumed`，判读按 1000 次，报告必须写明是假设。
- **`CycleCount` 经常是 0**（固件不上报），脚本的 `First-Value` 会把 `'0'` 当空值跳过，表现为"循环次数未提供"——0 和"没有"在这里是同一件事。
- **温度、永久故障标志、电芯断连计数在 Windows 上取不到**，这些异常信号只在 macOS 可用。报告里不提即可，不要写"未见异常"。
- **`Win32_ComputerSystemProduct.Name` 不一定是完整 MTM。** ThinkPad 上常是完整 10 位（`21HMA00WCD`），
  消费线（Yoga / 小新 / 拯救者）只有 4 位机型代码（实测 Yoga Pro 14s ARH7 返回 `82TL`，完整 MTM 是 `82TL007KCD`）。
  完整 MTM 在本机任何 WMI 类里都取不到，脚本只输出能确定的：

  | 字段 | 来源 |
  |---|---|
  | `device_machine_type` | `csp.Name` 前 4 位，兜底从 `SystemSKUNumber` 的 `_MT_xxxx_` 刨 |
  | `device_mtm` | 仅当 `csp.Name` 本身就是完整 MTM 时才有值，否则留空 |
  | `device_model` | `csp.Version`，兜底 `cs.SystemFamily` |
  | `device_serial` | `Win32_BIOS.SerialNumber`，兜底 `csp.IdentifyingNumber` / 主板 |

  **`device_mtm` 留空时不要用机型代码顶替。** 完整 MTM 靠主机编号在线换：`quote`/`warranty` 返回的 `machine.mtm`。
- **主机编号（`device_serial`）是服务链路的真正主键。** 脚本会过滤 `Default string`、`To be filled by O.E.M.` 这类 SMBIOS 占位符——
  发到联想接口只会查无此机。

### 运行时的坑

- **`python3` 在 Windows 上通常是应用商店别名**，看似存在、执行即失败（exit 49）；`python` 或 `py -3` 才能用。
  `-Render` 会按 `py -3` → `python` → `python3` 探测，别再手动只试 `python3`。
- 从 Node 的 `execFile` 启动 PowerShell 必须加 `-InputFormat None`，否则 PowerShell 5.1 会一直等 stdin 关闭，表现成"采集超时"。
- 中文 Windows 下 `Out-File -Encoding utf8` 写出带 BOM 的文件，`render_trend.py` 用 `utf-8-sig` 读取，兼容。
- **宿主 shell 里的 `node` 可能不是机器上最新的 Node。** 服务入口要求 Node 22+，`service.mjs` 发现当前 Node 太旧会自己在
  固定安装位置找一个够新的重新执行；找不到才报 `NODE_TOO_OLD`。不要自己去判断版本，详见 `standalone-service.md`。

## 维护记录（agent 可跳过）

- 2026-09-11 Windows 11 + PowerShell 5.1（Yoga Pro 14s ARH7）：`HistoryEntry` 层级匹配正确，`history_points=65`；
  若换机型后 `history_points=0` 而 HTML 报告里有容量历史表，就是 `local-name()` 没匹配上。
  `BatteryStaticData` 普通用户权限可读（取到 `L21D4PE0`），别的机型仍可能要管理员权限。
- 2026-09-14 同机：`-Render` 一步产出指标 + 趋势图 + 判读字段，`assessment.env` 与图上推算线口径一致。
