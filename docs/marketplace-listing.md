# DSH 插件公共区收录：机制、站点要求与我们的策略

调研日期：2026-08-28。生态变动很快，**下面每条要求在动手前都该复核一遍**，
尤其是版本号相关的部分——我们已经踩到过一次文档过期（见[已知坑](#已知坑)第 1 条）。

## 目录

- [一、先破除一个误解](#一先破除一个误解)
- [二、Skill 与 Plugin 是两种东西](#二skill-与-plugin-是两种东西)
- [三、三个核心站点的要求](#三三个核心站点的要求)
- [四、已知坑](#已知坑)
- [五、我们的收录策略](#五我们的收录策略)
- [六、提交清单](#六提交清单)
- [七、维护责任](#七维护责任)

---

## 一、先破除一个误解

**DSH 没有官方运营的插件市场。** 不存在「提交审核 → 上架官方商店」这条链路。

真实机制是一个**基于 GitHub topic 的广播**：

```
你给仓库打上 dsh-plugin topic
        │
        └─► 所有基于 topic 自动聚合的站点【同时】收录你
              ├─ dshfind
              ├─ dsh-market
              ├─ dsh-plugin-marketplace
              ├─ 1024Store 的 tokenless discovery
              └─ 其他若干
```

由此推出两条对决策有影响的结论：

1. **「只在某一个站点发布」做不到。** 打 topic 是一次不可选择目标的广播。
   唯一能控制的是那些需要主动提 PR 的目录——不提 PR 就不进。
2. **收录 ≠ 审核通过 ≠ 安全审查。** 多数站点是每日自动扫描 + 静态校验。
   awesome-dsh-plugin 的 README 顶部有明确的免责声明，它自己也说
   「收录仍不等于做过安全审查，这只是常识性检查，不是审计」。

所谓「插件市场」本身也是社区插件——用户要先装一个市场插件，才能在 DSH 的
Settings 里浏览安装其他插件。它不是 DSH 的内置功能。

---

## 二、Skill 与 Plugin 是两种东西

这个区分直接决定能不能被收录。

| | **Skill** | **Plugin** |
|---|---|---|
| 形态 | `<名字>/SKILL.md` + 脚本资源 | JS/TS 模块，导出 `apply(ctx)` |
| 安装 | **不需要安装**，放进目录就被发现 | `dsh plugin --profile <p> add <spec>` |
| 注册 | 无 | `cordis.yml` / `cordis.patch.yml` |
| 作用域 | 支持项目级 | profile 级，**没有项目级概念** |
| 能注册工具/服务/事件 | ❌ | ✅ |
| 热更新 | ✅ 改文件即生效 | 需重载 |

**关键：纯 SKILL.md 仓库进不了需要提 PR 的目录。** ①② 两站的 CI 都会拉你仓库的
`package.json` 检查 `dsh.bundle`，那是「可被 `dsh plugin add` 安装」的凭证。
只有靠 topic 自动聚合的站点（如 dshfind）不看这个。

### DSH skill 的加载路径（按优先级）

| 优先级 | 路径 | 作用域 |
|---|---|---|
| 100 | `.dsh/skills/` | 项目级（找最近的 `.git` 祖先） |
| 200 | `.agents/skills/` | 项目级备选 |
| 300 | 自定义目录 | 用户配置 |
| 400 | `~/.dsh/skills/` | 用户级 |
| 500 | `~/.agents/skills/` | 用户级备选 |

**只扫顶层，不递归。** skill 目录必须直接位于上述路径之下。

---

## 三、三个核心站点的要求

| | **① 1024Store** | **② awesome-dsh-plugin** | **③ dshfind** |
|---|---|---|---|
| 提交到 | `imsai-sh/awesome-deepseek-harness-plugins` | `awesome-dsh-plugin/awesome-dsh-plugin` | 无需提交 |
| 站点 | deepseek1024.com | awesome-dsh-plugin.com | — |
| 提交物 | 1 个 `catalog/plugins/*.json` | 1 个 `data/plugins/*.yml` + 重新生成 README | 打 topic |
| **需要 `dsh.bundle`** | ✅ | ✅ | ❌ |
| 仓库年龄门槛 | 无 | **≥1 天 且 ≥10 提交** | 无 |
| 人工审核 | ❌ 静态检查过即自动 squash merge | ✅ 维护者读源码核对描述 | ❌ |
| 单 PR 上限 | 1 条（走自动通道） | 3 条 | — |
| npm 包 | 可选，不发则 browse-only | 可选，不影响收录 | 不需要 |
| stars | — | 13.2k | 233 |

> ⚠️ `imsai-sh/dsh-1024store` **不接受插件提交**，它是站点和 npm 包的代码仓。
> 其 CONTRIBUTING 明写：「Plugin submissions do not belong here」。
> 真正的目录仓是 `imsai-sh/awesome-deepseek-harness-plugins`。

### ① 1024Store 细则

文件名规则：id 的每个 `/` 段小写、非字母数字连续段转 `-`，段间用 `--` 连接。
`1Ecc/dsh-plugin` → `1ecc--dsh-plugin.json`。

```json
{
  "$schema": "../schema/plugin.schema.json",
  "id": "1Ecc/dsh-plugin",
  "name": "dsh-plugin",
  "repository": "https://github.com/1Ecc/dsh-plugin",
  "category": "tools",
  "description": { "en": "...", "zh": "..." },
  "added": "2026-08-28"
}
```

硬约束：

- **PR 只能碰 `catalog/plugins/` 下的文件。** 动 README、workflow、脚本一律拒。
  README 是 bot 生成的投影，会自动刷新。
- 恰好 1 条新条目才走自动合并通道；更新或删除既有条目需人工审核。
- 描述客观中性，禁营销词。
- CI 会通过 GitHub API 读你仓库的 `package.json`，确认 `dsh.bundle.patch` 非空
  且 patch 文件在同一 revision 存在。

### ② awesome-dsh-plugin 细则

```yaml
url: https://github.com/owner/repo
name: owner/repo
category: skill
description:
  en: One-line description ending with a period.
  zh: 一句话描述，以句号结尾。
```

- 只有 `description.en` 必填，中文缺了维护者会补。
- 提交后要本地跑 `npm ci && node scripts/generate-readme.mjs` 重新生成两个 README，
  连同 yml 一起提交。**不要手工编辑 README。**
- 可用 category：`agi ui usage theme model identity session memory tools browser
  vision voice docs skill workflow git notify dev security remote market fun`
- **描述必须属实。** 原文：「写「46 个工具、六大领域」，就应该真有 46 个工具和六个领域」。
  夸大是被打回的主要原因。
- 分类选不准不会被打回，维护者会直接改。

### ③ dshfind 细则

README 原文：「给你的**公开** GitHub 仓库加上 `dsh-plugin` topic，下次数据刷新时
就会出现在插件市场中。」

没有 PR，没有 package.json 要求。纯 GitHub topic 索引。

---

## 已知坑

### 1. peerDependencies 的 semver 预发布陷阱（会让用户装不上）

`@deepseek-ai/*` 全部是预发布版本。node-semver 的规则是：**只有当范围内某个比较符与
目标版本的 `major.minor.patch` 完全一致、且该比较符自身带预发布标签时，才放行这个预发布版本。**

我们实测了四种写法（`semver.satisfies`）：

| 范围 | 0.0.1-rc.1 | 0.1.0-rc.8 | 0.1.1-rc.2 |
|---|---|---|---|
| `>=0.0.1-rc.1 <0.1.0 \|\| >=0.1.0-rc.1 <0.2.0-0`（**站点文档推荐**） | ✅ | ✅ | ❌ |
| `>=0.0.1-rc.1 <0.2.0`（看着很宽） | ✅ | ❌ | ❌ |
| `>=0.0.0-0 <0.2.0-0`（「匹配一切」） | ❌ | ❌ | ❌ |
| `>=0.0.1-rc.1 <0.1.0 \|\| >=0.1.0-rc.1 <0.1.1 \|\| >=0.1.1-rc.1 <0.2.0-0` | ✅ | ✅ | ✅ |

**站点文档里推荐的那个范围已经过期**——它写在 `0.1.1-rc.x` 发布之前，
现在会静默排除 `latest` 和 `next`，用户 `npm install` 撞 `ERESOLVE`。

⚠️ **上游每发一个新的 `0.x.y` 元组，就要再加一段 `||`。** 这是持续维护项，
不是一次性配置。发版前跑一遍上表那个 `semver.satisfies` 检查。

### 2. `dsh.client` 不等于 `dsh.bundle`

最常见的被拒原因。`dsh.client` 只在带前端 UI 时需要，单独声明它**无法安装**。
必须有 `dsh.bundle.patch`。

### 3. cordis.patch.yml 的 id 冲突会让 dsh 启动崩溃

bundle 安装后，不要在 profile 的 `cordis.patch.yml` 里再插入同名条目，
会触发 `duplicate loader entry id` 崩溃。

### 4. SKILL.md frontmatter 的静默拒绝

DSH 文档明确：含冒号、括号、逗号的值不加引号会导致 YAML 解析失败，
**skill 被静默拒绝——不报错，就是不出现**。排查成本很高，一律加引号。

---

## 五、我们的收录策略

按「先跑通、后扩散」排序，理由是每一步都能独立验证，失败了不会牵连下一步。

| 阶段 | 动作 | 目标站点 | 前置条件 |
|---|---|---|---|
| A | skill 放 `.dsh/skills/` | — | 无 |
| B | 做成 bundle 插件 | — | 无 |
| C-1 | 打 `dsh-plugin` topic | ③ + 一批自动聚合站 | B（严格说不需要，但先有 B 更体面） |
| C-2 | PR 到 1024Store 目录仓 | ① | B |
| C-3 | PR 到 awesome-dsh-plugin | ② | B + ≥10 提交 + ≥1 天 |

**为什么 C-2 排在 C-3 前面**：C-2 无年龄门槛且自动合并，是最快能拿到「正式收录」
反馈的渠道，可以先用它验证 `dsh.bundle` 声明是否被 CI 接受。C-3 权重最大但要等提交数。

### 一个必须清醒的判断

打 topic 会把仓库内容推进十几个插件目录站并被搜索引擎索引。
本仓库的 `references/lenovo-offers.md` 含**试点触发条件、试点范围、埋点建议**。

试点期选择「先跑通链路、暂不脱敏」是可以的，但要知道这是**不可撤回的**——
改回 private 能挡住后续访问，已被爬取或缓存的内容收不回来。
正式推广前应当决定：是把内部决策逻辑抽成本地配置，还是接受它公开。

---

## 六、提交清单

### C-1 打 topic

- [ ] 仓库 public
- [ ] 有真实可用代码（非占位/纯 README）
- [ ] 加 topic：`dsh-plugin`（可再加 `deepseek-harness`、`dsh`）

### C-2 提交到 1024Store

- [ ] `package.json` 有非空 `dsh.bundle.patch`，且 patch 文件已提交并推送
- [ ] 已打 `dsh-plugin` topic
- [ ] 自己实测过插件能装能跑（目录方不会执行你的代码，责任在作者）
- [ ] fork 目录仓，新建分支
- [ ] 只加一个文件 `catalog/plugins/1ecc--dsh-plugin.json`
- [ ] `added` 填提交当天日期
- [ ] 描述中英双语、客观、无营销词
- [ ] **确认 diff 里没有任何 `catalog/plugins/` 之外的改动**

### C-3 提交到 awesome-dsh-plugin

- [ ] 上面 C-2 的全部前置条件
- [ ] 仓库创建满 1 天
- [ ] 提交数 ≥ 10
- [ ] 加 `data/plugins/1Ecc__dsh-plugin.yml`
- [ ] `npm ci && node scripts/generate-readme.mjs` 重新生成两个 README 并一起提交
- [ ] category 选 `skill` 或 `tools`
- [ ] 描述里的每个具体声明（工具数量、命令名）都能在代码里对上

---

## 七、维护责任

收录不是一次性动作，几个站点都有清退机制。

| 事项 | 频率 | 说明 |
|---|---|---|
| peer range 补新元组 | 上游发版时 | 见[已知坑](#已知坑)第 1 条，漏了用户就装不上 |
| 仓库保持活跃 | 持续 | awesome-dsh-plugin 定期扫描，归档或长期停更的条目会被移除 |
| 描述与代码保持一致 | 改功能时 | 描述被当作声明核对，改了功能没改描述会被打回 |
| 商品链接有效性 | 定期 | `lenovo-offers.md` 里的商品 ID 会失效，需要责任人巡检 |
| 站点要求复核 | 每次提交前 | 本文档的调研快照是 2026-08-28，生态变动快 |

**收录不是永久的。** awesome-dsh-plugin 原文：「停止维护、有恶意行为、存在明显缺陷的
条目会被移除……规则不是先来后到，规则是谁更好。」
