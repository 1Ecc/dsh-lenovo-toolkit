# dsh-lenovo-toolkit

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**联想专业工具集**。
把联想服务体系里的专业判断能力——硬件诊断、备件、保修、服务网点——做成通用 agent 平台上可安装的插件。

当前状态：**试点阶段**，第一个工具组是电池健康检测。macOS 已实机验证，Windows 已实现待验证。

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

详见 **[docs/tools/battery-health.md](docs/tools/battery-health.md)**。

### 计划中

- 其他硬件诊断（存储健康、内存、散热、电源适配器）
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
│   └── tools/
│       └── battery/
│           ├── collector.js        纯逻辑，无 peer 依赖，可独立测试
│           └── register.js         注册该组的 DSH 工具
│
├── test/tools/                     按工具组分目录
│
├── .dsh/skills/                    ← DSH skill 加载路径（唯一事实来源）
│   └── battery-health-check/
│       ├── SKILL.md                流程编排与报告模板
│       ├── scripts/                平台采集脚本（零依赖）+ 趋势图渲染
│       └── references/             判读规则、推荐策略、平台笔记
│
├── .claude/skills/                 ← Claude Code 加载路径（由 sync-skill.sh 生成）
│
├── docs/                           见下
└── scripts/sync-skill.sh           两份 skill 副本的同步，防漂移
```

两份 skill 副本是因为 DSH 扫 `.dsh/skills/`、Claude Code 扫 `.claude/skills/`，
互不认对方的路径。软链在 Windows 上不可靠（本插件要跨平台），所以用真实副本 +
`scripts/sync-skill.sh` 保持一致。**改动请改 `.dsh/` 那份再同步。**

### 加一个新工具组

1. `src/tools/<组名>/{collector.js,register.js}` —— 纯逻辑与注册分离
2. `.dsh/skills/<skill 名>/` —— SKILL.md + scripts + references，然后 `npm run sync-skill`
3. `src/index.js` 的 `GROUPS` 加一行
4. `test/tools/<组名>.test.js`
5. `docs/tools/<组名>.md`

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/vision.md](docs/vision.md) | **为什么做**：判断、要验证的假设、指标、工具规划、设计原则、风险边界 |
| [docs/progress.md](docs/progress.md) | **做到哪了**：当前状态、已完成、核心结论、踩过的坑、未来计划、未验证缺口 |
| [docs/marketplace-listing.md](docs/marketplace-listing.md) | **怎么进生态**：收录机制、三个核心站点的逐项要求、已知坑、提交清单 |
| [docs/tools/battery-health.md](docs/tools/battery-health.md) | 电池工具组的能力矩阵、数据口径、趋势图设计原则、推荐策略 |

---

## 已知待办

**未验证的部分，不要在对外材料里跳过：**

- Windows 采集脚本已实现但**从未在真实 Windows 上运行过**
- `dsh plugin add` 的实际安装**未实测**（目录站 CI 只校验 manifest 形状，不安装不执行）
- Cordis 工具注册按官方文档写就，**未在真实 DSH 运行时验证过**
- 无埋点，转化数据完全空白
- 品牌归属未定论
- 拯救者电池商品 ID 待核对（需求方给的链接显示文本与 href 不一致）

完整清单与优先级见 [docs/progress.md](docs/progress.md)。

---

## License

[MIT](LICENSE)
