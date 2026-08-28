# 平台数据源说明

## macOS

### 数据来源

| 来源 | 取到什么 |
|---|---|
| `ioreg -rn AppleSmartBattery -a` | 电量计原始寄存器：设计容量、满充容量、循环次数、电压、温度、寿命统计 |
| `system_profiler -xml SPPowerDataType` | 系统对外口径的健康度、状态、电池型号、适配器信息 |
| `system_profiler -xml SPHardwareDataType` | 机型、型号标识、Model Number、序列号、芯片 |
| `pmset -g rawbatt` / `-g batt` | 实时充放电状态，交叉验证用 |

采集脚本刻意只用这四样，**不依赖 Python、Homebrew 或任何第三方工具**——脚本要能直接扔到
客户机器上跑，多一个依赖就多一次失败。取值全部通过 `plutil -extract` 完成。

### 已知的坑

- **`plutil` 取不到 key 时会把错误文本打到 stdout**，不是 stderr，退出码也不总是非零。
  所以不能只判断退出码，必须过滤掉含 `Could not extract` 的返回值，
  否则报告里会出现一整行错误信息冒充字段值。脚本里的 `_x()` 就是干这个的。
- **`SPPowerDataType` 的 `_items` 分段顺序不固定**。电池信息、电源设置、适配器信息分属不同段，
  段的数量和顺序随机型、随是否插电变化。所以脚本对前 6 段逐个探测取第一个非空值，
  不要改回写死下标。
- **Intel Mac 与 Apple Silicon 的 `MaxCapacity` 含义不同**：Intel 上它就是满充容量（mAh），
  Apple Silicon 上恒为 100（百分比刻度）。脚本按数量级判断（> 1000 视为 mAh），
  这比判断芯片型号更耐用。
- **系统口径健康度普遍低于 `满充/设计`**，在 M 系列上尤其明显。这不是 bug，
  处理方式见 `interpretation.md` 第一节。
- **macOS 没有原生的历史容量记录**。这是相对 Windows 最大的短板。脚本用
  `~/.battery-health-check/history.tsv` 自建历史，每天最多记一条。
  首次运行只有一个点，趋势图会明确标注「模型推算而非历史实测」。
- 台式机 / 电池被拆除时 `ioreg` 返回空，脚本以退出码 2 提前退出。

### "官方完整电池报告"是什么

macOS 没有 `powercfg /batteryreport` 这种一键生成的官方报告。脚本产出的
`battery-report-macos.txt` 是把系统原生命令的**完整原始输出**拼在一起（system_profiler 全量 +
pmset + 关键寄存器摘要），没有做任何加工或筛选。对客户可以说"这是系统自带工具导出的原始数据"，
不要说成"Apple 官方电池报告"——Apple 并不提供这样一份东西。

---

## Windows

### 数据来源

| 来源 | 取到什么 |
|---|---|
| `powercfg /batteryreport /output x.html` | **官方完整电池报告**，浏览器可直接打开 |
| `powercfg /batteryreport /output x.xml /xml` | 同一份报告的机器可读版本，含容量历史 |
| `root\WMI` 的 `BatteryStaticData` / `BatteryFullChargedCapacity` / `BatteryCycleCount` | 设计容量、满充容量、循环次数 |
| `Win32_ComputerSystem` / `Win32_ComputerSystemProduct` / `Win32_BIOS` | 厂商、机型、MTM、序列号 |

### 相对 macOS 的优势

`powercfg` 报告自带**数周到数月的真实容量历史**，趋势图因此可以直接走日期轴画实测曲线，
不需要靠模型推算。这是 Windows 侧的主要卖点，写报告时可以点出来。

### 关键字段差异

- **容量单位是 mWh，不是 mAh。** `metrics.env` 里用 `capacity_unit` 字段标明。
  跨平台对比绝对数值没有意义，只能比百分比。
- **`design_cycle_count` 取不到。** powercfg 和 WMI 都不暴露设计循环次数。
  脚本留空，判读时按 1000 次做参考基准，**必须在报告里写明这是假设值**。
- **`CycleCount` 经常是 0。** 不少厂商的电池固件不上报循环次数。为 0 或空时就别提循环次数，
  用容量和衰减速率说话即可。
- **联想机型的 MTM** 在 `Win32_ComputerSystemProduct.Name`（形如 `21HMA00WCD`），
  友好机型名在 `.Version`（形如 `ThinkPad X1 Carbon Gen 11`）。
  MTM 是查保修和备件价格的关键，报告里要带上。

### 尚未实机验证的部分

Windows 采集脚本在 macOS 上无法运行，目前**未经实机测试**。首次在 Windows 上跑时重点核对：

1. `powercfg /batteryreport /xml` 的 XML 结构 —— 脚本用 `local-name()` 做命名空间无关匹配，
   并且对「属性」和「子元素」两种写法都做了兼容，但 `HistoryEntry` 下容量字段的实际层级
   需要打开生成的 XML 确认一遍。若 `history_points=0` 而 HTML 报告里明明有容量历史表，
   就是这里没匹配上。
2. `BatteryStaticData` 在部分机型上需要管理员权限才能读，注意观察是否有 CIM 报错。
3. `First-Value` 把 `'0'` 也当作空值跳过。如果某机型的设计容量真的合法地为 0，
   这个逻辑要调整——但实际不会出现。
4. 中文 Windows 下 `Out-File -Encoding utf8` 在 PowerShell 5.1 会写出带 BOM 的文件，
   `render_trend.py` 已用 `utf-8-sig` 读取，兼容。
