import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { wifiDiagnoseFromStatus, wifiGetStatus } from "../device/collector.js";
import { networkMonitorFromStatus } from "./network-monitor.js";
import { failure, success } from "../../shared/result.js";
import { PKG_ROOT } from "../../shared/paths.js";
import { buildWifiReportData } from "./report.js";
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[character] ?? character);
}
function formatRate(bytesPerSecond) {
    const mbps = bytesPerSecond * 8 / 1_000_000;
    return `${mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2)} Mbps`;
}
function stateClass(state) {
    return state === "good" ? "good" : state === "warning" ? "warning" : state === "bad" ? "bad" : "unknown";
}
export function renderWifiHtmlReport(report, monitor, collectedAt) {
    const samplesJson = JSON.stringify(monitor.samples).replace(/</g, "\\u003c");
    const chainHtml = report.chain.map((item, index) => `${index > 0 ? '<div class="connector"></div>' : ""}<div class="chain-item"><div class="chain-dot ${stateClass(item.state)}">${item.state === "good" ? "✓" : item.state === "bad" ? "!" : item.state === "warning" ? "△" : "?"}</div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail)}</span></div>`).join("");
    const suggestions = report.suggestions.map((item, index) => `<li><span>${index + 1}</span><p>${escapeHtml(item)}</p></li>`).join("");
    const signal = report.metrics.signal_percent === null ? "未知" : `${Math.round(report.metrics.signal_percent)}%`;
    const latency = monitor.summary.average_latency_ms === null ? "未知" : `${monitor.summary.average_latency_ms} ms`;
    const jitter = monitor.summary.jitter_ms === null ? "未知" : `${monitor.summary.jitter_ms} ms`;
    const loss = monitor.summary.packet_loss_percent === null ? "未知" : `${monitor.summary.packet_loss_percent}%`;
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wi-Fi 网络动态体检报告</title>
<style>
:root{--ink:#1e2a3b;--muted:#738197;--line:#e2e8f0;--panel:#fff;--bg:#edf2f8;--good:#0fa47d;--warn:#d99000;--bad:#d94a4a;--blue:#3d75e6;--purple:#8b5cf6}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#edf3fa,#e4eaf2);color:var(--ink);font-family:"Microsoft YaHei","Segoe UI",sans-serif}main{width:min(1180px,calc(100% - 32px));margin:28px auto 48px}.shell{background:rgba(255,255,255,.95);border:1px solid rgba(255,255,255,.8);border-radius:32px;box-shadow:0 24px 70px rgba(37,50,71,.12);padding:42px}.eyebrow{color:var(--blue);font-weight:700;letter-spacing:.08em}h1{font-size:42px;margin:8px 0 10px}.meta{color:var(--muted)}.hero{margin-top:28px;border-radius:24px;padding:26px 30px;background:${report.overall_status === "normal" ? "#e8f7f2" : report.overall_status === "attention" ? "#fff4d6" : "#fdecec"};display:flex;gap:22px;align-items:center}.hero-icon{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;background:${report.overall_status === "normal" ? "var(--good)" : report.overall_status === "attention" ? "var(--warn)" : "var(--bad)"};color:#fff;font-size:32px}.hero h2{margin:0 0 8px}.hero p{margin:0;color:#425069}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:24px 0}.metric{background:#f7f9fc;border:1px solid #edf1f6;border-radius:18px;padding:20px}.metric span{display:block;color:var(--muted);font-size:14px}.metric strong{display:block;font-size:25px;margin-top:8px}.section{margin-top:30px}.section-head{display:flex;align-items:end;justify-content:space-between;gap:18px}.section h2{font-size:25px;margin:0}.section-note{color:var(--muted);font-size:14px}.chart-grid{display:grid;grid-template-columns:2fr 1fr;gap:18px;margin-top:16px}.chart-card{border:1px solid var(--line);border-radius:22px;padding:20px;background:#fff}.chart-card h3{margin:0 0 6px}.legend{display:flex;gap:16px;color:var(--muted);font-size:13px}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}.canvas-wrap{height:270px;margin-top:14px}canvas{width:100%;height:100%}.chain{display:flex;align-items:flex-start;justify-content:space-between;margin-top:18px;padding:26px 10px 8px}.chain-item{width:128px;text-align:center;display:flex;flex-direction:column;align-items:center}.chain-item strong{margin-top:10px}.chain-item span{font-size:13px;color:var(--muted);margin-top:5px}.chain-dot{width:54px;height:54px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:24px}.good{background:var(--good)}.warning{background:var(--warn)}.bad{background:var(--bad)}.unknown{background:#8491a5}.connector{height:6px;background:#d7dee8;border-radius:8px;flex:1;margin:25px -12px 0}.suggestions{list-style:none;padding:0;margin:16px 0 0;display:grid;gap:12px}.suggestions li{display:flex;gap:14px;align-items:flex-start;background:#f7f9fc;border-radius:16px;padding:15px}.suggestions li span{flex:0 0 30px;height:30px;border-radius:50%;background:var(--good);color:#fff;display:grid;place-items:center}.suggestions p{margin:3px 0;line-height:1.6}.footer{margin-top:28px;padding:18px 20px;border-radius:16px;background:#f7f9fc;color:var(--muted);font-size:13px;line-height:1.7}@media(max-width:800px){.shell{padding:24px}.metrics{grid-template-columns:1fr 1fr}.chart-grid{grid-template-columns:1fr}.chain{overflow-x:auto;justify-content:flex-start}.chain-item{flex:0 0 120px}.connector{flex:0 0 50px}h1{font-size:32px}}
</style>
</head>
<body><main><article class="shell">
<div class="eyebrow">XIANGBANGBANG · DEVICE REPORT</div><h1>Wi-Fi 网络动态体检</h1><div class="meta">检测时间 ${escapeHtml(new Date(collectedAt).toLocaleString("zh-CN", { hour12: false }))} · ${monitor.duration_seconds} 秒真实采样 · 网络名称已隐藏</div>
<section class="hero"><div class="hero-icon">${report.overall_status === "normal" ? "✓" : "!"}</div><div><h2>${escapeHtml(report.overall_label)}</h2><p>${escapeHtml(report.summary)}</p></div></section>
<section class="metrics"><div class="metric"><span>Wi-Fi 信号</span><strong>${escapeHtml(signal)}</strong></div><div class="metric"><span>平均下载吞吐</span><strong>${formatRate(monitor.summary.average_download_bytes_per_second)}</strong></div><div class="metric"><span>平均上传吞吐</span><strong>${formatRate(monitor.summary.average_upload_bytes_per_second)}</strong></div><div class="metric"><span>平均网关延迟</span><strong>${escapeHtml(latency)}</strong></div></section>
<section class="section"><div class="section-head"><div><h2>网络波动</h2><div class="section-note">网卡实际吞吐，不等同于宽带测速</div></div><div class="legend"><span><i style="background:var(--blue)"></i>下载</span><span><i style="background:var(--purple)"></i>上传</span></div></div><div class="chart-grid"><div class="chart-card"><h3>上传 / 下载</h3><div class="canvas-wrap"><canvas id="traffic"></canvas></div></div><div class="chart-card"><h3>网关延迟</h3><div class="section-note">抖动 ${escapeHtml(jitter)} · 丢包 ${escapeHtml(loss)}</div><div class="canvas-wrap"><canvas id="latency"></canvas></div></div></div></section>
<section class="section"><h2>诊断链路</h2><div class="chain">${chainHtml}</div></section>
<section class="section"><h2>建议</h2><ol class="suggestions">${suggestions}</ol></section>
<footer class="footer">${escapeHtml(report.privacy)}<br>${escapeHtml(report.limitation)}<br>吞吐曲线只表示检测期间该 Wi-Fi 网卡的收发变化，没有主动下载测试文件，也不会消耗测速流量。</footer>
</article></main>
<script>
const samples=${samplesJson};
function setup(canvas){const rect=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1;canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;const c=canvas.getContext('2d');c.scale(dpr,dpr);return{c,w:rect.width,h:rect.height}}
function lineChart(id,series,formatter,minMax=1){const {c,w,h}=setup(document.getElementById(id)),pad={l:48,r:16,t:18,b:30},iw=w-pad.l-pad.r,ih=h-pad.t-pad.b;const values=series.flatMap(s=>s.values.filter(v=>v!==null));const max=Math.max(minMax,...values)*1.12;c.strokeStyle='#e7ecf2';c.fillStyle='#7b8798';c.font='12px Segoe UI';for(let i=0;i<=4;i++){const y=pad.t+ih*i/4;c.beginPath();c.moveTo(pad.l,y);c.lineTo(w-pad.r,y);c.stroke();c.fillText(formatter(max*(1-i/4)),4,y+4)}series.forEach(s=>{c.strokeStyle=s.color;c.lineWidth=2.5;c.beginPath();let open=false;s.values.forEach((v,i)=>{if(v===null){open=false;return}const x=pad.l+(series[0].values.length<=1?0:i/(series[0].values.length-1))*iw,y=pad.t+ih-(v/max)*ih;if(!open){c.moveTo(x,y);open=true}else c.lineTo(x,y)});c.stroke()});c.fillStyle='#7b8798';c.fillText('0s',pad.l,h-7);c.fillText('${monitor.duration_seconds}s',w-pad.r-26,h-7)}
const down=samples.map(s=>s.download_bytes_per_second*8/1e6),up=samples.map(s=>s.upload_bytes_per_second*8/1e6),lat=samples.map(s=>s.latency_ms);
lineChart('traffic',[{values:down,color:'#3d75e6'},{values:up,color:'#8b5cf6'}],v=>v.toFixed(v>=10?0:v>=1?1:2)+'M',.01);lineChart('latency',[{values:lat,color:'#0fa47d'}],v=>Math.round(v)+'ms');
</script></body></html>`;
}
export async function generateWifiHtmlReport(durationSeconds) {
    const status = await wifiGetStatus();
    const [diagnosis, monitor] = await Promise.all([
        wifiDiagnoseFromStatus(status),
        networkMonitorFromStatus(status, durationSeconds),
    ]);
    if (!status.data || !diagnosis.data || !monitor.data || monitor.status === "error") {
        const source = monitor.status === "error" ? monitor : diagnosis;
        return {
            envelope: failure(source.status === "permission_denied" ? "permission_denied" : "error", source.error?.code ?? "report_data_unavailable", source.error?.message ?? "生成报告所需的数据不完整。"),
            filePath: null,
            fileUri: null,
        };
    }
    const report = buildWifiReportData(status.data, diagnosis.data);
    const collectedAt = new Date().toISOString();
    const html = renderWifiHtmlReport(report, monitor.data, collectedAt);
    const reportDirectory = path.join(PKG_ROOT, "reports");
    const filePath = path.join(reportDirectory, "wifi-network-report.html");
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(filePath, html, "utf8");
    const fileUri = pathToFileURL(filePath).href;
    const data = {
        file_path: filePath,
        file_uri: fileUri,
        duration_seconds: monitor.data.duration_seconds,
        sample_count: monitor.data.sample_count,
        overall_status: report.overall_status,
        overall_label: report.overall_label,
        summary: monitor.data.summary,
        privacy: report.privacy,
    };
    return {
        envelope: success(data, [...new Set([...status.warnings, ...diagnosis.warnings, ...monitor.warnings])]),
        filePath,
        fileUri,
    };
}
//# sourceMappingURL=wifi-html-report.js.map
