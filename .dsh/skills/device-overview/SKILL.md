---
name: device-overview
description: '读取并解释 Windows 电脑的型号、系统、CPU、GPU、内存和存储概况。用户询问设备信息、电脑型号、硬件配置、Windows 版本或是否需要升级时使用。'
whenToUse: '用户询问设备型号、硬件配置、CPU、GPU、内存、存储、Windows 版本或整体设备概览时。'
user-invocable: true
disable-model-invocation: false
---

# 设备概览 Skill

## 目的

用于处理：

- 查询电脑型号
- 查看 CPU / GPU / 内存 / 存储配置
- 查看 Windows 版本
- 判断设备的基础硬件配置
- 为后续性能、升级或服务推荐提供设备上下文

## 主要工具

- `device_get_info`

根据需要：

- `storage_get_status`

## 工作流程

### 1. 获取设备基础信息

优先调用：

`device_get_info`

关注：

- manufacturer
- model
- operating system
- CPU
- GPU
- installed memory
- storage devices
- device type

### 2. 根据用户问题补充检测

用户询问存储时：
→ `storage_get_status`

不要为了“完整”而调用所有设备工具。

### 3. 解释配置

如果用户只是询问设备配置：

- 客观解释各部件
- 不主动判断“配置差”
- 不主动推荐升级

如果用户询问“是否需要升级”，应结合实际使用问题或检测结果判断。

## Knowledge 检索

根据用户关注点检索：

- `device/cpu`
- `device/memory`
- `device/storage`
- `device/windows`

这些知识已迁入本 skill 的 `references/`；只读取当前问题涉及的文件。

## 服务推荐

仅在以下场景考虑加载 `service_recommendation`：

- 用户明确询问升级
- 检测结果与用户需求存在明显硬件容量瓶颈
- 某部件存在明显老化或异常

不要仅因为设备较旧就自动推荐付费服务。
