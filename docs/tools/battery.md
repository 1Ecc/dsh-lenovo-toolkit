# 工具组：电池健康检测

跨平台（macOS / Windows）的笔记本电池体检。面向联想服务团队的一线咨询场景：
输入是一句「帮我看看电池」，输出是一份服务顾问能照着讲、终端用户能看懂并且愿意相信的诊断报告。

对应的 DSH 工具（9 个）：
`battery_health_collect` · `battery_health_trend` · `battery_health_rules` ·
`battery_warranty_lookup` · `battery_part_price_lookup` · `battery_service_stores` ·
`battery_appointment_start` · `battery_appointment_options` · `battery_appointment_submit`
对应的 skill：`.dsh/skills/battery-health-check/`

## 目录

- [交付什么](#交付什么)
- [能力矩阵](#能力矩阵)
- [关键数据口径](#关键数据口径)
- [趋势图设计原则](#趋势图设计原则)
- [推荐策略与服务链路](#推荐策略与服务链路)
- [单独跑脚本](#单独跑脚本)

---

## 交付什么


一次检测产出四份东西：

| 产物 | 形式 | 说明 |
|---|---|---|
| **诊断报告** | Markdown（对话正文） | 健康概览 → 解读 → 小建议 |
| **容量衰减趋势图** | SVG，**在对话里内联渲染**（同时落盘存档） | 自适应明暗主题，实测与推算可视区分。放在「一、电池健康概览」表格下方，不要只丢路径 |
| **官方完整电池报告** | Windows 为 HTML，macOS 为 TXT | 系统原生数据，可存档、可发给服务网点 |
| **服务推荐** | Markdown 独立小节 | **有触发条件，不满足时整节省略**；触发后查保修、报备件价、找门店，并可预约更换或转人工 |

报告结构是固定的，不允许随意调整章节顺序：

```
结论（一句话，含档位）
一、电池健康概览   —— 电脑型号 / 主机编号 / 电池型号 / 设计容量 / 当前充满容量 / 当前健康度 / 循环次数
                     ＋ 内联渲染的容量衰减趋势图
二、解读           —— 健康度 / 循环次数 / 衰减趋势，讲因果不复述数字
三、小建议         —— 使用建议 / 置换建议（技术判断，不放商品链接）
四、附件           —— 趋势图 + 官方报告路径
（五、服务推荐）    —— 仅在触发时出现
```

---

## 能力矩阵


| 能力 | macOS | Windows |
|---|---|---|
| 设备与电池标识（机型、MTM/型号、序列号、电池型号） | ✅ 已验证 | ⏳ 已实现待验证 |
| 设计容量 / 满充容量 / 健康度 / 循环次数 | ✅ | ⏳ |
| 双口径健康度（系统口径 + 电量计实测） | ✅ | 单口径（平台只给一个） |
| 温度与寿命统计（历史最高温、累计运行时长） | ✅ | ➖ 平台不提供 |
| 硬故障标志（永久故障、电芯断连） | ✅ | ➖ 平台不提供 |
| 设计循环次数 | ✅ 系统提供 | ❌ 取不到，按 1000 次假设并在报告中标注 |
| **原生历史容量记录** | ❌ 系统不提供，靠自建快照累积 | ✅ powercfg 自带数周~数月 |
| 官方电池报告 | 系统原生数据汇总（TXT） | `powercfg /batteryreport`（HTML） |
| 第三方依赖 | **零**（system_profiler / ioreg / plutil / pmset） | **零**（powercfg + WMI） |

趋势图渲染需要 `python3`（仅标准库）。没有 python3 时跳过趋势图，报告其余部分照常输出。

---

## 关键数据口径


`metrics.env` 里有**两个健康度**，含义不同，混用是这个任务最容易出的错：

| 字段 | 含义 | 用途 |
|---|---|---|
| `health_pct_os` | 操作系统对外公布的最大容量百分比 | **对客户说话用这个** —— 他自己点开系统设置能看到同样的数字 |
| `health_pct_raw` | 电量计实测：满充容量 ÷ 设计容量 | **判断电芯物理状态用这个** —— 直接来自电池管理芯片 |

两者在 Apple Silicon 上经常差 5~10 个百分点（实测样本：系统 88% vs 电量计 97.9%），
因为 macOS 叠加了循环数、高电量停留时长、温度历史做长期平滑。

处理原则：

- **取较低者作为风险判断依据**（偏保守：把好电池说坏会被投诉，把坏电池说好会被返修）
- **取系统口径作为对客户陈述的数字**
- 差 ≥ 3 个百分点时**必须主动解释**，不解释客户会觉得在糊弄

完整规则见 [`interpretation.md`](../../.dsh/skills/battery-health-check/references/interpretation.md)。

### 机型代码 ≠ MTM（实测推翻的旧假设）

原先假设 `Win32_ComputerSystemProduct.Name` 就是完整 MTM。**在消费线上不成立**：

| | ThinkPad | 消费线（Yoga / 小新 / 拯救者） |
|---|---|---|
| `csp.Name` | `21HMA00WCD`（完整 MTM，10 位） | `82TL`（**只有 4 位机型代码**） |
| 完整 MTM | 本地就有 | **本地任何 WMI 类都取不到**，要拿主机编号联网换 |

实测机 Yoga Pro 14s ARH7：`Name`/`Model`/`SystemSKUNumber`/`Win32_BaseBoard` 全试过，
都只到 `82TL`，而它的完整 MTM 是 `82TL007KCD`——只有 `machine/getmachineinfo` 接口给得出。

所以采集只输出能确定的部分，`device_mtm` 宁可留空也不拿机型代码顶替：

| 字段 | 本例 |
|---|---|
| `device_machine_type` | `82TL` |
| `device_mtm` | 空（查过保修后从 `machine.mtm` 补） |
| `device_serial` | `PS00CC2J` ← **整条服务链路的主键，比 MTM 关键** |
| `device_bios_version` | `JVCN40WW` |

`device_serial` 会过滤 `Default string` / `To be filled by O.E.M.` 这类 SMBIOS 占位符——
它们看着像数据，发到联想接口只会查无此机。`test/tools/battery.test.js` 有守卫钉住这条。

### 结论四档

按顺序判，命中即停：

1. **需要送修检测** —— 命中硬故障信号（永久故障标志、电芯断连、系统判定异常）
2. **建议更换电池** —— 健康度 < 80%，或循环次数达设计寿命 100%
3. **可以开始关注** —— 健康度 80%~85%，或衰减倍率 > 2，或循环次数达设计寿命 80%
4. **状态健康** —— 以上都不命中。**此档不推荐任何更换类服务**

---

## 趋势图设计原则


两条红线，改代码时必须守住：

**1. 实测点和推算线必须肉眼可分**（实心圆点 + 实线 vs 空心 + 虚线）。这张图会同时给服务顾问和
客户看，把模型推算误读成历史实测会直接变成投诉。

**2. 单点外推不给单一确定值。** 两种口径各自外推的结果能差几百次循环（实测样本：125 次 vs 714 次）。
这时画成**推算区间楔形带**而不是一条看着很确定的线——否则一台其实很健康的机器会被画成马上要
换电池，这种图拿去做服务推荐就是自毁信任。

其他行为：

- 横轴自适应：历史点 ≥ 3 且跨度 ≥ 14 天走**日期轴**，否则走**循环次数轴**并叠加厂商规格参考线
- 楔形带在 80% 更换线处收口——过了更换线的外推没有决策价值
- 已跌破 80% 时不播报"预计将会触及"，改为"约在 X 时已越过"
- 图例只列图上实际画出来的元素
- 通过 `prefers-color-scheme` 自适应明暗主题

---

## 推荐策略与服务链路


### 纪律先于服务

推荐环节挂在一份诊断报告后面，而报告的全部价值来自「客户相信这些数字没被动过手脚」。
一旦客户察觉结论是被推荐目标反向凑出来的，他不但不预约，还会连带不信任前面所有数据。

**顺序是硬性的：先出结论，再看结论是否触发推荐。** 三条不可突破：

1. **不为了推荐而修改诊断**
2. **不替联想打包票** —— 在不在保、多少钱、门店收不收，全部来自实时接口，接口没给的就说不知道
3. **推荐必须可见地是推荐** —— 单独成节、标题含「服务推荐」、放在报告最后，
   不允许把预约链接混进「小建议」伪装成技术建议

### 触发条件

```
A 结果触发（建议更换/需送修 · 健康度 < 80% · 循环数达设计寿命）
OR  B 意图触发（用户问换电池/续航/保修，可跨轮生效）        →  走服务主线
都不命中                                                    →  整节省略
```

未触发时不留「如有需要可以…」这类悬着的广告尾巴。

### 服务主线：预约到店/上门更换原厂电池

**不推商品**（2026-09-11 起，试点期的两个商品链接已下线）。触发后按固定顺序走，每步以用户同意为前提：

| 步 | 工具 | 数据来源（均为联想官方接口，免登录） | 备注 |
|---|---|---|---|
| ① 查保修 | `battery_warranty_lookup` | `newsupport.lenovo.com.cn/api/drive/<SN>/drivewarrantyinfo` + `/machine/getmachineinfo` | 单独判定**电池**是否在保：延保条款常写明「不包含电池」；判不了给 `null` |
| ② 查备件价 | `battery_part_price_lookup` | `/api/SmartFault/getSmartFaultPrice?machineNo=<SN>` | 返回原厂标准备件价（不含工时）；「膨胀金」是维修定金，分开讲 |
| ③ 找门店 | `battery_service_stores` | `/api/station/list`（按距离排序）+ IP 定位 | 定位到的城市要让用户确认；境外出口 IP 直接问用户 |
| ④a 预约 | `battery_appointment_start` / `_options` / `_submit` | `csrecommend` + `servicesmall`（**需用户自己登录联想 ID**） | 服务类别=维修服务 · 故障类型=其他 · 故障描述=工具生成（≤100 字） · 时段列给用户选 · 联系人/手机号向用户要 · 复述后提交 · 反馈工单号 |
| ④b 联系人工 | `400-990-8888` | 官方热线 | 当前没有坐席接口；只提供联系方式，不宣称已转接、不生成虚假工单号 |

①② 会把主机编号发到联想，工具要求 `confirmed=true`，模型必须先告知用户。

### 预约的登录态怎么拿

用户在浏览器里自己登录 → 取 `cerpreg-passport` cookie → 工具换两个 token：

```
POST csrecommend/api/shop/login/check {cookie}      → data.key      用户 token
POST csrecommend/api/oauth/token {app_id,secret}    → access_token  页面 token（公开值，非用户凭据）

appoint/machine/*  →  Authorization:  <用户 token>     单数
repair/*           →  Authorizations: <用户 token>  +  Authenticates: <页面 token>   复数
```

单复数写错的症状是返回 3001/3002/3004——看着像 token 过期，其实是头名字不对。

**cookie 和 token 都不进模型上下文**：cookie 只用于换 token，token 存在工具进程内的会话表里，
对外只给一个 30 分钟过期的 `session_id`。提交成功后会话立即丢弃。

三条硬边界写在 skill 里：不代用户登录、不读浏览器 cookie 库、拿不到 cookie 就退回引导用户自己提交。
提交是不可撤回动作，`battery_appointment_submit` 有 `confirmed` 闸门。

完整接口字段、状态码和兜底见
[`service-flow.md`](../../.dsh/skills/battery-health-check/references/service-flow.md)。

### 通用入口

| 用途 | 链接 |
|---|---|
| 保修状态查询 | https://newsupport.lenovo.com.cn/guardeploySearch.html |
| 备件价格查询 | https://newsupport.lenovo.com.cn/pricesearchpc-search.html |
| 服务网点查询 | https://newsupport.lenovo.com.cn/serverNet.html |
| 服务预约 | https://serviceorder.lenovo.com.cn/h5/#/serviceOrderPC/selectService |
| 服务热线 | 400-990-8888 |

---

## 单独跑脚本

不经过 DSH 也能直接跑，便于排查问题。

macOS：

```bash
bash .dsh/skills/battery-health-check/scripts/collect_macos.sh --outdir ./out
python3 .dsh/skills/battery-health-check/scripts/render_trend.py --metrics ./out/metrics.env --out ./out/trend.svg
```

Windows：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .dsh\skills\battery-health-check\scripts\collect_windows.ps1 -OutDir .\out
python3 .dsh\skills\battery-health-check\scripts\render_trend.py --metrics .\out\metrics.env --out .\out\trend.svg
```

## 反复运行会越来越准

每次采集都会往 `~/.battery-health-check/history.tsv` 追加一条快照（每天最多一条）。
macOS 上系统不保存历史容量记录，所以首次检测的趋势只能靠模型推算；攒够 3 个点、
跨度超过两周后，趋势图会自动切换成基于真实历史的日期轴曲线。
