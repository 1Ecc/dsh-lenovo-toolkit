---
name: app-diagnosis
description: '按名称查询 Windows 已安装应用并辅助诊断应用版本或资源占用问题，不允许无条件枚举全部软件。'
whenToUse: '用户询问某个软件是否安装、软件版本、应用问题或希望打开受控应用时。'
user-invocable: true
disable-model-invocation: false
---

# 应用与软件诊断 Skill

## 目的

用于处理：

- 查询某个软件是否已安装
- 查询软件版本
- 用户怀疑某个应用导致性能问题
- 用户需要打开某个已安装应用
- 用户询问常见应用状态

## 主要工具

- `app_list`

根据需要：

- `process_list`
- `performance_get_status`
- `device_get_info`

低风险操作：

- `open_app`
- `open_system_settings`
- `open_url`

## 工作流程

### 1. 查询应用

使用：

`app_list`

优先按名称搜索，不要默认返回全部已安装应用。

返回时重点关注：

- name
- version
- publisher

### 2. 如果用户怀疑应用造成性能问题

可进一步调用：

- `performance_get_status`
- `process_list`

判断该应用是否正在产生明显资源压力。

### 3. 如果只是需要打开应用

确认应用存在后，可以使用：

`open_app`

不要用任意 executable 路径或 shell command。

### 4. Knowledge 检索

只有在需要解释特定软件行为时才检索相关知识。

应用诊断资料位于本 skill 的 `references/`。

## 服务推荐

一般不因为应用问题推荐硬件服务。

只有当软件问题进一步暴露出明确硬件瓶颈或设备异常时，才转入对应 Skill，并由其决定是否加载 `service_recommendation`。
