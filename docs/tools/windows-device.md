# Windows 设备助手工具组

本工具组从想帮帮 Device MCP 迁入 DSH。迁移只复制非电池能力；原电池工具组没有修改，也没有注册第二套电池工具。

## 工具

| 领域 | 工具 |
|---|---|
| 设备 | `device_get_info`、`performance_get_status`、`process_list`、`storage_get_status`、`app_list` |
| Wi-Fi | `wifi_get_status`、`wifi_diagnose`、`network_monitor`、`wifi_generate_report`、`wifi_generate_html_report` |
| 受控操作 | `open_system_settings`、`open_app`、`open_url`、`copy_diagnostic_report` |

所有检测工具继续返回统一结构：`status`、`collected_at`、`data`、`warnings` 和 `error`。缺失字段不得补成确定事实。

## 隐私与安全

- 不读取设备序列号、用户名、产品密钥和用户目录。
- 进程查询不返回命令行和完整可执行路径。
- 应用查询必须包含至少两个字符，不能枚举全部软件。
- Wi-Fi 报告隐藏 SSID、IP、DNS 和网关地址。
- 四个操作工具必须先取得用户对本次具体操作的明确同意，并由 `confirmed=true` 进行第二层校验。
- URL 只允许无凭据 HTTPS 的联想和微软官方白名单地址。

## 当前验证状态

迁入逻辑来自已经在 Windows 11 验证过的 Device MCP；本仓库中的 DSH Cordis 注册壳仍需在真实 DSH 运行时验证。不得把“原 MCP 已验证”表述成“DSH 插件已验证”。
