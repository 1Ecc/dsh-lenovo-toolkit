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

| 内容 | 源 | 派生 |
|---|---|---|
| skill 文件 | `.dsh/skills/` | `.claude/skills/`（跑 `npm run sync-skill` 生成） |
| agent 说明 | `AGENTS.md` | `CLAUDE.md`（指针，不要往里写内容） |

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

## 加一个新工具组

1. `src/tools/<组名>/{collector.js,register.js}`
2. `.dsh/skills/<skill 名>/`（SKILL.md + scripts + references），然后 `npm run sync-skill`
3. `src/index.js` 的 `GROUPS` 加一行
4. `test/tools/<组名>.test.js`
5. `docs/tools/<组名>.md`

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

**不要在对外材料里把这些说成已验证：**

- Windows 采集脚本从未在真实 Windows 上运行过
- `dsh plugin add` 的实际安装未实测
- Cordis 工具注册未在真实 DSH 运行时验证过

写 README、市场描述、PR 正文时，这些必须如实标注。目录站会核对描述真实性，
夸大是被打回甚至移除的理由。
