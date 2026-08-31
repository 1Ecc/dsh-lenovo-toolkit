# 交接文档

写给**冷启动接手这个项目的人**——不需要看过之前的对话也能接上。

更新于 2026-08-28。状态类信息会过期，接手时请按[怎么核对当前状态](#怎么核对当前状态)先跑一遍。

---

## 一句话

把联想的专业服务能力（硬件诊断、备件、保修）做成通用 agent 平台的公共插件，
用**抢生态位**替代**抢平台**。这个仓库是这条路径的第一个验证载体，第一个工具是电池健康检测。

**它首先是一个战略验证项目，其次才是一个工具。** 判断做得对不对，要看
`docs/vision.md` 里那四条假设有没有被推进，而不只是看代码质量。

---

## 30 秒状态速览

| 项 | 状态 |
|---|---|
| 仓库 | [1Ecc/dsh-lenovo-toolkit](https://github.com/1Ecc/dsh-lenovo-toolkit) · public · 创建于 2026-08-28 |
| 本地路径 | `/Users/huguiyuan/workspace/DSH plugin` ⚠️ 目录名带空格且与仓库名不一致 |
| npm | `dsh-lenovo-toolkit@0.1.0` 已发布 |
| 形态 | Skill（项目级）+ Cordis Plugin（bundle），两种都可用 |
| 工具组 | 1 个（电池），注册 3 个 DSH 工具 |
| 测试 | 12 通过 1 跳过（`npm test`） |
| 平台 | macOS ✅ 实机验证 · Windows ⏳ **从未在真机跑过** |
| 埋点 | ❌ 无，转化数据完全空白 |

**收录状态**（三个目标站）：

| 站点 | 状态 |
|---|---|
| dshfind 等 topic 自动聚合站 | ✅ topic 已打，等各站刷新 |
| 1024Store（deepseek1024.com） | ⚠️ **已收录但有两条重复条目**，见下 |
| awesome-dsh-plugin | ⏳ 条目已备好，等 ≥10 提交 + ≥1 天门槛 |

---

## ⚠️ 最需要你先看的一件事：1024Store 上有两条重复条目

这是交接时**唯一处于不干净状态**的地方。

| 条目 id | 来源 | 安装验证 | 问题 |
|---|---|---|---|
| `1Ecc/dsh-plugin` | 我们提交的 [PR #263](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/263) | `unknown` / `not_checked` | **id 是旧仓库名**，仓库后来改名了 |
| `1Ecc/dsh-lenovo-toolkit` | 站点通过 topic 自动发现 | `verified` / `published_package` ✅ | 这条是好的 |

**成因**：先提交了目录 PR（用当时的仓库名 `dsh-plugin`），之后才把仓库改名成
`dsh-lenovo-toolkit`。GitHub 有 301 重定向所以链接不死，但目录里的 `id` 与真实仓库名对不上；
与此同时站点的自动发现服务又按新名字建了第二条。

**曾经出现过的「This catalog item has no verified install target」已经自好**——
npm 包发布后，自动发现的那条从 `entry_committed` 变成了 `verified` / `published_package`。

**待办（C-4）**：把 `catalog/plugins/1ecc--dsh-plugin.json` 改名并更新 `id`/`repository`
为新仓库名，或者直接删除它（因为自动发现的那条已经是 verified 状态，可能更干净）。
注意 1024Store 的规则：**更新或删除既有条目不走自动合并，需要维护者人工审核。**

**这件事在上一轮对话被打断，诊断做到一半。** 建议接手后先复核两条条目的实时状态再决定
是「改」还是「删」——如果自动发现那条已经完全够用，删掉旧条目可能比修正它更省事。

---

## 接手第一步（按顺序）

```bash
cd "/Users/huguiyuan/workspace/DSH plugin"
npm test                          # 应当 12 通过 1 跳过
git log --oneline | head          # 看最近做了什么
```

然后按这个顺序读：

1. **`AGENTS.md`** —— 硬性约束、单一事实来源、代码约定、高频陷阱。**动代码前必读。**
2. **`docs/vision.md`** —— 为什么做这个项目、要验证什么。**做决策前必读。**
3. **`docs/progress.md`** —— 做到哪了、踩过哪些坑、下一步计划。
4. `docs/marketplace-listing.md` —— 只在要动收录相关的事情时读。
5. `docs/tools/battery-health.md` —— 只在要动电池工具时读。

---

## 环境与账号

| 项 | 说明 |
|---|---|
| Node | ≥ 20（开发机上是 v24） |
| Python | `python3`，仅趋势图渲染用，只依赖标准库 |
| GitHub | 账号 `1Ecc`，SSH key 已绑定；`gh` CLI 已认证（keyring） |
| git 身份 | 只配了**本仓库局部**身份，用 noreply 邮箱；全局 git 身份是空的 |
| npm | `dsh-lenovo-toolkit` 已发布，发布账号需向原维护者确认 |
| 无构建步骤 | 插件是 ESM JS，改完直接生效 |

⚠️ 本地目录名 `DSH plugin` 带空格且与仓库名不符。脚本里路径都做了引号处理，
但如果你要写新脚本，注意别漏引号。想改目录名的话，改完记得 `git remote` 不受影响
（remote 是 SSH URL，与本地目录名无关）。

---

## 进行中／未完成

按建议的优先级排：

| # | 事项 | 为什么优先 | 阻塞 |
|---|---|---|---|
| 1 | **实测 `dsh plugin add` 能不能装上** | 「装不上」是用户的第一印象；目录站 CI 只校验 manifest 形状，不安装不执行，**没人替我们验证过** | 需要能跑 DSH 的环境 |
| 2 | **实测 Cordis 工具注册** | 同上，按官方文档写的，未在真实运行时验证 | 同上 |
| 3 | C-4：清理 1024Store 重复条目 | 见上文 | 需人工审核，等维护者 |
| 4 | Windows 实机验证 | 能力矩阵最大空白；重点核 `powercfg /batteryreport /xml` 里 `HistoryEntry` 的容量字段层级 | 需要 Windows 机器 |
| 5 | C-3：提交 awesome-dsh-plugin | 权重最大的目录站（13.2k stars） | 需 ≥10 提交（当前 7）+ 仓库满 1 天 |
| 6 | CI 跑测试 | 目录站看重「活跃维护」 | 无 |
| 7 | `screenshots.json` + 趋势图样例 | 市场详情页会展示 | 无 |
| 8 | **埋点** | H3 假设完全没数据 | 需定埋点方案 |
| 9 | 第二个工具组 | 验证 H4「模式可复制」 | 需选题 |

第 1、2 项是**最该先做的**：它们是整条链路上唯一没有被任何人验证过的环节，
而且失败的话前面所有工作的价值都会打折。

C-3 的条目内容已经写好放在 `docs/listing/awesome-dsh-plugin.yml`，达标后照注释走。
**不要为了凑够 10 个提交而造空提交**，理由写在 `AGENTS.md` 的提交约定里。

---

## 待决策（这些不是技术问题，需要人拍板）

| # | 事项 | 说明 |
|---|---|---|
| 1 | **品牌归属** | 用 `lenovo` 命名的公共仓 + npm 包挂在个人账号 `1Ecc` 下，外部会默认是联想官方发布。README 顶部当前按「个人试点」写了免责声明。**如果是官方项目，应迁到 Lenovo 组织下并改写那段。** 目录站会核对描述真实性。 |
| 2 | **内部策略是否继续公开** | `references/lenovo-offers.md` 含试点触发条件、试点范围、埋点建议。仓库 public 且已打 topic，这些已被目录站索引。**这是不可撤回的**——改 private 挡不住已缓存的内容。正式推广前要决定：抽成本地配置，还是接受公开。 |
| 3 | 拯救者电池商品 ID | 需求方给的链接**显示文本是 `1045746`、href 是 `1045747`**，两者不一致。当前用的是 href 值，需核对。 |
| 4 | 商品链接巡检责任人 | 商品 ID 会失效，需要有人定期核对。 |

---

## 千万别做的事

- **不要为了让推荐能触发而调整诊断口径、阈值或措辞。** 这是这个项目的立身之本，
  详见 `AGENTS.md` 第 1 条约束。
- **不要直接改 `.claude/skills/`** —— 那是派生副本，下次同步会被覆盖。改 `.dsh/skills/`。
- **不要给采集脚本引入第三方依赖。** 它们要能直接扔到客户机器上跑。
- **不要把未验证的部分说成已验证。** Windows、`dsh plugin add`、Cordis 运行时注册
  这三项目前都没验证过，写对外材料时必须如实标注。
- **不要擅自打 topic / 提第三方 PR / 发 npm / 改仓库名。** 这些都是对外动作，先确认。
  改仓库名尤其危险——我们已经因此产生了一条重复条目。

---

## 怎么核对当前状态

状态类信息会过期，接手时跑这几条拿实时值：

```bash
# 仓库与提交数
git rev-list --count HEAD
gh repo view 1Ecc/dsh-lenovo-toolkit --json name,visibility,createdAt,repositoryTopics

# npm
curl -s https://registry.npmjs.org/dsh-lenovo-toolkit | python3 -c "import sys,json;print(json.load(sys.stdin)['dist-tags'])"

# 1024Store 上两条条目的实时状态
for id in "1Ecc/dsh-plugin" "1Ecc/dsh-lenovo-toolkit"; do
  curl -s "https://deepseek1024.com/api/v1/plugins/$id" | python3 -c "
import sys,json;d=json.load(sys.stdin);m=(d.get('installMethods') or [{}])[0]
print(d['id'], '| cat=', d.get('category',{}).get('id'), '| verify=', m.get('verification'), '|', m.get('code'))"
done

# dshfind 是否已收录
curl -s --get 'https://api.dshfind.com/v1/plugins' --data-urlencode 'owner=1Ecc' | python3 -c "
import sys,json;print('条数:', len(json.load(sys.stdin).get('data',[])))"
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
