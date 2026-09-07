# AGENTS.md

给在这个仓库里工作的 AI agent 的说明。**这是唯一事实来源**，`CLAUDE.md` 只是指向本文件的指针。

## 这是什么

面向 DeepSeek Harness 的联想专业工具集。同时是 **Skill**（给模型看的判读指令）和
**Cordis Plugin**（注册 DSH 原生工具）两种形态。

背景与战略见 `docs/vision.md`，进展见 `docs/progress.md`，交接见 `handoff.md`。
**动手前先读这三份里与任务相关的那份**，不要凭仓库结构猜意图。

## 不可违反的约束

这几条是这个项目的立身之本，改代码时优先级高于任何便利性：

1. **诊断与推荐严格分离，顺序不可颠倒。** 先出结论，再看结论是否触发推荐。
   永远不要为了让推荐能触发而调整诊断口径、阈值或措辞。
   诊断报告的全部价值来自「用户相信这些数字没被动过手脚」。

2. **不确定就说不确定。** 数据不足时给区间和条件，不给假装精确的数字。
   虚假的确定性在服务场景里会直接变成投诉。

3. **采集脚本零第三方依赖。** macOS 电池采集只用 `system_profiler`/`ioreg`/`plutil`/`pmset`；
   Windows 采集只用系统自带的 CIM/WMI、`powercfg`、网络命令和注册表接口。脚本要能直接扔到客户机器上跑。
   趋势图渲染只用 Python 标准库。**不要引入 npm/pip 依赖来"简化"这些脚本。**

4. **实测与推算必须可区分。** 图表上实测点用实线实心点、推算用虚线；
   文字里推算必须标注为推算。把模型推算呈现成历史实测会直接变成投诉。

5. **不采集用户数据。** 当前 skill 与插件不上报任何数据。要加埋点必须显式设计并明示。

## 单一事实来源

| 内容 | 源 | 派生／指针 |
|---|---|---|
| skill 文件 | `.dsh/skills/` | `.claude/skills/`（跑 `npm run sync-skill` 生成） |
| agent 说明 | `AGENTS.md` | `CLAUDE.md`（指针，不要往里写内容） |
| 验证状态 | `docs/progress.md` 第六章 | `README.md`、`handoff.md`、`docs/tools/*.md` 一律指过去 |
| 能力域清单 | `src/tools/` 的目录结构 | `docs/tools/README.md` 的表、`src/index.js` 的 `GROUPS`（有守卫） |

**改 skill 请改 `.dsh/` 那份再同步。** 直接改 `.claude/` 那份会在下次同步时被覆盖。
`npm test` 里有守卫会检查这两处一致。

## 命令

```bash
npm test              # 单元 + 真实采集的集成测试 + 仓库一致性守卫
npm run sync-skill    # .dsh/skills → .claude/skills
```

没有构建步骤。插件是 ESM JavaScript，改完直接生效。

## 代码约定

- **ESM JavaScript，不用 TypeScript。** 刻意的：无构建步骤，从源码安装不需要
  `allowBuilds` 授权。不要"顺手"迁移到 TS。
- **注释写「为什么」，不写「是什么」。** 这个仓库里几乎每个反直觉的写法背后都有一个
  踩过的坑，注释要把坑说清楚，否则下一个人会改回去。
- **纯逻辑与 Cordis 壳分离。** `src/tools/<组>/collector.js` 不许 import
  `@deepseek-ai/*`——那是 peer 依赖，开发机上不一定装得到，混进去整个模块就没法测了。
  对接 Cordis 的代码放 `register.js`。
- 错误用 `src/shared/errors.js` 的 `ToolkitError` 并带 `code`，
  让上层能把「没检测到电池」和「脚本崩了」区分开。

## 能力域框架

**一个工具组 = 一个能力域**，落在 `src/tools/<能力域>/` 下。当前七个：
`battery` · `device` · `performance` · `storage` · `app` · `wifi` · `actions`。

能力域按**用户会分开问的问题**切分，不按实现方便切分。「我这台是什么配置」
「怎么这么卡」「盘满了」「装没装某某软件」是四个独立诉求，各自对应一个 skill，
所以代码也分开。切在一起的后果实测过：迁入那次 `device` 一个组塞了 5 个工具对应
3 个 skill，`wifi` 的采集函数还住在 `device/collector.js` 里，加一个能力得改一堆无关文件——
那正是 H4 假设（边际成本下降）要证伪的东西。

`actions` 是唯一例外：它不对应某个诊断 skill，而是被各 skill 复用的
「需逐次确认的低风险操作」出口，按职责而非诉求单列。

### 加一个新能力域

五步缺一不可，`test/repo.test.js` 的框架守卫会逐条检查，漏了会直接测试失败：

1. `src/tools/<能力域>/{collector.js,register.js}`——这两个文件名是硬性的；
   额外的纯逻辑模块可以有（`wifi/` 就另有三个渲染模块）。
   `register.js` 里 `export const group` 必须等于目录名。
2. `.dsh/skills/<skill 名>/`（SKILL.md + scripts + references），然后 `npm run sync-skill`
3. `src/index.js` 的 `GROUPS` 加一行
4. `test/tools/<能力域>.test.js`
5. `docs/tools/<能力域>.md`，并在 `docs/tools/README.md` 的表里加一行

### 只支持 Windows 的能力域必须能在 macOS 上优雅降级

开发机多数是 macOS，而七个能力域里有六个只支持 Windows。整个包在 macOS 上
**也会被加载**（电池工具跨平台），所以一个未捕获的 spawn 错误会顺着 Cordis 冒上去，
表现成整个插件出问题而不是单个工具不可用。

统一走 `src/shared/windows-failure.js` 的 `executionFailure`，在非 Windows 上返回
`status: 'unsupported'` + `code: 'powershell_unavailable'`。
`test/helpers/windows.js` 里有现成断言，新能力域直接用。

## 提交约定

- 提交信息用中文，正文说清**为什么这么改**，尤其是反直觉的取舍。
- 结尾加 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。
- **不要制造空提交或无意义提交去凑数。** `awesome-dsh-plugin` 有 ≥10 提交的门槛，
  但那个门槛正是用来拦「临时攒出来的仓库」的，凑数会适得其反，
  而且维护者合并前会实际读仓库。

## 对外操作要先确认

下列动作会影响仓库之外，**执行前必须先跟人确认**：

- 给仓库打 topic（这是一次不可撤回的广播，十几个目录站会同时收录）
- 向第三方仓库提 PR
- npm 发布
- 改仓库可见性、改仓库名（**改名会让已收录的目录条目失配**，见下）

## 高频陷阱

| 陷阱 | 后果 |
|---|---|
| YAML 值含 `: ` 未加引号 | DSH **静默拒绝** skill——不报错，就是不出现 |
| `plutil` 把错误文本打到 stdout | 错误文本冒充字段值写进报告 |
| `SPPowerDataType` 的 `_items` 顺序不固定 | 写死下标必漏字段 |
| Intel 与 Apple Silicon 的 `MaxCapacity` 含义相反 | 容量算错 |
| peerDeps 的 semver 预发布范围 | 上游发新元组后用户撞 `ERESOLVE`，见 `docs/marketplace-listing.md` |
| 改仓库名 | 目录站条目 id 失配，修正 PR 要走人工审核 |

完整清单见 `docs/progress.md` 的「踩过的坑」和 `docs/marketplace-listing.md` 的「已知坑」。

## 未验证的部分

**逐项状态见 `docs/progress.md` 的「六、未验证与已知缺口」——那是唯一事实来源，
不要在这里复制一份表格，两份必然漂移。** 写 README、市场描述、PR 正文前先去读那张表。

这里只放三条不随进度变化的硬规矩：

1. **不要把「原 MCP 已验证」表述成「DSH 插件已验证」。** 迁入的 14 个非电池工具，
   其逻辑在 Windows 11 上验证过，但本仓库的 DSH Cordis 注册壳没有。这两件事不是一回事。
2. **「修过某平台上的 bug」不等于「在该平台完整验证过」。** 二者都要如实标成「部分」。
3. **不要在真实 DSH 运行时验证之前发 npm 版本。** 一个工具的 schema 不合规会阻断
   **整个插件树**加载（见上文陷阱表），未验证版本上线的风险大于保持旧版。

目录站会核对描述真实性，夸大是被打回甚至移除的理由。
