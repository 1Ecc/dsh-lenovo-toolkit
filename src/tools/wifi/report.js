import { wifiDiagnoseFromStatus, wifiGetStatus, } from "../device/collector.js";
import { success } from "../../shared/result.js";
function withoutReportData(source) {
    return { ...source, data: null };
}
function asObjects(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "object" && item !== null) : [];
}
function stateFor(value, good) {
    if (value === good)
        return "good";
    if (value === "not_run" || value === "unavailable" || value === undefined || value === null)
        return "unknown";
    return "bad";
}
function detailFor(value) {
    const labels = {
        connected: "已连接",
        disconnected: "未连接",
        not_found: "未检测到",
        reachable: "可达",
        unreachable: "不可达",
        resolved: "解析正常",
        failed: "解析失败",
        not_run: "未检测",
        unavailable: "无数据",
    };
    return labels[String(value)] ?? "未知";
}
export function buildWifiReportData(statusData, diagnosisData) {
    const interfaces = asObjects(statusData.interfaces);
    const active = interfaces.find((item) => item.connected === true) ?? interfaces[0];
    const signal = typeof active?.signal_strength_percent === "number" ? active.signal_strength_percent : null;
    const linkSpeed = typeof active?.link_speed === "string" ? active.link_speed : null;
    const latency = typeof diagnosisData.gateway_latency_ms === "number" ? diagnosisData.gateway_latency_ms : null;
    const adapterStatus = diagnosisData.adapter_status;
    const gatewayStatus = diagnosisData.gateway_connectivity;
    const dnsStatus = diagnosisData.dns_resolution;
    const internetStatus = diagnosisData.internet_connectivity;
    const chain = [
        { label: "Wi-Fi 网卡", state: stateFor(adapterStatus, "connected"), detail: detailFor(adapterStatus) },
        {
            label: "无线连接",
            state: adapterStatus === "connected" ? (signal !== null && signal < 40 ? "warning" : "good") : "bad",
            detail: signal === null ? "信号未知" : `信号 ${Math.round(signal)}%`,
        },
        { label: "默认网关", state: stateFor(gatewayStatus, "reachable"), detail: detailFor(gatewayStatus) },
        { label: "DNS", state: stateFor(dnsStatus, "resolved"), detail: detailFor(dnsStatus) },
        { label: "Internet", state: stateFor(internetStatus, "reachable"), detail: detailFor(internetStatus) },
    ];
    const failed = chain.find((item) => item.state === "bad");
    const lowSignal = signal !== null && signal < 40;
    let overallStatus = "normal";
    let overallLabel = "当前链路正常";
    let summary = "网卡、网关、DNS 和互联网连接均未发现明显异常。";
    const suggestions = [];
    if (failed) {
        overallStatus = "problem";
        overallLabel = `异常位于：${failed.label}`;
        summary = `检测链路在“${failed.label}”处出现异常，不能据此直接判断无线网卡损坏。`;
    }
    else if (lowSignal) {
        overallStatus = "attention";
        overallLabel = "连接正常，但信号较弱";
        summary = "当前可以联网，但无线信号偏弱，可能影响速度和稳定性。";
    }
    if (adapterStatus === "not_found")
        suggestions.push("确认设备是否有 Wi-Fi 网卡，以及驱动是否正常识别。");
    else if (adapterStatus === "disconnected")
        suggestions.push("先检查飞行模式和 Wi-Fi 开关，再尝试重新连接网络。");
    if (lowSignal)
        suggestions.push("靠近路由器或减少墙体、金属物体造成的无线遮挡。");
    if (gatewayStatus === "unreachable")
        suggestions.push("检查路由器状态；同一网络的其他设备也无法联网时，优先排查路由器。");
    if (gatewayStatus === "reachable" && dnsStatus === "failed")
        suggestions.push("网关可达但 DNS 失败，不建议直接判断网卡故障，也不要未经确认自动修改 DNS。");
    if (dnsStatus === "resolved" && internetStatus === "unreachable")
        suggestions.push("DNS 正常但外网不可达，可检查代理、VPN、防火墙或上游网络。");
    if (overallStatus === "normal")
        suggestions.push("当前无需重置网络或修改 DNS；若问题偶发，可在异常出现时再次检测。");
    if (suggestions.length < 2)
        suggestions.push("若问题持续，可保存本报告并提供给网络管理员或客服进一步排查。");
    return {
        title: "Wi-Fi 网络体检报告",
        overall_status: overallStatus,
        overall_label: overallLabel,
        summary,
        metrics: {
            signal_percent: signal,
            link_speed: linkSpeed,
            gateway_latency_ms: latency,
            network_name: "已隐藏",
        },
        chain,
        suggestions: suggestions.slice(0, 3),
        privacy: "报告已隐藏 SSID、IP、DNS 和网关地址。",
        limitation: "结果仅反映检测时刻；VPN、代理、防火墙和上游网络可能影响判断。",
    };
}
function escapeXml(value) {
    return value.replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
    })[character] ?? character);
}
function wrapText(value, maxCharacters = 30) {
    const lines = [];
    let current = "";
    for (const character of value) {
        current += character;
        if (current.length >= maxCharacters || /[。；，]/.test(character)) {
            lines.push(current);
            current = "";
        }
    }
    if (current)
        lines.push(current);
    return lines;
}
function textLines(lines, x, y, size, color, lineHeight) {
    return lines.map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" font-size="${size}" fill="${color}">${escapeXml(line)}</text>`).join("");
}
export function renderWifiReportSvg(report, collectedAt) {
    const palette = {
        normal: { main: "#0F9D78", soft: "#E8F7F2" },
        attention: { main: "#D99000", soft: "#FFF4D6" },
        problem: { main: "#D94A4A", soft: "#FDECEC" },
        good: "#0F9D78",
        warning: "#D99000",
        bad: "#D94A4A",
        unknown: "#8491A5",
    };
    const theme = palette[report.overall_status];
    const chain = report.chain.map((item, index) => {
        const x = 130 + index * 235;
        const color = palette[item.state];
        const connector = index < report.chain.length - 1
            ? `<line x1="${x + 64}" y1="650" x2="${x + 171}" y2="650" stroke="#CCD4DF" stroke-width="8" stroke-linecap="round"/>`
            : "";
        return `${connector}<circle cx="${x}" cy="650" r="54" fill="${color}"/><text x="${x}" y="662" text-anchor="middle" font-size="34" fill="#FFFFFF">${item.state === "good" ? "✓" : item.state === "bad" ? "!" : item.state === "warning" ? "△" : "?"}</text><text x="${x}" y="738" text-anchor="middle" font-size="27" font-weight="700" fill="#253247">${escapeXml(item.label)}</text><text x="${x}" y="778" text-anchor="middle" font-size="22" fill="#66758A">${escapeXml(item.detail)}</text>`;
    }).join("");
    const summaryLines = wrapText(report.summary, 34);
    const suggestionBlocks = report.suggestions.map((suggestion, index) => {
        const y = 1055 + index * 118;
        return `<circle cx="106" cy="${y - 8}" r="24" fill="${theme.main}"/><text x="106" y="${y}" text-anchor="middle" font-size="22" fill="#FFFFFF">${index + 1}</text>${textLines(wrapText(suggestion, 39), 152, y, 25, "#334158", 36)}`;
    }).join("");
    const timestamp = new Date(collectedAt).toLocaleString("zh-CN", { hour12: false });
    const signal = report.metrics.signal_percent === null ? "未知" : `${Math.round(report.metrics.signal_percent)}%`;
    const speed = report.metrics.link_speed ?? "未知";
    const latency = report.metrics.gateway_latency_ms === null ? "未知" : `${Math.round(report.metrics.gateway_latency_ms)} ms`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">
<rect width="1200" height="1600" fill="#F4F7FB"/>
<rect x="50" y="48" width="1100" height="1504" rx="42" fill="#FFFFFF"/>
<style>text{font-family:'Microsoft YaHei','Segoe UI',sans-serif}</style>
<text x="92" y="132" font-size="45" font-weight="800" fill="#1E2A3B">${escapeXml(report.title)}</text>
<text x="92" y="178" font-size="22" fill="#7A8798">检测时间 ${escapeXml(timestamp)} · 网络名称已隐藏</text>
<rect x="88" y="224" width="1024" height="220" rx="28" fill="${theme.soft}"/>
<circle cx="172" cy="334" r="48" fill="${theme.main}"/>
<text x="172" y="349" text-anchor="middle" font-size="38" fill="#FFFFFF">${report.overall_status === "normal" ? "✓" : "!"}</text>
<text x="248" y="310" font-size="34" font-weight="800" fill="${theme.main}">${escapeXml(report.overall_label)}</text>
${textLines(summaryLines, 248, 358, 25, "#415067", 38)}
<g>
  <rect x="88" y="486" width="314" height="116" rx="22" fill="#F7F9FC"/>
  <text x="120" y="528" font-size="21" fill="#78869A">Wi-Fi 信号</text><text x="120" y="574" font-size="31" font-weight="800" fill="#28364A">${escapeXml(signal)}</text>
  <rect x="443" y="486" width="314" height="116" rx="22" fill="#F7F9FC"/>
  <text x="475" y="528" font-size="21" fill="#78869A">链路速率</text><text x="475" y="574" font-size="31" font-weight="800" fill="#28364A">${escapeXml(speed)}</text>
  <rect x="798" y="486" width="314" height="116" rx="22" fill="#F7F9FC"/>
  <text x="830" y="528" font-size="21" fill="#78869A">网关延迟</text><text x="830" y="574" font-size="31" font-weight="800" fill="#28364A">${escapeXml(latency)}</text>
</g>
${chain}
<line x1="88" y1="840" x2="1112" y2="840" stroke="#E4E9F0" stroke-width="2"/>
<text x="88" y="918" font-size="32" font-weight="800" fill="#253247">建议</text>
${suggestionBlocks}
<rect x="88" y="1410" width="1024" height="92" rx="20" fill="#F7F9FC"/>
<text x="116" y="1448" font-size="20" fill="#66758A">${escapeXml(report.privacy)}</text>
<text x="116" y="1480" font-size="20" fill="#66758A">${escapeXml(report.limitation)}</text>
</svg>`;
}
export async function generateWifiHealthReport() {
    const status = await wifiGetStatus();
    if ((status.status === "error" || status.status === "permission_denied") && !status.data) {
        return { envelope: withoutReportData(status), svg: null };
    }
    const diagnosis = await wifiDiagnoseFromStatus(status);
    if (!status.data || !diagnosis.data) {
        return { envelope: withoutReportData(diagnosis), svg: null };
    }
    const data = buildWifiReportData(status.data, diagnosis.data);
    const warnings = [...new Set([...status.warnings, ...diagnosis.warnings])];
    const envelope = success(data, warnings);
    return { envelope, svg: renderWifiReportSvg(data, envelope.collected_at) };
}
//# sourceMappingURL=wifi-report.js.map
