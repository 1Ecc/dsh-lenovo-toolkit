# 能力域：受控操作

唯一会**改变机器状态**的能力域。也是唯一不对应单个用户诉求的能力域——
它是「需逐次确认的低风险操作」的统一出口，被各诊断 skill 复用。

| 项 | 值 |
|---|---|
| 工具 | `open_system_settings` · `open_app` · `open_url` · `copy_diagnostic_report` |
| skill | 无专属 skill |
| 平台 | 仅 Windows |

## 工具与白名单

| 工具 | 允许什么 | 明确不允许 |
|---|---|---|
| `open_system_settings` | `power` / `network` / `storage` / `apps` / `display` / `bluetooth` / `windows_update` 七个页面 | 修改任何设置；打开白名单外的页面 |
| `open_app` | 任务管理器、Lenovo Vantage | 任意路径、任意命令 |
| `open_url` | 无凭据 HTTPS 的联想 / 微软官方白名单域名 | HTTP；白名单外域名 |
| `copy_diagnostic_report` | 写入剪贴板，上限 12000 字符 | 超长内容 |

**只打开，不修改。** 这四个工具没有一个会改设置、装东西或删东西。
这条边界一旦破，整个工具集的信任前提就没了。

## 两层确认

1. **调用前**必须向用户说明具体动作并取得明确同意；
2. 只有在此之后才能传 `confirmed=true`，collector 会做第二层校验。

未确认时一律返回 `status: 'permission_denied'` + `error.code: 'confirmation_required'`，
四个工具无一例外——`test/tools/actions.test.js` 逐个断言。

**同意是逐次的，不能跨调用复用。** 用户同意「打开电源设置」不等于同意「打开 Windows 更新」。

## URL 白名单按域名边界匹配

`validateAllowedUrl` 不做子串匹配。`https://support.lenovo.com.evil.example/` 这种
「把白名单域名做成攻击域名前缀」的经典绕过会被拒——测试里有这条用例。
改动白名单逻辑时务必保留它。

## 验证状态

见 **[docs/progress.md 第六章](../progress.md#六未验证与已知缺口)**——那是全仓库验证口径的唯一事实来源。
不要在这里另写一份，两份必然漂移。
