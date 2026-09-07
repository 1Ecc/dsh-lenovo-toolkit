/**
 * 能力域：已安装应用查询。对应 skill `app-diagnosis`。
 *
 * 强制要求至少 2 个字符的关键词，是为了**堵掉无条件枚举全部软件**这条路——
 * 装了什么软件是高度敏感的画像信息，按名查询和拉全量清单是两件事。
 */
import { runPowerShellJson } from '../../shared/powershell.js'
import { failure, success } from '../../shared/result.js'
import { executionFailure } from '../../shared/windows-failure.js'

export async function appList(query, limit) {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2 || normalizedQuery.length > 100) {
        return failure("error", "invalid_query", "query 长度必须为 2 到 100 个字符。", ["不允许无关键词枚举全部软件。"]);
    }
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    try {
        const data = await runPowerShellJson(String.raw `
$query = $env:XBB_APP_QUERY
$paths = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$apps = @(Get-ItemProperty $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and $_.DisplayName.IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
  Sort-Object DisplayName, DisplayVersion -Unique |
  Select-Object -First ${safeLimit} |
  ForEach-Object {
    [pscustomobject]@{ name = $_.DisplayName; version = $_.DisplayVersion; publisher = $_.Publisher }
  })
[pscustomobject]@{ query = $query; limit = ${safeLimit}; apps = $apps; source = 'Windows uninstall registry' }
`, { env: { XBB_APP_QUERY: normalizedQuery } });
        return success(data, ["结果来自卸载注册表；免安装程序和部分商店应用可能不会出现。"]);
    }
    catch (error) {
        return executionFailure(error);
    }
}
