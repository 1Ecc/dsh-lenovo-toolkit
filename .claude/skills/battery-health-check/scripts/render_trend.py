#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
容量衰减趋势图渲染器（输出 SVG，浏览器直接打开）

用法：
  python3 render_trend.py --metrics <metrics.env> [--history <history.tsv>] --out <trend.svg>

两种横轴模式，脚本自动选：
  * date   —— 历史点 >= 3 且跨度 >= 14 天时用日期轴。Windows 的 powercfg 自带数周历史，
              通常直接走这条；mac 多次运行攒够快照后也会切过来。
  * cycles —— 否则用循环次数轴。单次检测（mac 首跑）只有一个实测点，
              这时靠"设计规格线 + 从实测点外推"来表达趋势。

两条设计红线，改代码时请守住：

1. 实测点和推算线必须肉眼可分（实心圆点 + 实线 vs 空心 + 虚线）。这张图会同时给
   服务顾问和客户看，把模型推算误读成历史实测会直接变成投诉。

2. 单点外推不给单一确定值。系统口径和电量计口径经常差好几个百分点（Apple Silicon
   尤其明显），各自外推的结果能差几百次循环。这时画成"推算区间"的楔形带，
   而不是一条看着很确定的线——否则一台其实很健康的机器会被画成马上要换电池，
   这种图拿去做服务推荐就是自毁信任。

只用标准库，不依赖 matplotlib。
"""

import argparse
import datetime as dt
import os
import sys
from xml.sax.saxutils import escape

W, H = 940, 620
PAD_L, PAD_R, PAD_T, PAD_B = 78, 44, 118, 150
PX0, PX1 = PAD_L, W - PAD_R
PY0, PY1 = PAD_T, H - PAD_B

REPLACE_LINE = 80.0  # 行业通行的"建议更换"阈值：满充容量降到设计容量的 80%
DIVERGE_PP = 3.0     # 两种口径差多少个百分点算"显著不一致"，需要分开画


# ---------------------------------------------------------------- 数据读入

def read_metrics(path):
    m = {}
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            m[k.strip()] = v.strip()
    return m


def read_history(path):
    """返回 [{date, cycles, fcc, design, health_os, health_raw}]，脏行直接跳过。"""
    rows = []
    if not path or not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8-sig") as f:
        header = None
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if header is None:
                header = parts
                continue
            if len(parts) < 6:
                continue
            r = dict(zip(header, parts))
            try:
                d = dt.date.fromisoformat(r.get("date", "").strip())
            except ValueError:
                continue
            rows.append({
                "date": d,
                "cycles": _num(r.get("cycles")),
                "fcc": _num(r.get("fcc_mah")),
                "design": _num(r.get("design_mah")),
                "health_os": _num(r.get("health_os")),
                "health_raw": _num(r.get("health_raw")),
            })
    rows.sort(key=lambda r: r["date"])
    return rows


def _num(s):
    if s is None:
        return None
    s = str(s).strip().replace("%", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


# ---------------------------------------------------------------- 数学

def ols(points):
    """最小二乘拟合 y = a + b*x，点数不足或 x 无变化时返回 None。"""
    pts = [(x, y) for x, y in points if x is not None and y is not None]
    n = len(pts)
    if n < 2:
        return None
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    sxx = sum((p[0] - mx) ** 2 for p in pts)
    if sxx <= 1e-9:
        return None
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
    b = sxy / sxx
    return my - b * mx, b


def spec_curve(cycles, design_cycles):
    """厂商规格参考线：设计循环次数走完时刚好衰减到 80%。

    锂电池实际是"前期慢、后期快"，纯直线会低估早期健康度，所以用一个轻微上凸的
    幂函数近似。这条线只是参考坐标，不是承诺值。
    """
    if not design_cycles or design_cycles <= 0:
        return None
    t = max(0.0, min(1.6, cycles / design_cycles))
    return 100.0 - 20.0 * (t ** 0.82)


# ---------------------------------------------------------------- SVG 基础件

def sc(v, lo, hi, a, b):
    if hi - lo < 1e-9:
        return (a + b) / 2
    return a + (v - lo) * (b - a) / (hi - lo)


def txt(x, y, s, cls="", anchor="start", extra=""):
    return ('<text x="%.1f" y="%.1f" class="%s" text-anchor="%s" %s>%s</text>'
            % (x, y, cls, anchor, extra, escape(str(s))))


STYLE = """
:root{
  --bg:#ffffff; --panel:#f7f9fc; --ink:#16202b; --muted:#5c6b7a; --grid:#e3e8ee;
  --axis:#aab4c0; --actual:#1b6ef3; --alt:#0f9d8f; --wedge:rgba(27,110,243,.13);
  --spec:#8b97a6; --danger:#e2231a;
  --band-ok:rgba(17,143,90,.07); --band-warn:rgba(214,150,18,.09); --band-bad:rgba(226,35,26,.08);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#12161c; --panel:#1a2029; --ink:#e8edf3; --muted:#9aa7b5; --grid:#28313d;
    --axis:#4a5765; --actual:#5b9dff; --alt:#3fc8b6; --wedge:rgba(91,157,255,.17);
    --spec:#7d8b9b; --danger:#ff6b60;
    --band-ok:rgba(62,201,139,.08); --band-warn:rgba(240,180,60,.1); --band-bad:rgba(255,107,96,.1);
  }
}
.bg{fill:var(--bg)}
.title{fill:var(--ink);font:600 21px -apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif}
.sub{fill:var(--muted);font:13px -apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif}
.axis{fill:var(--muted);font:12px -apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif}
.note{fill:var(--muted);font:12px -apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif}
.lbl{fill:var(--ink);font:12px -apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif}
.lbl-b{fill:var(--ink);font:600 13px -apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif}
.danger{fill:var(--danger);font:600 12px -apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif}
.grid{stroke:var(--grid);stroke-width:1}
.spec{stroke:var(--spec);stroke-width:2;fill:none;stroke-dasharray:7 5;opacity:.85}
.actual{stroke:var(--actual);stroke-width:2.6;fill:none;stroke-linecap:round;stroke-linejoin:round}
.actual-alt{stroke:var(--alt);stroke-width:2.2;fill:none;stroke-linecap:round;stroke-linejoin:round}
.proj{stroke:var(--actual);stroke-width:1.8;fill:none;stroke-dasharray:3 5;opacity:.8}
.proj-alt{stroke:var(--alt);stroke-width:1.8;fill:none;stroke-dasharray:3 5;opacity:.8}
.wedge{fill:var(--wedge);stroke:none}
.dot{fill:var(--actual);stroke:var(--bg);stroke-width:2}
.dot-alt{fill:var(--alt);stroke:var(--bg);stroke-width:2}
.thresh{stroke:var(--danger);stroke-width:1.6;stroke-dasharray:6 4;opacity:.9}
.callout{fill:var(--panel);stroke:var(--grid);stroke-width:1}
"""


# ---------------------------------------------------------------- 主渲染

def render(metrics, history, out_path):
    dev = metrics.get("device_model") or metrics.get("device_model_identifier") or "未知机型"
    dev_id = metrics.get("device_model_identifier", "")
    vendor = metrics.get("device_vendor", "")
    bat = metrics.get("battery_model", "")
    unit = metrics.get("capacity_unit", "mAh")
    design_mah = _num(metrics.get("design_capacity_mah"))
    fcc_mah = _num(metrics.get("full_charge_capacity_mah"))
    h_os = _num(metrics.get("health_pct_os"))
    h_raw = _num(metrics.get("health_pct_raw"))
    cycles = _num(metrics.get("cycle_count"))
    design_cycles = _num(metrics.get("design_cycle_count")) or 1000.0
    collected = (metrics.get("collected_at") or "")[:10]

    if h_os is None and h_raw is None and design_mah and fcc_mah:
        h_raw = fcc_mah * 100.0 / design_mah
    # 系统口径优先展示：这是客户在系统设置里能自己看到的数字，对话必须对得上
    health_now = h_os if h_os is not None else h_raw
    diverged = (h_os is not None and h_raw is not None and abs(h_os - h_raw) >= DIVERGE_PP)

    usable = [r for r in history if (r["health_os"] is not None or r["health_raw"] is not None)]
    span_days = (usable[-1]["date"] - usable[0]["date"]).days if len(usable) >= 2 else 0
    date_mode = len(usable) >= 3 and span_days >= 14

    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
             'viewBox="0 0 %d %d" font-family="sans-serif">' % (W, H, W, H),
             "<style>%s</style>" % STYLE,
             '<rect class="bg" x="0" y="0" width="%d" height="%d"/>' % (W, H)]

    # ---- 标题 ----
    parts.append(txt(PAD_L - 6, 40, "电池容量衰减趋势", "title"))
    sub1 = " · ".join(x for x in [
        ("%s %s" % (vendor, dev)).strip(),
        ("(%s)" % dev_id) if dev_id and dev_id != dev else "",
        ("电池 %s" % bat) if bat else "",
    ] if x)
    parts.append(txt(PAD_L - 6, 62, sub1, "sub"))
    parts.append(txt(PAD_L - 6, 81, " · ".join(x for x in [
        ("设计容量 %.0f %s / 当前满充 %.0f %s" % (design_mah, unit, fcc_mah, unit))
        if (design_mah and fcc_mah) else "",
        ("循环 %.0f 次" % cycles) if cycles is not None else "",
        ("检测于 %s" % collected) if collected else "",
    ] if x), "sub"))

    # ---- Y 轴范围 ----
    ys = [v for v in [h_os, h_raw] if v is not None]
    for r in usable:
        ys += [v for v in (r["health_os"], r["health_raw"]) if v is not None]
    ymin = max(40.0, min(min([75.0] + ys) - 4, 78.0))
    ymax = 102.0

    def Y(v):
        return sc(v, ymin, ymax, PY1, PY0)

    def Yc(v):
        return Y(min(ymax, max(ymin, v)))

    # ---- X 轴范围 ----
    if date_mode:
        d0 = usable[0]["date"]
        xmin, xmax = 0.0, float(max(span_days, 30)) * 1.45

        def to_x(row):
            return float((row["date"] - d0).days)
        x_axis_title = "时间"
    else:
        xmin = 0.0
        xmax = max(design_cycles, (cycles or 0) * 2.2, 300.0)

        def to_x(row):
            return row["cycles"]
        x_axis_title = "充电循环次数"

    def X(v):
        return sc(v, xmin, xmax, PX0, PX1)

    # ---- 健康度分区底色 ----
    for lo, hi, cls in ((max(ymin, 90), ymax, "band-ok"),
                        (max(ymin, 80), 90, "band-warn"),
                        (ymin, 80, "band-bad")):
        if hi > lo:
            parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="var(--%s)"/>'
                         % (PX0, Y(hi), PX1 - PX0, Y(lo) - Y(hi), cls))

    # ---- 网格 + Y 刻度 ----
    tick = 5 if (ymax - ymin) <= 32 else 10
    v = int(ymin // tick) * tick
    while v <= ymax:
        if v >= ymin:
            parts.append('<line class="grid" x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f"/>'
                         % (PX0, Y(v), PX1, Y(v)))
            parts.append(txt(PX0 - 10, Y(v) + 4, "%d%%" % v, "axis", "end"))
        v += tick
    parts.append(txt(PX0 - 10, PY0 - 14, "健康度", "axis", "end"))

    # ---- X 刻度 ----
    if date_mode:
        for i in range(7):
            xv = xmin + (xmax - xmin) * i / 6
            px = X(xv)
            parts.append('<line class="grid" x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f"/>'
                         % (px, PY0, px, PY1))
            parts.append(txt(px, PY1 + 20,
                             (d0 + dt.timedelta(days=int(round(xv)))).strftime("%y-%m-%d"),
                             "axis", "middle"))
    else:
        step = 100.0
        while (xmax - xmin) / step > 11:
            step *= 2
        xv = 0.0
        while xv <= xmax:
            px = X(xv)
            parts.append('<line class="grid" x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f"/>'
                         % (px, PY0, px, PY1))
            parts.append(txt(px, PY1 + 20, "%d" % xv, "axis", "middle"))
            xv += step
    parts.append(txt((PX0 + PX1) / 2, PY1 + 42, x_axis_title, "axis", "middle"))

    # ---- 80% 更换建议线 ----
    if ymin < REPLACE_LINE < ymax:
        parts.append('<line class="thresh" x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f"/>'
                     % (PX0, Y(REPLACE_LINE), PX1, Y(REPLACE_LINE)))
        parts.append(txt(PX1 - 4, Y(REPLACE_LINE) - 7, "80% 建议更换线", "danger", "end"))

    # ---- 厂商规格参考线（只在循环次数轴上画，日期轴没法把规格换算成天）----
    if not date_mode and design_cycles:
        pts, c = [], 0.0
        while c <= xmax:
            sv = spec_curve(c, design_cycles)
            if sv is not None and sv >= ymin - 2:
                pts.append("%.1f,%.1f" % (X(c), Yc(sv)))
            c += xmax / 90.0
        if len(pts) > 1:
            parts.append('<polyline class="spec" points="%s"/>' % " ".join(pts))
            cm = xmax * 0.6
            sv = spec_curve(cm, design_cycles)
            if sv is not None:
                parts.append(txt(X(cm), Y(sv) - 9,
                                 "厂商规格参考（%.0f 次循环 → 80%%）" % design_cycles, "axis", "middle"))

    # ---- 组织实测序列 ----
    def build(key, fallback_now):
        s = []
        for row in usable:
            xv, yv = to_x(row), row[key]
            if xv is not None and yv is not None:
                s.append((xv, yv))
        if not s and fallback_now is not None:
            s = [((0.0 if date_mode else (cycles or 0.0)), fallback_now)]
        s.sort()
        return s

    s_os = build("health_os", h_os)
    s_raw = build("health_raw", h_raw) if diverged else []
    primary = s_os or s_raw

    def project(series):
        """返回 (a, b, x_at_80)；斜率非负或数据不足则返回 None。"""
        fit_pts = ([(0.0, 100.0)] if not date_mode else []) + series
        f = ols(fit_pts)
        if not f or f[1] >= -1e-6:
            return None
        a, b = f
        return a, b, (REPLACE_LINE - a) / b

    p_main = project(primary) if primary else None
    p_alt = project(s_raw) if s_raw else None

    # 已经跌破 80% 的电池不存在"什么时候会跌破"这个问题。不拦住的话，
    # 回归线会把过去的穿越点当成未来预测播报出去（"预计 2026 年 6 月触及更换线"，
    # 而那个月份早就过了），在客户面前是硬伤。
    already_below = bool(primary) and primary[-1][1] <= REPLACE_LINE

    # ---- 推算楔形带（两种口径分歧较大时，把不确定性画出来而不是假装很确定）----
    note_lines = []
    drew_proj = False
    last_x = max(x for x, _ in primary) if primary else 0.0
    if p_main and p_alt and not already_below:
        lo_pts, hi_pts, x = [], [], last_x
        stepx = max((xmax - last_x) / 60.0, 1e-6)
        while x <= xmax + 1e-9:
            ya = p_main[0] + p_main[1] * x
            yb = p_alt[0] + p_alt[1] * x
            if max(ya, yb) < REPLACE_LINE:
                break
            # 楔形带在 80% 处收口。过了更换线以后的外推没有决策价值，
            # 让色块一路铺到图底只会把注意力从"什么时候该换"上带偏。
            lo_pts.append("%.1f,%.1f" % (X(x), Yc(max(min(ya, yb), REPLACE_LINE))))
            hi_pts.append("%.1f,%.1f" % (X(x), Yc(max(ya, yb))))
            x += stepx
        if len(lo_pts) > 1:
            parts.append('<polygon class="wedge" points="%s"/>'
                         % " ".join(hi_pts + list(reversed(lo_pts))))

    for pr, cls in ((p_main, "proj"), (p_alt, "proj-alt")):
        if not pr or already_below:
            continue
        a, b, x80 = pr
        x_end = min(max(x80, last_x), xmax)
        if x_end > last_x:
            parts.append('<line class="%s" x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f"/>'
                         % (cls, X(last_x), Yc(a + b * last_x), X(x_end), Yc(a + b * x_end)))
            drew_proj = True
        if last_x < x80 <= xmax:
            parts.append('<circle cx="%.1f" cy="%.1f" r="4" fill="none" stroke="var(--danger)" '
                         'stroke-width="2"/>' % (X(x80), Y(REPLACE_LINE)))

    # ---- 实测线与点 ----
    for s, lcls, dcls in ((s_raw, "actual-alt", "dot-alt"), (s_os, "actual", "dot")):
        if len(s) > 1:
            parts.append('<polyline class="%s" points="%s"/>'
                         % (lcls, " ".join("%.1f,%.1f" % (X(x), Yc(y)) for x, y in s)))
        for x, y in s:
            parts.append('<circle class="%s" cx="%.1f" cy="%.1f" r="4.5"/>' % (dcls, X(x), Yc(y)))

    # ---- 推算结论文字 ----
    x80s = sorted(p[2] for p in (p_main, p_alt) if p)
    if date_mode:
        fmt = lambda v: (d0 + dt.timedelta(days=int(round(v)))).strftime("%Y 年 %m 月")
        unit_word = ""
    else:
        fmt = lambda v: "%.0f" % v
        unit_word = " 次循环"
    if already_below:
        crossed = [v for v in x80s if v <= last_x]
        if crossed:
            note_lines.append("已跌破 80%% 更换线，约在 %s%s 越过" % (fmt(max(crossed)), unit_word))
        else:
            note_lines.append("当前健康度已在 80% 更换线以下")
    elif x80s:
        if len(x80s) > 1 and abs(x80s[1] - x80s[0]) > (1e-6 + 0.02 * max(abs(x80s[1]), 1)):
            note_lines.append("触及 80%% 更换线的推算区间：约 %s ~ %s%s（两种口径分别外推）"
                              % (fmt(x80s[0]), fmt(x80s[-1]), unit_word))
        else:
            note_lines.append("按当前速率推算，约 %s%s 触及 80%% 更换线" % (fmt(x80s[0]), unit_word))

    if diverged:
        note_lines.append("系统口径 %.0f%% 与电量计实测 %.1f%% 相差 %.1f 个百分点，"
                          "两者含义不同，请看报告解读" % (h_os, h_raw, abs(h_os - h_raw)))
    if len(usable) < 2:
        note_lines.append("当前仅 1 个实测点，趋势线为模型推算而非历史实测；"
                          "重复运行本检测会持续累积真实历史点")

    # ---- 当前值标注 ----
    if primary:
        cx, cy = primary[-1]
        px, py = X(cx), Yc(cy)
        bw, bh = (168, 62) if diverged else (132, 46)
        bx = min(max(px + 14, PX0 + 4), PX1 - bw - 4)
        by = max(PY0 + 4, py - bh - 14)
        parts.append('<rect class="callout" x="%.1f" y="%.1f" width="%d" height="%d" rx="7"/>'
                     % (bx, by, bw, bh))
        parts.append(txt(bx + 11, by + 21, "当前 %.0f%%" % cy, "lbl-b"))
        parts.append(txt(bx + 11, by + 38,
                         ("循环 %.0f 次" % cycles) if cycles is not None else collected, "lbl"))
        if diverged:
            parts.append(txt(bx + 11, by + 54, "电量计实测 %.1f%%" % h_raw, "lbl"))

    # ---- 图例 ----
    lx, ly = PX0, PY1 + 74
    def legend(cls, label, dot=None):
        nonlocal lx
        parts.append('<line class="%s" x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f"/>' % (cls, lx, ly, lx + 26, ly))
        if dot:
            parts.append('<circle class="%s" cx="%.1f" cy="%.1f" r="4"/>' % (dot, lx + 13, ly))
        parts.append(txt(lx + 33, ly + 4, label, "axis"))
        lx += 36 + len(label) * 12

    legend("actual", "系统口径实测" if diverged else "实测", "dot")
    if diverged:
        legend("actual-alt", "电量计实测", "dot-alt")
    if drew_proj:  # 没画推算线就不要放图例，图例里出现图上找不到的东西比少一项更糟
        legend("proj", "推算")
    if not date_mode:
        legend("spec", "厂商规格参考")
    legend("thresh", "80% 更换线")

    # ---- 备注 ----
    for i, n in enumerate(note_lines[:3]):
        parts.append(txt(PX0, PY1 + 100 + i * 17, "· " + n, "note"))

    parts.append("</svg>")

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))
    return out_path


def main():
    ap = argparse.ArgumentParser(description="渲染电池容量衰减趋势 SVG")
    ap.add_argument("--metrics", required=True, help="collect_*.sh/ps1 产出的 metrics.env")
    ap.add_argument("--history", default=None, help="history.tsv；不传则用 metrics 里的 history_file")
    ap.add_argument("--out", required=True, help="输出 SVG 路径")
    args = ap.parse_args()

    if not os.path.exists(args.metrics):
        print("找不到 metrics 文件: %s" % args.metrics, file=sys.stderr)
        return 1
    m = read_metrics(args.metrics)
    render(m, read_history(args.history or m.get("history_file")), args.out)
    print(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
