---
name: battery-health-check
description: '检测笔记本电池健康度并生成完整诊断报告，支持 macOS 与 Windows。产出电池健康概览（电脑型号、电池型号、设计容量、当前满充容量、健康度、循环次数）、对健康度与衰减趋势的专业解读、使用与置换建议，并附带一张可用浏览器打开的 SVG 容量衰减趋势图和系统官方电池报告。当用户提到电池、续航、电量、掉电快、充不满、电池健康度、电池老化、循环次数、要不要换电池、电池还能用多久、battery health，或想给笔记本做硬件体检时，都要使用这个 skill——即使用户只是随口说一句"电脑越来越不耐用了""待机时间变短了"也同样适用。'
whenToUse: '用户提到电池、续航、电量、掉电快、充不满、电池健康度、电池老化、循环次数、要不要换电池、电池还能用多久、battery health，或想给笔记本做硬件体检时。随口抱怨「电脑越来越不耐用了」「待机时间变短了」同样适用。'
user-invocable: true
disable-model-invocation: false
---

# 电池健康度检测

一次完整的电池体检，交付四样东西：**一份 Markdown 报告**（回复正文）、**一张容量衰减趋势图**（SVG）、
**一份系统官方电池报告**（原始数据），以及**按触发条件出现的服务推荐**（查保修、报备件价、预约门店或转人工）。

场景是联想服务团队的一线咨询：报告要让顾问照着能讲、让客户听得懂并且相信。
**数据必须真实、口径必须说清、推荐必须克制。**

---

## 第 1 步：采集 + 趋势图 + 判读（一条命令）

**不要自己手敲 ioreg/powercfg 凑数据**，脚本已经处理了平台坑。

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File <skill_dir>\scripts\collect_windows.ps1 -Render
```

```bash
# macOS
bash <skill_dir>/scripts/collect_macos.sh --render
```

stdout 是三段 `KEY=VALUE`：**指标**（`metrics.env`）→ `trend_svg=` 趋势图路径 → **判读字段**（`assessment.env`，
`health_grade`、`cycle_grade`、`decay_multiplier`、`trend_mode`、`eta_80pct`、`abnormal_signals`、`conclusion_tier`、
`service_trigger_result` 等）。记下 `outdir`。

- **退出码 2** = 没检测到电池（台式机 / 电池已拆）。如实告诉用户，到此为止。
- 打印了 `assessment_skipped=python_missing` = 没有 Python。趋势图和判读字段缺失：报告里说明趋势图未生成，
  判读改读 `references/interpretation-rules.md` 手算。**不要手写 SVG**，手写的图和脚本口径对不上。

## 第 2 步：判读

**有判读字段就直接用，不要重算**——那是 `interpretation-rules.md` 的可执行版本，跨 agent 结论一致靠它。
读 `references/interpretation.md`（短）拿到每个档位的含义和措辞要求，然后写解读。

必须注意的两件事：
- `health_pct_os` 与 `health_pct_raw` 是两个口径（`health_diverged=true` 时差 ≥ 3 个百分点）：对客户说系统口径，
  判级用较低者（`health_pct_judge`），并在报告里解释差异。
- `design_cycle_count_assumed=true` 时（Windows 永远如此），报告必须写明"设计循环次数按 1000 次估算，非本机读出"。

## 第 3 步：写报告

严格用这个结构，章节顺序是需求方定的：

```markdown
# 电池健康检测报告

**结论：<一句话，含 conclusion_tier>**

## 一、电池健康概览

| 项目 | 数值 |
|---|---|
| 电脑型号 | |
| 主机编号 | |
| 电池型号 | |
| 设计容量 | |
| 当前充满容量 | |
| 当前健康度 | |
| 循环次数 | |

<在这里内联渲染容量衰减趋势图，并用一句话说明图上画的是实测还是推算（看 trend_mode）>

## 二、解读

**健康度** —— …
**循环次数** —— …
**衰减趋势** —— …

## 三、小建议

**使用建议**
- …

**置换建议**
- …

## 四、附件

- 容量衰减趋势图：<路径>（浏览器可直接打开）
- 官方完整电池报告：<路径>
```

写作要求：

- **概览表如实填写。** 取不到写「系统未提供」，不留空、不拿别的数字顶上。口径不一致时主表填系统口径，括号补电量计实测。
  Windows 上容量单位是 **mWh**（看 `capacity_unit`）。
- **机型那栏别把机型代码写成 MTM。** Windows 消费线（Yoga / 小新 / 拯救者）`device_mtm` 永远为空，只有 4 位机型代码
  （`device_machine_type`，如 `82TL`）。写机型代码并注明"完整 MTM 需联网查"；查过保修后用 `machine.mtm` 补上。
  **主机编号（`device_serial`）是后续所有服务动作的主键，必须列出。**
- **趋势图要在对话里直接渲染**，放在概览表正下方；宿主不支持内联时给绝对路径。文件照写，存档和发门店都用得上。
- **解读给因果，不复述数字。** "循环 140 次、健康度 86.7%"概览已经说过；解读回答"这个组合意味着什么、正常吗、接下来会怎样"。
- **不确定就说不确定。** `decay_multiplier_reliable=false`、`trend_mode=single_point_projection`、`health_diverged=true`
  时给区间和条件，不给假装确定的数字。
- **「置换建议」讲要不要换、什么时候换、换前先做什么**，是技术判断；商品和预约不放这里。

## 第 4 步：服务推荐（有触发条件）

触发条件两类，命中任一：

- **结果触发**：`service_trigger_result=true`（等价于健康度 < 80%、结论为建议更换/需要送修、循环数到寿命）。
- **意图触发**：用户明确表达换电池 / 续航不行 / 问保修 / 问价格 / 问门店的意向，**可跨轮生效**。
  非首轮意图触发不重做检测，直接衔接。

「可以开始关注」档**不触发**，只在置换建议里写下次复检时间。**未触发就整节省略**，报告到「附件」干净收尾，
不留"如有需要可以…"的尾巴。

触发后**不推商品**，走固定主线——建议尽快预约到店/上门更换原厂电池。操作全部按
`references/standalone-service.md`（唯一操作手册）执行，概括是：

1. `node <skill_dir>/scripts/service.mjs quote --sn <device_serial>` → 保修状态 + 原厂备件价；
   `... stores` 自动定位成功则一并拿到最近门店。
2. 按 `references/lenovo-offers.md` 的格式写「服务推荐」节，让用户二选一：**预约门店** / **联系人工 `400-990-8888`**
   （当前没有坐席接口，不能宣称已转接或编造工单号）。
3. 用户选预约后：`stores → login --stationCode → auth → prepare → 用户确认 → submit --draft_id --confirmed → close`。
   每步一条命令，状态自动跨命令保存，没有会话要维护。
   用户本人在专用浏览器登录，agent 永远不代填账号、密码、验证码；复述整单并取得明确确认后才提交。

服务入口需要 **Node 22+**；脚本自己检查，只有报 `NODE_TOO_OLD` 时才把 `message` 里的安装命令交给用户，装完重跑。

非联想设备：保修/备件价查不到是正常的，不要重试；门店可查但受理与否以门店为准，不推预约。

## 第 5 步：交付文件

报告正文直接输出。宿主支持文件发送/渲染时直接交付趋势图和官方报告；不支持时把绝对路径写清楚。

---

## 目录与阅读顺序

```
battery-health-check/
├── SKILL.md                         流程与报告格式（本文件）
├── scripts/
│   ├── collect_windows.ps1          Windows 采集（-Render 一并出图与判读）
│   ├── collect_macos.sh             macOS 采集（--render 同上）
│   ├── render_trend.py              趋势图 + 判读字段（只用标准库）
│   ├── service.mjs                  服务入口：node service.mjs <action> --key value；--stdio 为 JSONL 长驻模式
│   └── service-lib/                 联想接口、浏览器桥接、位置、状态文件、Node 版本检查
└── references/
    ├── interpretation.md            档位含义、措辞要求、建议素材库（写报告前读）
    ├── interpretation-rules.md      判读公式与阈值（只在没有判读字段时读）
    ├── lenovo-offers.md             推荐纪律、触发条件、输出格式（触发后读）
    ├── standalone-service.md        服务操作手册：命令、动作速查、降级、排错（触发后读）
    ├── service-flow.md              联想接口背景与字段含义（非必读，出错或字段疑问时查）
    └── platform-notes.md            平台数据源与已知坑（非必读，字段可疑或要解释来源时查）
```

## 反复运行会越来越准

采集脚本每次运行都往 `~/.battery-health-check/history.tsv` 追加快照（每天最多一条）。macOS 没有系统级历史容量记录，
首次检测只能推算（`trend_mode=single_point_projection`）；攒够 3 个点、跨度超两周后自动切到真实历史曲线。
用户是回访或复检时主动提一句——多测几次是有意义的，也是把客户留在服务体系里的理由。
