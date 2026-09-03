---
name: storage-diagnosis
description: '诊断 Windows 固定卷空间不足、磁盘容量和 SSD 相关问题，不扫描用户文件，并在证据充分时给出扩容建议。'
whenToUse: '用户提到磁盘空间不足、系统盘快满、SSD、硬盘容量、存储或扩容时。'
user-invocable: true
disable-model-invocation: false
---

# 存储诊断 Skill

## 目的

用于处理：

- 系统盘空间不足
- 磁盘快满
- 用户询问 SSD / 存储容量
- 怀疑存储导致性能问题
- 用户询问是否需要扩容

## 主要工具

- `storage_get_status`

根据需要：

- `device_get_info`
- `performance_get_status`

低风险操作：

- `open_system_settings`
- `copy_diagnostic_report`
- `open_url`

## 工作流程

### 1. 获取存储状态

调用：

`storage_get_status`

关注：

- 总容量
- 已使用
- 剩余容量
- 使用率
- 磁盘类型（如果可获取）
- 各主要卷的空间情况

### 2. 判断问题类型

可能属于：

- 临时空间不足
- 长期容量不足
- 多磁盘空间分布不合理
- 用户对升级容量有明确需求

### 3. Knowledge 检索

根据结果检索：

- `device/storage`
- `diagnosis/low_storage`

对应资料位于本 skill 的 `references/`，服务资料仍需等诊断建立真实升级需求后再读。

### 4. 建议顺序

优先：

1. 解释当前空间情况
2. 建议清理不必要内容或迁移数据
3. 如果属于长期容量瓶颈，再讨论扩容

Demo 第一版不自动删除文件，也不执行清理。

## 趋势能力边界

当前 `storage_get_status` 只提供即时卷级容量，不能凭单次结果推断增长趋势。

如果用户询问“最近增长多少”“多久会满”或“清理是否有效”，需要至少两个跨时间快照。趋势报告的推荐数据结构、保留策略和后台采集授权边界见 `storage_trend_design.md`；在历史采集能力实现前，应明确说明暂无历史数据，不生成模拟曲线。

## 服务推荐

以下情况可以加载 `service_recommendation`：

- 存储容量长期不足
- 用户明确希望扩容
- 设备型号和存储结构允许进一步判断升级方案

可自然推荐：

- SSD 扩容
- 数据迁移
- 检测 / 更换服务

具体适配性、价格和链接必须实时检索。
