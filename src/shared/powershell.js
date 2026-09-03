import { spawn } from "node:child_process";
const POWERSHELL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export class PowerShellError extends Error {
    kind;
    constructor(message, kind) {
        super(message);
        this.kind = kind;
        this.name = "PowerShellError";
    }
}
export async function runPowerShellJson(body, options = {}) {
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "& {",
        body,
        "} | ConvertTo-Json -Compress -Depth 10",
    ].join("\n");
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    return await new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...options.env },
        });
        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let settled = false;
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            child.kill();
            finish(() => reject(new PowerShellError("Windows 检测命令执行超时。", "timeout")));
        }, options.timeoutMs ?? POWERSHELL_TIMEOUT_MS);
        child.once("error", (error) => {
            finish(() => reject(new PowerShellError(`无法启动 PowerShell：${error.message}`, "unavailable")));
        });
        child.stdout.on("data", (chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_OUTPUT_BYTES) {
                child.kill();
                finish(() => reject(new PowerShellError("Windows 检测结果超过大小限制。", "too_large")));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.once("close", (code) => {
            finish(() => {
                const errorText = Buffer.concat(stderr).toString("utf8").trim();
                if (code !== 0) {
                    reject(new PowerShellError(errorText || `PowerShell 退出码为 ${code ?? "unknown"}。`, "failed"));
                    return;
                }
                const text = Buffer.concat(stdout).toString("utf8").replace(/^\uFEFF/, "").trim();
                if (!text) {
                    reject(new PowerShellError("Windows 检测没有返回数据。", "invalid_json"));
                    return;
                }
                try {
                    resolve(JSON.parse(text));
                }
                catch {
                    reject(new PowerShellError("Windows 检测返回了无法解析的数据。", "invalid_json"));
                }
            });
        });
    });
}
//# sourceMappingURL=powershell.js.map