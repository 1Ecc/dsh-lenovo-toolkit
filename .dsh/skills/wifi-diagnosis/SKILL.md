---
name: wifi-diagnosis
description: '诊断 Windows Wi-Fi 未连接、断网、信号弱、网关、DNS、延迟和互联网连通性问题，并区分局域网与互联网故障。'
whenToUse: '用户提到 Wi-Fi、无法联网、断网、网速慢、DNS、延迟、丢包或网络异常时。'
user-invocable: true
disable-model-invocation: false
---

# Wi-Fi 诊断 Skill

## 目的

用于处理：

- Wi-Fi 无法连接
- Wi-Fi 经常断开
- 网络速度慢
- DNS 解析失败
- 能连接路由器但无法访问互联网
- 用户询问当前 Wi-Fi 状态

## 主要工具

- `wifi_get_status`
- `wifi_diagnose`

根据需要：

- `device_get_info`

低风险操作：

- `open_system_settings`
- `open_url`
- `copy_diagnostic_report`

## 工作流程

### 1. 获取当前网络状态

先调用：

`wifi_get_status`

查看：

- 是否连接
- SSID
- signal strength
- adapter
- IP
- DNS
- gateway

### 2. 执行基础诊断

如果用户报告网络异常，调用：

`wifi_diagnose`

建议检测：

- 无线网卡状态
- gateway connectivity
- DNS resolution
- Internet connectivity
- 基础 latency

### 3. 根据结果检索 Knowledge

例如：

- Wi-Fi 未连接
  → `wifi_disconnect`

- 信号较弱 / 连接不稳定
  → `wifi_slow`

- DNS 失败
  → 检索 Wi-Fi/DNS 相关内容

对应资料位于本 skill 的 `references/`；不得一次性读取全部资料。

### 4. 诊断原则

区分：

- 本机无线网卡问题
- Wi-Fi 信号问题
- 路由器 / gateway 问题
- DNS 问题
- Internet 上游问题

不要仅根据“无法上网”就判断电脑网卡故障。

## 服务推荐

Wi-Fi 问题一般优先给软件/网络排查建议。

只有当：

- 网卡持续异常
- 设备侧网络硬件疑似故障
- 用户明确需要专业检测

才加载 `service_recommendation`。

第一版不自动重置网络配置。
