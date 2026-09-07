# 发版前验证清单（17 工具版本）

**这是 npm 发版的前置条件，顺序不可颠倒。** 理由见 `AGENTS.md`：
一个工具的 schema 不合规会阻断**整个插件树**加载——不是这个工具不可用，是整个插件废掉。
把未验证的 17 工具版本推上 npm，风险比保持旧版（`0.1.1`，只有电池）更大。

验证完请把结果写回 **[docs/progress.md 第六章](progress.md#六未验证与已知缺口)**——
那是全仓库验证口径的唯一事实来源。

## 环境

需要一台能跑 DSH 的 **Windows** 机器（六个非电池能力域只支持 Windows）。

| 项 | 要求 |
|---|---|
| Node | ≥ 20 |
| PowerShell | 5.1 或 7.x（5.1 是重点，编码和数组语法问题在这个版本上踩过） |
| Python | 仅电池趋势图需要；注意**应用执行别名**问题，见 A-3 |

---

## A. 装得上（最先做，失败就不用往下走了）

| # | 步骤 | 通过标准 |
|---|---|---|
| A-1 | `dsh plugin --profile web add github:1Ecc/dsh-lenovo-toolkit` | 安装成功，无 `allowBuilds` 提示（本包无构建步骤） |
| A-2 | 重启 `dsh web` 并刷新页面 | 插件树正常加载，**没有 schema 编译错误** |
| A-3 | 在 DSH 里问「帮我看下电池健康度」 | 触发 `battery-health-check`，能出报告。若报 Python 相关错误，记录是 `py -3` / `python` / `python3` 哪一档命中 |

⚠️ **A-2 是最关键的一步。** `87ee6c5` 那次就是整个插件树加载不了。
如果这里失败，看报错指向哪个工具的 schema，修完重跑，**不要跳过继续测别的**。

## B. 17 个工具逐个冒烟

在 DSH 里让模型逐个调用。每个都要确认返回的 `ToolEnvelope` 里
`status` / `collected_at` / `data` / `warnings` / `error` 五个字段齐全。

### 只读检测（13 个）

| # | 工具 | 怎么触发 | 通过标准 |
|---|---|---|---|
| B-1 | `device_get_info` | 「我这台电脑什么配置」 | 厂商/型号/系统/CPU/GPU/内存/物理盘齐全；**没有序列号字段** |
| B-2 | `performance_get_status` | 「现在 CPU 内存占用多少」 | 有 `cpu_usage_percent`、`memory_usage_percent`、`uptime_seconds`；warnings 含「时点快照」 |
| B-3 | `process_list` | 「哪个进程最占 CPU」 | 默认 5 条；不含命令行和完整路径；试 `sort_by=memory` 和 `limit=20` |
| B-4 | `storage_get_status` | 「我的盘满了吗」 | 只列固定卷；U 盘/网络盘**不应出现** |
| B-5 | `app_list`（正常） | 「装没装 Lenovo Vantage」 | 能查到；warnings 含「免安装程序可能不出现」 |
| B-6 | `app_list`（越界） | 让模型不带关键词查全部软件 | **必须被拒**：`error.code = invalid_query` |
| B-7 | `wifi_get_status` | 「我的 Wi-Fi 什么情况」 | 网卡/SSID/IP/DNS/网关；信号强度取不到时是 `null` 且带 warning |
| B-8 | `wifi_diagnose` | 「网怎么连不上」 | 四项连通性都有结论 |
| B-9 | `wifi_diagnose`（拔网线/关 Wi-Fi） | 断网后再问一次 | `adapter_status` 为 `disconnected`，其余为 `not_run`——**不能是失败值** |
| B-10 | `network_monitor` | 「测一下网络波动」 | 默认 30 秒；试 `duration_seconds=5` 和 `60`；边界外的值应被夹到区间内 |
| B-11 | `wifi_generate_report` | 「出一份 Wi-Fi 体检图」 | SVG 能在浏览器打开；**图里没有 SSID、IP、DNS、网关** |
| B-12 | `wifi_generate_html_report` | 「出一份动态 Wi-Fi 报告」 | HTML 自包含（断网也能打开）；同样脱敏 |
| B-13 | `battery_health_collect` / `_trend` / `_rules` | A-3 已覆盖，补测 `_rules` 三份文档都能取到 | 未知规则名要**报错**而不是返回空 |

### 受控操作（4 个）—— 重点验证「拒绝」路径

| # | 工具 | 怎么测 | 通过标准 |
|---|---|---|---|
| B-14 | `open_system_settings` | 先让模型在**未取得你同意**的情况下调用 | `permission_denied` + `confirmation_required` |
| B-15 | `open_app` | 同上，再试让它打开白名单外的程序 | 未确认被拒；白名单外被拒 |
| B-16 | `open_url` | 试 `https://support.lenovo.com.evil.example/` | **必须被拒**（子串前缀绕过） |
| B-17 | `copy_diagnostic_report` | 未确认调用 + 超过 12000 字符 | 两种都被拒 |

**确认过之后再各跑一次正常路径**，确保确认后确实能执行。

## C. skill 路由

| # | 检查 | 通过标准 |
|---|---|---|
| C-1 | 9 个 skill 在 DSH 里都能被发现 | `.dsh/skills/` 顶层九个目录都出现（DSH **只扫顶层不递归**） |
| C-2 | 总路由 `xiangbangbang-device-assistant` 生效 | 说「电脑越来越慢了」应走性能诊断，不是把九个 skill 全拉起来 |
| C-3 | 服务推荐不抢跑 | 诊断结论未成立时**不应**出现商品或服务链接 |

## D. 通过之后才做的事

1. `package.json` bump 版本（`0.1.1` → `0.2.0`：新增 6 个能力域 14 个工具，是 feature 级变更）
2. `npm publish`
3. 把验证结果写回 `docs/progress.md` 第六章
4. 更新收录平台（见 `docs/marketplace-listing.md`）

**第 3 步不要跳过。** 目录站会核对描述真实性，而下一个接手的人只会读那张表。
