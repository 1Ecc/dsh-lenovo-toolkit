# 能力域索引

**一个工具组 = 一个能力域。** 能力域按「用户会分开问的问题」切分，不按实现方便切分。
`test/repo.test.js` 里有守卫强制每个能力域带齐 `collector.js` / `register.js` / 本目录下的文档 / `test/tools/<域>.test.js`，
并挂进 `src/index.js` 的 `GROUPS`。

| 能力域 | 工具数 | 对应 skill | 平台 | 文档 |
|---|---|---|---|---|
| `battery` | 9 | `battery-health-check` | macOS + Windows（服务链路 6 个工具需联网） | [battery.md](battery.md) |
| `device` | 1 | `device-overview` | Windows | [device.md](device.md) |
| `performance` | 2 | `performance-diagnosis` | Windows | [performance.md](performance.md) |
| `storage` | 1 | `storage-diagnosis` | Windows | [storage.md](storage.md) |
| `app` | 1 | `app-diagnosis` | Windows | [app.md](app.md) |
| `wifi` | 5 | `wifi-diagnosis`、`wifi-health-report` | Windows | [wifi.md](wifi.md) |
| `actions` | 4 | 无专属 skill，被各 skill 复用 | Windows | [actions.md](actions.md) |

共 **23 个 DSH 工具**。另有两个不带工具的 skill：`service-recommendation`（纯推荐纪律）
和 `xiangbangbang-device-assistant`（总路由）。

`actions` 是唯一不对应单个诉求的能力域：它是「需逐次确认的低风险操作」的统一出口，
按职责而非按用户诉求单列。

## 迁移来源

`device` / `performance` / `storage` / `app` / `wifi` / `actions` 六个能力域共 14 个工具，
于 2026-09-03（提交 `a66d386`）从**想帮帮 Device MCP** 迁入。迁移只复制非电池能力，
原电池工具组没有修改，也没有注册第二套电池工具（`test/repo.test.js` 有守卫）。

迁入时这 14 个工具挤在 `device` / `wifi` / `actions` 三个组里——`device` 一个组
装了 5 个工具对应 3 个 skill，`wifi` 的采集函数还住在 `device/collector.js` 里。
2026-09-07 按能力域重新拆分为现在的七组，采集与判定逻辑逐字保留未改。

⚠️ **迁入内容的来源授权尚待确认**，见 [progress.md 第六章](../progress.md#六未验证与已知缺口)。

## 所有检测工具的共同契约

统一返回 `ToolEnvelope`，各工具不得自己发明错误格式：

| 字段 | 含义 |
|---|---|
| `status` | `success` / `partial` / `unsupported` / `permission_denied` / `error` |
| `collected_at` | ISO 时间戳 |
| `data` | 结构化结果；失败时为 `null` |
| `warnings` | 判读时必须转述的限制条件，例如「这是时点快照」 |
| `error` | `{ code, message }`；成功时为 `null` |

**缺失字段不得补成确定事实。** 采集不到就是 `null`，不要用推算值顶上——
这条是 `AGENTS.md` 第 2、4 条约束在数据层的落点。

`status` 要能区分「检测没跑起来」和「检测跑了但结果不好」。二者混同的典型后果是
把一次权限失败讲成「你的网络断了」。

## 隐私与安全边界

这些不是可选项，改动前先读 `AGENTS.md` 第 5 条：

- 非电池工具不读取设备序列号、用户名、产品密钥和用户目录。电池组的保修/备件价查询会把主机编号
  发到联想官方接口，因此要求 `confirmed=true`——模型必须先告知用户再调用。
- 进程查询不返回命令行和完整可执行路径。
- 应用查询必须包含至少两个字符，**不能枚举全部软件**。
- 存储只看固定卷容量数字，**不遍历用户文件**。
- Wi-Fi 报告隐藏 SSID、IP、DNS 和网关地址。
- 四个操作工具必须先取得用户对**本次具体操作**的明确同意，并由 `confirmed=true` 二次校验。
- URL 只允许无凭据 HTTPS 的联想和微软官方白名单地址。

每条边界在对应能力域的测试里都有断言，见各文档。
