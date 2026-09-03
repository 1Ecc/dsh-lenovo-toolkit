import { spawn } from "node:child_process";
import path from "node:path";
import { runPowerShellJson } from "../../shared/powershell.js";
import { failure, success } from "../../shared/result.js";
const SETTINGS_PAGES = {
    power: "ms-settings:powersleep",
    network: "ms-settings:network-status",
    storage: "ms-settings:storagesense",
    apps: "ms-settings:appsfeatures",
    display: "ms-settings:display",
    bluetooth: "ms-settings:bluetooth",
    windows_update: "ms-settings:windowsupdate",
};
const ALLOWED_URL_HOSTS = new Set([
    "support.lenovo.com",
    "pcsupport.lenovo.com",
    "www.lenovo.com",
    "support.microsoft.com",
    "learn.microsoft.com",
]);
function requireConfirmation(confirmed) {
    if (confirmed)
        return null;
    return failure("permission_denied", "confirmation_required", "执行前必须由智能体向用户说明具体操作并取得明确同意，然后以 confirmed=true 重试。");
}
async function spawnVisible(command, args) {
    await new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
            detached: true,
            windowsHide: false,
            stdio: "ignore",
        });
        const timer = setTimeout(() => reject(new Error("启动操作超时。")), 5_000);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("spawn", () => {
            clearTimeout(timer);
            child.unref();
            resolve();
        });
    });
}
export async function openSystemSettings(page, confirmed) {
    const denied = requireConfirmation(confirmed);
    if (denied)
        return denied;
    try {
        await spawnVisible("explorer.exe", [SETTINGS_PAGES[page]]);
        return success({ launch_requested: true, page, target: SETTINGS_PAGES[page] });
    }
    catch {
        return failure("error", "open_failed", "无法打开指定的 Windows 设置页面。");
    }
}
export async function openApp(app, confirmed) {
    const denied = requireConfirmation(confirmed);
    if (denied)
        return denied;
    try {
        if (app === "task_manager") {
            const command = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "Taskmgr.exe");
            await spawnVisible(command, []);
            return success({ launch_requested: true, app });
        }
        const result = await runPowerShellJson(String.raw `
$app = Get-StartApps | Where-Object { $_.Name -in @('Lenovo Vantage', 'Commercial Vantage') } | Select-Object -First 1
if (-not $app) {
  [pscustomobject]@{ available = $false }
  return
}
Start-Process -FilePath explorer.exe -ArgumentList ('shell:AppsFolder\' + $app.AppID)
[pscustomobject]@{ available = $true; name = $app.Name }
`);
        if (!result.available) {
            return failure("unsupported", "app_not_available", "当前系统未安装 Lenovo Vantage。可先使用 app_list 查询已安装的联想软件。");
        }
        return success({ launch_requested: true, app, detected_name: result.name });
    }
    catch {
        return failure("error", "app_not_available", `无法启动 ${app}，应用可能未安装或当前环境不支持。`);
    }
}
export function validateAllowedUrl(value) {
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || !ALLOWED_URL_HOSTS.has(parsed.hostname.toLowerCase())) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
export async function openUrl(url, confirmed) {
    const denied = requireConfirmation(confirmed);
    if (denied)
        return denied;
    const parsed = validateAllowedUrl(url);
    if (!parsed) {
        return failure("permission_denied", "url_not_allowed", "只允许打开 HTTPS 的联想或微软官方白名单 URL。");
    }
    try {
        await spawnVisible("explorer.exe", [parsed.toString()]);
        return success({ launch_requested: true, url: parsed.toString() });
    }
    catch {
        return failure("error", "open_failed", "无法打开该官方网页。");
    }
}
export async function copyDiagnosticReport(report, confirmed) {
    const denied = requireConfirmation(confirmed);
    if (denied)
        return denied;
    if (report.length < 1 || report.length > 12_000) {
        return failure("error", "invalid_report", "诊断报告长度必须为 1 到 12000 个字符。");
    }
    try {
        const data = await runPowerShellJson(String.raw `
Set-Clipboard -Value $env:XBB_DIAGNOSTIC_REPORT
[pscustomobject]@{ copied = $true; character_count = $env:XBB_DIAGNOSTIC_REPORT.Length }
`, { env: { XBB_DIAGNOSTIC_REPORT: report } });
        return success(data);
    }
    catch {
        return failure("error", "clipboard_failed", "无法把诊断报告复制到剪贴板。");
    }
}
//# sourceMappingURL=action-tools.js.map
