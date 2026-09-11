# dsh-lenovo-toolkit

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**联想专业工具集**。
把联想服务体系里的专业判断能力——硬件诊断、备件、保修、服务网点——做成通用 agent 平台上可安装的插件。

当前状态：**试点阶段**。共 **7 个能力域 / 21 个 DSH 工具 / 9 个 skill**——电池跨 macOS 与 Windows，其余六个能力域（设备、性能、存储、应用、Wi-Fi、受控操作）仅支持 Windows，**等待真实 DSH 运行时验证**。

> **归属说明（待确认）**
> 本仓库由联想服务团队成员维护，属于**试点性质的探索项目**，不代表联想官方发布，
> 亦未经联想品牌方审阅。仓库中引用的联想服务入口与商品链接均为公开页面。
> 如需正式化，应迁至 Lenovo 组织下并补充官方声明。

---

## 目录

- [这是什么](#这是什么)
- [工具组](#工具组)
- [安装与使用](#安装与使用)
- [仓库结构](#仓库结构)
- [文档](#文档)
- [已知待办](#已知待办)

---

## 这是什么

正面抢占通用 agent 平台在现阶段极为困难，但平台之上的**公共技能／插件生态**准入门槛很低，
且与联想的存量专业能力天然契合。这个仓库是这条路径的第一个验证载体。

完整的判断、要验证的假设与指标见 **[docs/vision.md](docs/vision.md)**。

仓库定位是**一个容器**，不是单个工具。每类专业能力是一个工具组，
加新工具组 = 加两个目录 + 在插件入口的 `GROUPS` 里加一行。

同一套能力有两种交付形态，**互补而非二选一**：

| | Skill | Plugin |
|---|---|---|
| 管什么 | 怎么判读、怎么写报告、什么时候推荐 | 确定性地跑脚本、返回结构化结果 |
| 形态 | `SKILL.md` + references + scripts | ESM 模块，导出 `apply(ctx)` |
| 安装 | 放进 skills 目录即被发现 | `dsh plugin add` |
| 作用域 | 支持项目级 | profile 级 |

---

## 工具组

### 🔋 电池健康检测

跨平台电池体检：容量、循环次数、双口径健康度、SVG 衰减趋势图、系统官方电池报告，
以及基于结论触发的服务推荐。

| 工具 | 作用 |
|---|---|
| `battery_health_collect` | 采集并解析出结构化 metrics，生成官方报告与历史快照 |
| `battery_health_trend` | 渲染容量衰减趋势 SVG |
| `battery_health_rules` | 取判读规则文档，避免模型凭印象下结论 |

第三个工具的存在是为了让**只装了 Plugin 没装 Skill 的用户也能拿到判读标准**，
否则模型会拿着一堆数字自由发挥，而判读规则正是这个项目最不该被绕过的部分。

详见 **[docs/tools/battery.md](docs/tools/battery.md)**。

### Windows 设备助手（6 个能力域，14 个工具）

从想帮帮 Device MCP 迁入，保持原来的结构化状态、隐私最小化和操作确认边界。
**当前仅支持 Windows。**

| 能力域 | 工具 | 回答什么 |
|---|---|---|
| `device` | `device_get_info` | 这台机器是什么配置 |
| `performance` | `performance_get_status` · `process_list` | 怎么这么卡 |
| `storage` | `storage_get_status` | 盘是不是满了 |
| `app` | `app_list` | 装没装某某软件 |
| `wifi` | `wifi_get_status` · `wifi_diagnose` · `network_monitor` · `wifi_generate_report` · `wifi_generate_html_report` | 网怎么这么慢／连不上，并出脱敏体检报告 |
| `actions` | `open_system_settings` · `open_app` · `open_url` · `copy_diagnostic_report` | 唯一会改变机器状态的一组，**每次调用都要用户明确确认** |

逐项契约、隐私边界与判读纪律见 **[docs/tools/](docs/tools/README.md)**。

### 计划中

- 更深层硬件诊断（SMART、散热、电源适配器等）
- 知识检索路径（服务知识库、保修政策、备件价格）

---

## 安装与使用

### 作为 DSH 插件

```bash
dsh plugin --profile web add github:1Ecc/dsh-lenovo-toolkit
```

装完重启 `dsh web` 并刷新页面。插件包内自带 skill 资源，不额外装 skill 也能工作。

### 作为 DSH 项目级 skill

克隆本仓库后，`.dsh/skills/` 下的目录就是 DSH 的项目级 skill（优先级 100，
扫描 `.dsh/skills/` 且**只扫顶层不递归**）。在该项目目录下启动 dsh 即可，
或用 `/battery-health-check` 手动触发。

### 作为 Claude Code skill

`.claude/skills/` 下是同一份内容的副本。想全局可用就软链到用户级目录：

```bash
ln -s "$(pwd)/.claude/skills/battery-health-check" ~/.claude/skills/battery-health-check
```

触发方式：直接说「帮我看下电池健康度」「电脑越来越不耐用了」「电池还能用多久」即可。

### 开发

```bash
npm test              # 单元 + 真实采集的集成测试
npm run sync-skill    # .dsh/skills → .claude/skills
```

---

## 仓库结构

```
├── package.json                    dsh.bundle 声明（可被 dsh plugin add 安装的凭证）
├── cordis.patch.yml                DSH 安装时应用的 cordis 配置补丁
│
├── src/
│   ├── index.js                    插件入口：聚合注册各工具组
│   ├── shared/                     跨工具组复用：错误类型、包内资源定位
│   └── tools/                      一个子目录 = 一个能力域，各含 collector.js + register.js
│       ├── battery/                电池采集、趋势与规则（唯一跨平台的一组）
│       ├── device/                 设备概况
│       ├── performance/            性能与进程
│       ├── storage/                存储空间
│       ├── app/                    已安装应用查询
│       ├── wifi/                   Wi-Fi 诊断、监测与脱敏报告
│       └── actions/                需逐次确认的低风险操作
│
├── test/
│   ├── repo.test.js                仓库一致性守卫（含能力域框架守卫）
│   ├── helpers/                    跨组复用的断言
│   └── tools/<能力域>.test.js       每个能力域一份，与 src/tools/ 一一对应
│
├── .dsh/skills/                    ← DSH skill 加载路径（唯一事实来源，共 9 个）
│   ├── xiangbangbang-device-assistant/  总路由：在其余 skill 之间选最少的那个
│   ├── battery-health-check/       电池（唯一跨平台的一个）
│   │   ├── SKILL.md                流程编排与报告模板
│   │   ├── scripts/                平台采集脚本（零依赖）+ 趋势图渲染
│   │   └── references/             判读规则、推荐策略、平台笔记
│   ├── device-overview/            以下 7 个当前仅支持 Windows
│   ├── performance-diagnosis/
│   ├── storage-diagnosis/
│   ├── wifi-diagnosis/
│   ├── wifi-health-report/
│   ├── app-diagnosis/
│   └── service-recommendation/
│
├── .claude/skills/                 ← Claude Code 加载路径（由 sync-skill.sh 生成）
│
├── docs/                           见下
└── scripts/sync-skill.sh           两份 skill 副本的同步，防漂移
```

两份 skill 副本是因为 DSH 扫 `.dsh/skills/`、Claude Code 扫 `.claude/skills/`，
互不认对方的路径。软链在 Windows 上不可靠（本插件要跨平台），所以用真实副本 +
`scripts/sync-skill.sh` 保持一致。**改动请改 `.dsh/` 那份再同步。**

### 加一个新能力域

**一个工具组 = 一个能力域**，按「用户会分开问的问题」切分，不按实现方便切分。
下面五步缺一不可，`test/repo.test.js` 的框架守卫会逐条检查：

1. `src/tools/<能力域>/{collector.js,register.js}` —— 纯逻辑与 Cordis 壳分离；
   `register.js` 里 `export const group` 必须等于目录名
2. `.dsh/skills/<skill 名>/` —— SKILL.md + scripts + references，然后 `npm run sync-skill`
3. `src/index.js` 的 `GROUPS` 加一行
4. `test/tools/<能力域>.test.js`
5. `docs/tools/<能力域>.md`，并在 `docs/tools/README.md` 的表里加一行

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/vision.md](docs/vision.md) | **为什么做**：判断、要验证的假设、指标、工具规划、设计原则、风险边界 |
| [docs/progress.md](docs/progress.md) | **做到哪了**：当前状态、已完成、核心结论、踩过的坑、未来计划、未验证缺口 |
| [docs/verification-checklist.md](docs/verification-checklist.md) | **发版前必须跑完**：装得上、17 个工具逐个冒烟、skill 路由 |
| [docs/marketplace-listing.md](docs/marketplace-listing.md) | **怎么进生态**：收录机制、三个核心站点的逐项要求、已知坑、提交清单 |
| [docs/tools/](docs/tools/README.md) | **每个能力域一份**：工具清单、数据口径、隐私边界、判读纪律；索引页含共同契约与迁移来源 |
| [AGENTS.md](AGENTS.md) | **给 AI agent 的说明**：硬性约束、单一事实来源、代码约定、高频陷阱 |
| [handoff.md](handoff.md) | **交接文档**：冷启动接手所需的一切 |

---

## 已知待办

**未验证的部分，不要在对外材料里跳过。** 下面是摘要；
逐项依据与优先级以 **[docs/progress.md 第六章](docs/progress.md#六未验证与已知缺口)** 为准，
冲突时以那份为准。尤其**不要把「原 MCP 已验证」表述成「DSH 插件已验证」**。

| 项 | 状态 |
|---|---|
| 电池工具 · macOS | ✅ 实机验证 |
| 电池工具 · Windows | ⏳ **部分**。已在真实 PowerShell 5.1 上修过编码、数组语法与 Python 执行别名问题（`a66d386`），说明跑过；但完整流程未系统性验证。重点仍需核对 `powercfg /batteryreport /xml` 里 `HistoryEntry` 的容量字段层级 |
| 非电池工具（device / wifi / actions） | ⏳ 原 Device MCP 已在 Windows 11 验证过，**本仓库的 DSH Cordis 注册壳未验证** |
| Cordis 工具注册 | ⏳ **部分**。电池版本在 DSH Desktop 上暴露过 schema 编译器问题并已修复（`87ee6c5`），21 工具版本未重新验证 |
| `dsh plugin add` 安装 | ⏳ **部分**。只在电池版本上实测过；21 工具版本未重新验证。目录站 CI 只校验 manifest 形状，不安装不执行 |
| 转化数据 | ❌ 无埋点 |
| 品牌归属 | ❌ 未定论 |
| 电池服务链路（保修 / 备件价 / 门店） | ✅ 真实 SN 打通（2026-09-11）；接口为联想站内接口，无稳定性承诺 |
| 电池服务链路（预约提交 / 转人工） | ⏳ 预约需用户登录联想 ID，仅文档化流程；转人工为 **mock** |

⚠️ **npm 上的包落后于本仓库**：`dsh-lenovo-toolkit@0.1.1`（2026-08-31 发布）只含电池工具组，
而本仓库自 2026-09-03 起已有 17 个工具（2026-09-07 重构为 7 个能力域，2026-09-11 电池组加入服务链路后为 21 个）。用 npm 包名安装拿到的是旧版，
用 `github:` 源码规格安装拿到的才是当前代码。

完整清单与优先级见 [docs/progress.md](docs/progress.md)。

---

## License

[MIT](LICENSE)
