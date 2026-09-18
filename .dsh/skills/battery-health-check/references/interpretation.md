# 判读：把字段翻译成人话

读者是两类人同时在场：一线服务顾问要能照着说，终端用户要能听懂并且信。
每条结论都要能追溯到具体字段，不能凭感觉。

**数字来自 `assessment.env`（采集时 `-Render`/`--render` 一并产出），不要重算。** 公式和阈值在
`interpretation-rules.md`，只在没有判读字段时才需要读它。

## 一、每个字段对应报告里的哪句话

| 字段 | 报告里怎么用 |
|---|---|
| `health_pct_os` / `health_pct_judge` / `health_grade` | 概览表填系统口径；解读按 `health_grade` 定性。`health_diverged=true` 时括号补电量计实测，并解释为什么两个数不一样（平滑算法 / 未校准 / FCC 未刷新），判级用较低者 |
| `cycle_ratio_pct` / `cycle_grade` / `design_cycle_count_assumed` | 解读循环次数时给比值而不是只给绝对数；`assumed=true` 必须写"按 1000 次估算，非本机读出" |
| `decay_multiplier` / `decay_multiplier_grade` / `decay_multiplier_reliable` | 衰减趋势段的核心。`reliable=false`（循环 < 50）时字段为空，只说"循环次数尚少，趋势需更多数据"。有 `decay_multiplier_range` 时给区间 |
| `trend_mode` | 趋势图下方那句话：`history_date` = 真实历史曲线；`history_cycles` = 多次实测按循环轴；`single_point_projection` = 单点推算区间，正文不能只报一个确定数字 |
| `history_span_days` / `health_first` / `health_delta_pp` / `yearly_decay_pp` | 有历史时用"X 个月内从 A% 降到 B%，年化约 N 个百分点"说趋势，比倍率更直观 |
| `eta_80pct` | "按当前速率约 YYYY-MM 触及 80% 更换线"，是置换建议里"什么时候换"的依据；`already_below` 时改说"已在更换线以下" |
| `abnormal_signals` / `hard_fault` | 非空就在解读里**单列一段**，优先级高于健康度分级；`hard_fault=true` 结论落在"硬件异常"而不是"老化" |
| `snapshot_drop_alert` | true 时优先怀疑校准，建议隔一周复测，不要直接说"衰减了" |
| `conclusion_tier` / `conclusion_reasons` | 报告第一行的结论档位；`reasons` 是解读里要点出来的因果 |
| `service_trigger_result` | 第 4 步是否进入服务推荐（结果触发） |

## 二、四档结论各自怎么收尾

- **需要送修检测**：讲清是硬故障不是老化，建议送修检测，不只谈换电池。
- **建议更换电池**：讲清已过 80% 线 / 已到设计寿命，可以谈更换；置换建议写"尽快"。
- **可以开始关注**：讲清"现在还能正常用"，给一个复检时间（2~3 个月）和一个更换计划的时间窗（用 `eta_80pct`），把决策空间留给客户。
- **状态健康**：明确说不需要处理，给两三条保养建议就收尾，不推任何服务。

## 三、措辞要求

- 解读给因果，不复述概览表里的数字。
- 不确定就说不确定：单点推算、循环数少、口径分歧大——给区间和条件。虚假的确定性在服务场景会变成投诉。
- 假设值必须标明是假设（设计循环 1000 次）。
- 平台限制导致取不到的字段（Windows 无温度、无故障标志）就不提，不要写"未见异常"。

## 四、使用建议素材库

按结果挑 2~4 条，**不要一次性全倒给客户**。括号里是挑选依据。

**充电习惯**
- 日常让电量在 20%~80% 波动，避免长期满电或深度放电。（通用）
- 长期插电办公，打开系统或厂商的电池养护：macOS「系统设置 → 电池 → 电池健康 → 优化电池充电」；
  Windows 在联想电脑管家 / Lenovo Vantage 开「养护模式」。（`external_connected=true` 且高电量停留长时优先）

**温度管理**
- 避免在床上、沙发、被褥上长时间使用，堵住进风口会让电池长期高温。（`lifetime_max_temp_c` ≥ 50 必给）
- 定期清理散热口积灰；夏季减少边充边玩大型游戏。（高温 + 游戏本）

**长期存放**
- 超过一个月不用，充到 50% 左右再关机存放。（`total_operating_time_h` 相对购机时长明显偏低）

**校准**
- 系统续航估计跳变大时做一次完整校准：充满 → 用到自动关机 → 静置几小时 → 一次性充满。
  校准修正的是读数，不会让电池"变健康"，要跟客户讲清楚。（`health_diverged=true` 或 `snapshot_drop_alert=true`）

**电源配件**
- 用原装或符合规格的适配器；功率不足会边充边掉电、延长高温时间。（`adapter_watts` 明显低于机型标称）
