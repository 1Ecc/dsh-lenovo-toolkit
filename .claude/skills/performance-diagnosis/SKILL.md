---
name: performance-diagnosis
description: '诊断 Windows 电脑卡顿、响应慢、冻结以及 CPU 或内存占用高的问题，使用当前性能快照和高占用进程进行谨慎判断。'
whenToUse: '用户提到电脑卡顿、反应慢、冻结、CPU 高、内存高、风扇忙或应用响应慢时。'
user-invocable: true
disable-model-invocation: false
---

# 性能诊断 Skill

## 目的

用于诊断 Windows 常见性能问题：

- 电脑运行缓慢
- 卡顿或冻结
- 应用响应慢
- CPU 使用率过高
- 内存使用率过高
- 怀疑后台进程占用资源

## 主要工具

- `performance_get_status`
- `process_list`

根据需要：

- `device_get_info`
- `storage_get_status`
- `app_list`

低风险操作：

- `open_system_settings`
- `open_app`
- `copy_diagnostic_report`

## 工作流程

### 1. 检查整体性能状态

调用：

`performance_get_status`

查看：

- CPU 使用率
- 内存使用率
- 系统运行时间
- 可提供的基础负载信息

不要因为一次高占用立即判断硬件故障。

### 2. 定位异常资源占用

如果 CPU 或内存明显偏高：

调用：

`process_list`

重点识别：

- Top CPU 进程
- Top Memory 进程

避免把完整进程表加载给模型。

### 3. 必要时检查硬件配置

以下情况调用：

`device_get_info`

例如：

- 怀疑内存容量不足
- 需要了解 CPU / RAM 配置
- 需要设备型号以评估升级或服务

### 4. 必要时检查存储

如果症状可能与磁盘空间相关：

调用：

`storage_get_status`

### 5. Knowledge 检索

只检索与结果相关内容：

- `high_cpu`
- `high_memory`
- `low_storage`
- 相关软件/进程知识

对应资料位于本 skill 的 `references/`，只读取与检测结果匹配的文件。

## 诊断分类

### 临时资源压力

如：

- 浏览器当前占用大量内存
- 同时运行大量程序

优先建议关闭不必要程序或调整使用方式。

### 长期配置瓶颈

如：

- 正常工作场景下内存长期接近满载
- 物理内存容量明显限制常用工作流

此时可考虑升级。

### 可能的系统问题

如：

- 长时间高 CPU
- 但没有明显高占用前台程序

建议进一步检查，不要直接判断硬件故障。

## 服务推荐

只有存在合理服务需求时才加载 `service_recommendation`：

- 内存容量明显不足
- 存储容量长期不足
- 长期异常性能或疑似散热问题

如果简单软件调整可能解决问题，不优先推荐付费服务。
