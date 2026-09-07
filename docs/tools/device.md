# 能力域：设备概况

回答「这台机器是什么」。

| 项 | 值 |
|---|---|
| 工具 | `device_get_info` |
| skill | `.dsh/skills/device-overview/` |
| 平台 | 仅 Windows |
| 数据源 | Windows CIM（`Win32_ComputerSystem` / `Win32_OperatingSystem` / `Win32_Processor` / `Win32_VideoController` / `Win32_DiskDrive`） |

## 返回什么

厂商、型号、设备类型、系统（版本 / build / 架构）、CPU（名称 / 物理核 / 逻辑核）、
GPU 列表、内存 GB、物理盘列表（型号 / 容量 / 介质 / 接口）。

## 边界

**不读序列号。** 型号足以支撑服务推荐和适配性判断，序列号只会把这份报告变成敏感数据——
一旦带上，用户就不能随手把报告截图发给客服了。`test/tools/device.test.js` 里有断言拦这件事。

`device_type` 来自 `PCSystemType` 的映射表，取不到时是 `'unknown'` 而不是猜一个。

## 判读注意

这是**静态配置**，不是性能结论。「配置低」和「现在卡」是两件事，
后者要走 [performance](performance.md)。设备信息本身不构成升级建议的充分条件——
推荐纪律见 `.dsh/skills/service-recommendation/`。

## 验证状态

见 **[docs/progress.md 第六章](../progress.md#六未验证与已知缺口)**——那是全仓库验证口径的唯一事实来源。
不要在这里另写一份，两份必然漂移。
