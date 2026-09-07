# 交接文档

写给**冷启动接手这个项目的人**——不需要看过之前的对话也能接上。

更新于 2026-09-07（前三版：2026-08-28、2026-09-02、2026-09-07 早些时候）。
状态类信息会过期，接手时请按[怎么核对当前状态](#怎么核对当前状态)先跑一遍。

---

## 一句话

把联想的专业服务能力（硬件诊断、备件、保修）做成通用 agent 平台的公共插件，
用**抢生态位**替代**抢平台**。这个仓库是这条路径的第一个验证载体。

**它首先是一个战略验证项目，其次才是一个工具。** 判断做得对不对，要看
`docs/vision.md` 里那四条假设有没有被推进，而不只是看代码质量。

---

## ⚠️ 下一步就是这件事：在 Windows 上跑验证清单

代码侧已经就绪，**卡在验证**。

照着 **[`docs/verification-checklist.md`](docs/verification-checklist.md)** 逐项跑，
需要一台能跑 DSH 的 Windows。清单分四段：

| 段 | 内容 | 备注 |
|---|---|---|
| A | 装得上（`dsh plugin add` + 插件树加载） | **A-2 失败就别往下测**，先修 schema |
| B | 17 个工具逐个冒烟，含 4 个受控操作的**拒绝路径** | |
| C | 9 个 skill 的发现与路由 | |
| D | 通过之后才做：bump 版本 → 发 npm → 回写 progress.md → 更新收录平台 | 顺序不可颠倒 |

跑完请把结果写回 **[`docs/progress.md` 第六章](docs/progress.md#六未验证与已知缺口)**——
那是全仓库验证口径的唯一事实来源，下一个接手的人只会读那张表。

---

## ⚠️ 线上 npm 包仍然落后于仓库

| | 内容 |
|---|---|
| npm `dsh-lenovo-toolkit@0.1.1`（2026-08-31 发布） | **只有电池工具组，3 个工具**（已拉 tarball 核对过） |
| 仓库 `main` | **7 个能力域，17 个工具，9 个 skill** |

**从插件市场用包名装到的用户，拿到的是只有电池检测的旧版本**；用 `github:` 源码规格
装的才是当前代码。`package.json` 仍是 `0.1.1`。

这不是 bug，是发版流程没走完，而且**是有意没走完**：把未在 DSH 运行时验证过的
17 工具版本推上 npm，风险比保持旧版更大——schema 不合规会阻断**整个插件树**加载，
用户装上后是整个插件废掉，不是某个工具不可用。

---

## 30 秒状态速览

| 项 | 状态 |
|---|---|
| 仓库 | [1Ecc/dsh-lenovo-toolkit](https://github.com/1Ecc/dsh-lenovo-toolkit) · public · 创建于 2026-08-28 |
| 本地路径 | `/Users/huguiyuan/workspace/DSH plugin` ⚠️ 目录名带空格且与仓库名不一致，**已决定留到收尾时再改** |
| 提交数 | 11（`awesome-dsh-plugin` 的 ≥10 门槛已满足） |
| npm | `0.1.1`（**内容落后于仓库**，见上） |
| 能力域 | **7 个**：`battery` / `device` / `performance` / `storage` / `app` / `wifi` / `actions`，共 **17 个 DSH 工具** |
| Skill | 9 个（电池 + 8 个 Windows 设备助手，含总路由 `xiangbangbang-device-assistant`） |
| 测试 | **36 个：35 通过 1 跳过**（`npm test`），每个能力域一份 + 仓库一致性与框架守卫 |
| 埋点 | ❌ 无，转化数据仍然空白 |

**收录状态**：

| 站点 | 状态 |
|---|---|
| dshfind | ✅ **已收录** `1Ecc/dsh-lenovo-toolkit`，分类 `tools`（尚未评级） |
| 1024Store（deepseek1024.com） | ⚠️ 已收录但**有两条重复条目**，其中一条已 verified，见下 |
| awesome-dsh-plugin | ⏳ 条目已备好，**年龄和提交数门槛都已满足**，尚未提交 |

---

## 验证状态

> 见 **[`docs/progress.md` 第六章](docs/progress.md#六未验证与已知缺口)**。
> **那是唯一事实来源，这里不再复制一份表格**——之前四份文档各存一份，
> 结果对同一件事给出互相矛盾的答案（有三份还写着「Windows 采集脚本从未运行过」，
> 而 git 记录直接证伪了）。2026-09-07 已收敛到一处。

两条不随进度变化的硬规矩，写在 `AGENTS.md` 里，这里重申：

1. **不要把「原 MCP 已验证」表述成「DSH 插件已验证」。** 迁入的 14 个非电池工具，
   其逻辑在 Windows 11 上验证过，但本仓库的 DSH Cordis 注册壳没有。
2. **「修过某平台上的 bug」不等于「在该平台完整验证过」。** 二者都标「部分」。

---

## 代码框架：一个工具组 = 一个能力域

`src/tools/<能力域>/`，各含 `collector.js`（纯逻辑）+ `register.js`（Cordis 壳）。

| 能力域 | 工具数 | 对应 skill | 平台 |
|---|---|---|---|
| `battery` | 3 | `battery-health-check` | macOS + Windows |
| `device` | 1 | `device-overview` | Windows |
| `performance` | 2 | `performance-diagnosis` | Windows |
| `storage` | 1 | `storage-diagnosis` | Windows |
| `app` | 1 | `app-diagnosis` | Windows |
| `wifi` | 5 | `wifi-diagnosis`、`wifi-health-report` | Windows |
| `actions` | 4 | 无专属 skill，被各 skill 复用 | Windows |

能力域按**用户会分开问的问题**切分，不按实现方便切分。
`test/repo.test.js` 里有**框架守卫**，强制每个能力域带齐
collector / register / `docs/tools/<域>.md` / `test/tools/<域>.test.js` 并挂进 `GROUPS`——
约定不会自己执行，写这条守卫时它立刻抓到了缺 `docs/tools/actions.md`。

### 2026-09-07 的重构（如果你在读旧文档会对不上）

迁入时 14 个工具挤在 `device` / `wifi` / `actions` 三个组里：`device` 一个组装了
5 个工具对应 3 个 skill，`wifi` 四个模块的采集函数还住在 `device/collector.js` 里跨目录 import，
`wifi` 和 `actions` 连文档和测试都没有。现已拆成上表的七个能力域。

**采集与判定逻辑逐字保留未改**——那部分在 Windows 11 上验证过，重构不该动它。
做过机器校验：原 `device/collector.js` 的 323 行逻辑与拆分后六个文件的并集逐行一致。

文档同步从 2 份拆成 7 份 + `docs/tools/README.md` 索引页（含 ToolEnvelope 共同契约、
隐私边界、迁移来源）。测试从 19 项扩到 36 项。

---

## 已经踩过并修掉的两个大坑

### ① DSH 工具 schema 编译器（会让整个插件加载失败）

提交 `87ee6c5`。新版 `dsh-tools` 要求：

- 可选参数**省略 `required` 字段**（不能写 `required: false`）
- 对象输出**显式声明 `additionalProperties`**

否则**一个工具的 schema 不合规会阻断整个插件树加载**——不是这个工具不可用，是整个插件废掉。
`test/repo.test.js` 已加守卫，新增能力域会被自动检查。

### ② Windows 上的 Python「应用执行别名」

`src/tools/battery/collector.js` 里针对 Windows 做了特殊处理：Windows 的应用执行别名
会让 `python3` **看似存在、执行却立即失败**。现在先用 `--version` 探活，
并按 `py -3` → `python` → `python3` 的顺序尝试，避免把「没装 Python」误报成脚本执行失败。

---

## ⚠️ 仍然不干净：1024Store 上有两条重复条目

| 条目 id | 来源 | 安装验证 | 安装命令 |
|---|---|---|---|
| `1Ecc/dsh-plugin` | 我们提交的 [PR #263](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/263) | `unknown` / `not_checked` ❌ | `add github:1Ecc/dsh-plugin`（旧名） |
| `1Ecc/dsh-lenovo-toolkit` | 站点通过 topic 自动发现 | `verified` / `published_package` ✅ | `add dsh-lenovo-toolkit`（npm） |

**成因**：先提交了目录 PR（用当时的仓库名 `dsh-plugin`），之后才改名成 `dsh-lenovo-toolkit`。
GitHub 有 301 重定向所以链接不死，但目录里的 `id` 与真实仓库名对不上；
与此同时站点的自动发现服务又按新名字建了第二条。

**待办（C-4）**：处理 `catalog/plugins/1ecc--dsh-plugin.json`。两个选择：

- **删除它**（推荐）——自动发现的那条已经 verified 且用 npm 安装命令，比手工提交的那条更好
- 改名并更新 `id`/`repository`——保留「主动提交过」的痕迹，但结果不如上面那条

注意：1024Store 的规则里**更新或删除既有条目不走自动合并，需要维护者人工审核**。

⚠️ 那条 verified 条目用的是 **npm 包名**安装命令，而 npm 上是旧版。
所以**发版之前，从 1024Store 点进来的用户拿到的是只有电池的版本**。这是把发版排在
清理条目之前的另一个理由。

---

## 接手第一步（按顺序）

```bash
cd "/Users/huguiyuan/workspace/DSH plugin"
npm test                          # 应当 35 通过 1 跳过（共 36）
git log --oneline | head          # 看最近做了什么
ls src/tools/ .dsh/skills/        # 应当是 7 个能力域 + 9 个 skill
```

然后按这个顺序读：

1. **`AGENTS.md`** —— 硬性约束、单一事实来源、能力域框架、代码约定、高频陷阱。**动代码前必读。**
2. **`docs/vision.md`** —— 为什么做这个项目、要验证什么。**做决策前必读。**
3. **`docs/progress.md`** —— 做到哪了、踩过哪些坑、下一步计划、**验证状态（唯一事实来源）**。
4. **`docs/verification-checklist.md`** —— 当前最紧的一件事，见文首。
5. **`docs/tools/README.md`** —— 七个能力域的索引、共同契约、隐私边界、迁移来源。
   要动某个能力域时再读它旁边的 `docs/tools/<能力域>.md`。
6. `docs/marketplace-listing.md` —— 只在要动收录相关的事情时读。

---

## 环境与账号

| 项 | 说明 |
|---|---|
| Node | ≥ 20（开发机上是 v24） |
| Python | `python3`，仅趋势图渲染用，只依赖标准库；Windows 上注意执行别名问题 |
| GitHub | 账号 `1Ecc`，SSH key 已绑定；`gh` CLI 已认证（keyring） |
| git 身份 | 只配了**本仓库局部**身份，用 noreply 邮箱；全局 git 身份是空的 |
| npm | 已发布至 `0.1.1`；发布账号需向原维护者确认 |
| 无构建步骤 | 插件是 ESM JS，改完直接生效 |
| peer 依赖 | `@deepseek-ai/dsh-tools` 开发机上没装，所以 `collector.js` **不许** import 它，否则整个模块没法测 |

⚠️ 本地目录名 `DSH plugin` 带空格且与仓库名不符。脚本里路径都做了引号处理，
写新脚本时注意别漏引号。改本地目录名不影响 `git remote`（remote 是 SSH URL）。
**已决定留到收尾时再改**，避免中途打断正在进行的工作。

---

## 进行中／未完成

| # | 事项 | 为什么优先 | 阻塞 |
|---|---|---|---|
| 1 | **跑 `docs/verification-checklist.md`** | 发版的前置条件；schema 类问题会让**整个插件**废掉 | 需要能跑 DSH 的 Windows 环境（已确认有） |
| 2 | **bump 到 `0.2.0` 并发 npm** | 线上包落后于仓库，市场用户拿不到新工具 | 依赖第 1 项 |
| 3 | 把验证结果回写 `docs/progress.md` 第六章 | 那是唯一事实来源，不回写等于没验证 | 依赖第 1 项 |
| 4 | C-4：清理 1024Store 重复条目 | 见上文，建议直接删旧条目 | 需人工审核，等维护者 |
| 5 | C-3：提交 awesome-dsh-plugin | 权重最大的目录站；门槛已全部满足 | 无（但**是对外动作，要先确认**） |
| 6 | CI 跑测试 | 目录站看重「活跃维护」；也能防 schema 类问题溜过 | 无 |
| 7 | `screenshots.json` + 报告样例 | 市场详情页会展示 | 无 |
| 8 | **埋点** | H3 假设完全没数据，四条假设里唯一零进展的 | 需定埋点方案 |
| 9 | 本地目录改名 | 见上文，收尾时做 | 无 |

第 1、2、3 项是一条链：**没验证就别发版，发了版就要回写**。

---

## 待决策（这些不是技术问题，需要人拍板）

| # | 事项 | 说明 |
|---|---|---|
| 1 | **品牌归属** | 用 `lenovo` 命名的公共仓 + npm 包挂在个人账号 `1Ecc` 下，外部会默认是联想官方发布。README 顶部当前按「个人试点」写了免责声明。**如果是官方项目，应迁到 Lenovo 组织下并改写那段。** |
| 2 | **内部策略是否继续公开** | `references/lenovo-offers.md` 含试点触发条件、试点范围、埋点建议。仓库 public 且已打 topic，**dshfind 和 1024Store 都已实际收录**，内容已被索引。这是不可撤回的——改 private 挡不住已缓存的内容。 |
| 3 | **迁入内容的来源授权** | 14 个工具迁自「想帮帮 Device MCP」。公共仓 + MIT 协议发布这批代码是否已获授权，需要确认。 |
| 4 | 拯救者电池商品 ID | 需求方给的链接**显示文本 `1045746`、href `1045747`**，两者不一致。当前用 href 值。 |
| 5 | 商品链接巡检责任人 | 商品 ID 会失效，需要有人定期核对。 |

第 2、3 项比之前更紧迫：内容已经被实际收录并索引，且仓库里多了一批来自另一个项目的代码。

---

## 千万别做的事

- **不要为了让推荐能触发而调整诊断口径、阈值或措辞。** 详见 `AGENTS.md` 第 1 条约束。
- **不要把「原 MCP 已验证」说成「DSH 插件已验证」。**
- **不要在跑完验证清单前发 npm 版本。**
- **不要在四份文档里各存一份验证状态。** 唯一事实来源是 `docs/progress.md` 第六章，
  其余一律指过去。这个坑已经踩过一次，代价是四份文档互相矛盾。
- **不要直接改 `.claude/skills/`** —— 那是派生副本，改 `.dsh/skills/` 再 `npm run sync-skill`。
- **不要在工具 schema 里写 `required: false`，也不要漏 `additionalProperties`。**
  会让整个插件加载失败。守卫测试会拦，但要知道为什么。
- **不要在 `collector.js` 里 import `@deepseek-ai/*`。** 那是 peer 依赖，
  开发机上装不到，混进去整个模块就没法测了。对接 Cordis 的代码放 `register.js`。
- **不要给采集脚本引入第三方依赖。** 它们要能直接扔到客户机器上跑。
- **不要擅自打 topic / 提第三方 PR / 发 npm / 改仓库名。** 都是对外动作，先确认。
  改仓库名尤其危险——已经因此产生了一条至今没清理的重复条目。

---

## 怎么核对当前状态

```bash
# 仓库、提交数、代码规模
git rev-list --count HEAD
ls src/tools/ .dsh/skills/
npm test

# 能力域与工具数是否对得上（应当是 7 组 17 个，无重名）
node -e "
const fs=require('fs');let all=[];
for(const g of fs.readdirSync('src/tools').sort()){
  const s=fs.readFileSync('src/tools/'+g+'/register.js','utf8');
  const n=[...s.matchAll(/name:\s*'([^']+)'/g)].map(m=>m[1]);
  console.log(g.padEnd(12),n.length,n.join(', '));all=all.concat(n);
}
console.log('总计',all.length,'去重后',new Set(all).size);"

# npm 线上版本 vs 本地版本（不一致说明还没发版）
node -p "require('./package.json').version"
curl -s https://registry.npmjs.org/dsh-lenovo-toolkit | python3 -c "import sys,json;print(json.load(sys.stdin)['dist-tags'])"

# 线上包到底装了哪些工具（比看版本号可靠）
curl -s https://registry.npmjs.org/dsh-lenovo-toolkit | python3 -c "
import sys,json;print(json.load(sys.stdin)['versions']['0.1.1']['dist']['tarball'])" | xargs curl -s | tar tz | grep 'src/tools'

# 1024Store 上两条条目的实时状态
for id in "1Ecc/dsh-plugin" "1Ecc/dsh-lenovo-toolkit"; do
  curl -s "https://deepseek1024.com/api/v1/plugins/$id" | python3 -c "
import sys,json;d=json.load(sys.stdin);m=(d.get('installMethods') or [{}])[0]
print(d['id'], '| cat=', d.get('category',{}).get('id'), '| verify=', m.get('verification'), '|', m.get('code'), '|', d.get('install'))"
done

# dshfind
curl -s --get 'https://api.dshfind.com/v1/plugins' --data-urlencode 'owner=1Ecc' | python3 -c "
import sys,json;d=json.load(sys.stdin)
print('条数:', len(d.get('data',[])))
for it in d.get('data',[]): print(' ', it.get('full_name'), '| grade:', it.get('grade'))"
```

---

## 关键链接

| 用途 | 链接 |
|---|---|
| 本仓库 | https://github.com/1Ecc/dsh-lenovo-toolkit |
| npm 包 | https://www.npmjs.com/package/dsh-lenovo-toolkit |
| 1024Store 目录仓 | https://github.com/imsai-sh/awesome-deepseek-harness-plugins |
| 我们的收录 PR | https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/263 |
| awesome-dsh-plugin | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin |
| dshfind | https://github.com/hikariming/dshfind |
| DSH 官方 | https://github.com/deepseek-ai/deepseek-harness |
| DSH 开发文档 | https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/ |
