# 能力域：存储空间

回答「盘是不是满了」。

| 项 | 值 |
|---|---|
| 工具 | `storage_get_status` |
| skill | `.dsh/skills/storage-diagnosis/` |
| 平台 | 仅 Windows |
| 数据源 | Windows CIM（`Win32_LogicalDisk`，`DriveType = 3`） |

## 返回什么

每个**固定卷**的盘符、卷标、文件系统、总容量、已用、剩余、使用率。

## 边界

**只看容量数字，不遍历用户文件。** 扫目录既慢又越界，而「哪个盘快满了」
这个结论根本不需要知道里面装了什么。`test/tools/storage.test.js` 断言了
采集脚本里不出现 `Get-ChildItem` 这类遍历命令。

**只算固定卷**（`DriveType = 3`）。放开这个过滤会把 U 盘、网络盘、光驱一起算进
「空间不足」，得出「你需要扩容」这种错误结论。

容量取不到时是 `null`，`usage_percent` 也随之为 `null`，不用 0 顶替——
0% 使用率和「读不到」在报告里是完全不同的两句话。

## 判读注意

剩余空间少**不等于**需要换更大的硬盘。先区分「系统盘被临时文件占满」和
「数据确实放不下」，前者是清理问题。扩容建议的触发条件见
`.dsh/skills/storage-diagnosis/references/storage_upgrade.md`，
推荐纪律见 `.dsh/skills/service-recommendation/`。

## 验证状态

见 **[docs/progress.md 第六章](../progress.md#六未验证与已知缺口)**——那是全仓库验证口径的唯一事实来源。
不要在这里另写一份，两份必然漂移。
