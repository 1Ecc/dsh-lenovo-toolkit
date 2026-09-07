# 能力域：Wi-Fi 与网络连通性

回答「网怎么这么慢 / 连不上」，并出一份能发出去的体检报告。

| 项 | 值 |
|---|---|
| 工具 | `wifi_get_status` · `wifi_diagnose` · `network_monitor` · `wifi_generate_report` · `wifi_generate_html_report` |
| skill | `.dsh/skills/wifi-diagnosis/` · `.dsh/skills/wifi-health-report/` |
| 平台 | 仅 Windows |
| 数据源 | `Get-NetAdapter` / `Get-NetConnectionProfile` / `Get-NetIPConfiguration` / `netsh wlan` + Node 的 DNS 与 TCP 检查 |

## 工具

| 工具 | 做什么 | 会发出网络请求吗 |
|---|---|---|
| `wifi_get_status` | 读物理网卡、连接配置、IP / DNS / 网关、信号强度 | 否 |
| `wifi_diagnose` | 在上面基础上检查网关、DNS 解析、互联网 TCP 连通性 | **是**：ping 默认网关 + 连 `www.microsoft.com:443` |
| `network_monitor` | 按秒采样网卡真实吞吐和网关延迟，5～60 秒，默认 30 | 只 ping 网关 |
| `wifi_generate_report` | 确定性的脱敏 SVG 体检图 | 同 `wifi_diagnose` |
| `wifi_generate_html_report` | 含真实采样的自包含本地 HTML 动态报告 | 同上 + 采样 |

`network_monitor` 测的是**当前实际流量**，不是主动宽带测速。用户没在下载时数字自然很小，
把它讲成「你的带宽只有 X」是错的。

## 四条判读纪律

**① 区分局域网故障和互联网故障。** `gateway_connectivity` 通而
`internet_connectivity` 不通，是运营商或 DNS 的问题，不是「Wi-Fi 坏了」。
这个区分是这个能力域存在的主要价值。

**② 没网卡 / 没连接时不跑连通性检测。** 相关字段返回 `not_run` 而不是失败值——
把「这台机器没有 Wi-Fi」误报成「网络故障」会让整份报告失去可信度。
`test/tools/wifi.test.js` 对这两个分支都有断言。

**③ 采集失败原样透传，不伪装成诊断结论。** `wifiDiagnoseFromStatus` 拿到
`error` / `permission_denied` 的 status 会直接返回它，不会继续往下编。

**④ 信号强度可能拿不到。** 部分 Windows 环境不提供，此时是 `null` 并带 warning，
不要用「信号良好」顶替。

## 脱敏

报告类工具（SVG / HTML）**隐藏 SSID、IP、DNS 和网关地址**。报告是要被截图发给客服的，
脱敏不是可选项。`test/tools/wifi.test.js` 用一份含真实私密值的假数据断言这些串不出现在输出里。

## 模块结构

这个能力域的模块比其他组多，因为报告渲染是独立的一块：

| 文件 | 职责 |
|---|---|
| `collector.js` | 网卡状态采集 + 连通性诊断（纯采集与判定） |
| `network-monitor.js` | 逐秒采样与确定性摘要计算 |
| `report.js` | 报告数据构造 + SVG 渲染 |
| `html-report.js` | 自包含 HTML 报告渲染 |
| `register.js` | Cordis 注册壳 |

`wifiDiagnoseFromStatus` 与 `wifiDiagnose` 分开导出是刻意的：
报告类工具已经拿到过 status，不该为了出报告再打一次网卡。

**报告里的数字全部来自确定性计算，不经过图片模型改写。**

## 验证状态

见 **[docs/progress.md 第六章](../progress.md#六未验证与已知缺口)**——那是全仓库验证口径的唯一事实来源。
不要在这里另写一份，两份必然漂移。
