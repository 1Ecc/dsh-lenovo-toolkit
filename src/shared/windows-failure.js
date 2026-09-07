/**
 * Windows 只读检测的统一错误翻译。
 *
 * 拆成 shared 是因为 device / performance / storage / app / wifi 五个能力域
 * 都要把 PowerShellError 翻成同一套 status + code。各组各写一份的话，
 * 「拒绝访问」和「命令超时」迟早会在不同工具里退化成不同措辞，
 * 而这两件事对用户是完全不同的处置方式。
 *
 * 逐字迁自原 device 单体采集器，未改动判定逻辑——那部分在 Windows 11 上验证过。
 */
import { PowerShellError } from './powershell.js'
import { failure } from './result.js'

export function executionFailure(error) {
    if (error instanceof PowerShellError) {
        if (/Access is denied|拒绝访问|0x80041003/i.test(error.message)) {
            return failure("permission_denied", "windows_access_denied", "Windows 拒绝了该项只读检测。请检查当前用户权限或系统策略。");
        }
        const status = error.kind === "unavailable" ? "unsupported" : "error";
        const messages = {
            unavailable: error.message,
            timeout: "Windows 检测命令执行超时。",
            failed: "Windows 检测命令执行失败。",
            invalid_json: "Windows 检测返回了无法解析的数据。",
            too_large: "Windows 检测结果超过大小限制。",
        };
        return failure(status, `powershell_${error.kind}`, messages[error.kind]);
    }
    return failure("error", "unexpected_error", "设备检测发生了未预期错误。请稍后重试。");
}
