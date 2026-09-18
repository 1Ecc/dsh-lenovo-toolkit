# 服务操作手册：查保修 → 报价 → 门店 → 预约

只复制本 Skill 即可运行，零 npm 依赖，不依赖仓库其他目录或宿主注册的工具。
**每个响应都带 `next`（下一步做什么），错误也带**——照着 `next` 走，一般不需要回来翻这份文档。

## 一、运行环境

**只有一条规则：Node.js 22 或更新。** 不区分动作，不看别的版本。

- 不用提前判断。直接跑命令；脚本会自己检查，当前 Node 太旧时会在机器上找一个够新的 Node 接手，模型无感。
- 只有看到 `code=NODE_TOO_OLD` 才需要处理：`message` 里就是安装命令，交给用户执行，**装完重跑同一条命令**（不用改 PATH、不用重开终端）。
  - Windows：`winget install OpenJS.NodeJS.LTS`
  - macOS：`brew install node`
  - 或到 https://nodejs.org 下载 LTS 安装包
- 想知道当前是哪个 Node：`node --version`；想知道它在哪：Windows `(Get-Command node).Source`，macOS `which node`。仅排错时用。
- 登录还需要 Chrome 或 Edge（`status` 的 `browser_found` 报出探测结果）。查保修 / 报价 / 门店不需要浏览器。
- 联想官网与官网同源的腾讯位置接口需要可访问；VPN / 远程执行环境会让 IP 定位落在出口所在地。

## 二、调用方式（只有一种）

```text
node <skill_dir>/scripts/service.mjs <action> [--key value ...] [--ascii]
```

- 位置参数是动作名，字段用 `--key value` 传；`--confirmed` 这类开关不带值即为 true。中文可以直接写在参数里。
- **每次调用都是一个独立进程，状态保存在 `~/.battery-health-check/service-state.json`**（登录态、已选门店、待确认单据）。
  没有会话号、没有后台进程；上一条命令做完的事，下一条命令自动接着用。35 分钟没动作则视为过期，`close` 后删除。
- 看到中文乱码就加 `--ascii`：输出把非 ASCII 转成 `\uXXXX`，任何控制台都能原样读到。
- 引号实在处理不了时可以 `--b64 <base64>` 整体传一个 JSON 对象（UTF-8 JSON 的 base64）；一般用不到。
- 支持长驻 stdin 的宿主也可以 `node scripts/service.mjs --stdio`，每行一个 JSON；stdin 关闭即结束。
- 不要自己写中继脚本、不要把输出重定向到文件再读、不要后台运行；每条命令跑完就返回。

## 三、动作速查表

| action | 参数 | 响应要点 |
|---|---|---|
| `status` | — | `node_version` `browser_found` `authenticated` `browser_open` `selected_store` `submission_attempted`（仅排错用） |
| `quote` | `--sn` | `warranty.battery_covered`（true/false/null）`warranty.battery_note` `warranty.machine.mtm`；`price.available` `price.standard_price_cny` `price.repair_credit` |
| `warranty` / `price` | `--sn` | `quote` 的两半，需要单独重试时用 |
| `stores` | 无参数 = 官网同源腾讯 IP 定位；或 `--city` + `--address`；或 `--locationId`；或 `--city` + `--lat` + `--lng` + `--locationSource` | `stores[]`（code/name/address/phone/hours/distance_km）`location`（city/district/precise）`distance_is_estimate`；`state=location_required` 要位置；`state=location_selection_required` 让用户从 `locations` 选 |
| `select-store` | `--stationCode` | 记住门店，不启动浏览器 |
| `login` | 可选 `--stationCode`（= select-store + login）、`--browserPath`、宿主 CDP 的 `--endpoint` + `--targetId` | `state=waiting_for_login`；拉起专用 Chrome/Edge 窗口。浏览器还开着就复用，已关闭则重新拉起 |
| `order-page` | — | 用户已登录但 `auth` 读不到凭据时，打开预约站完成单点登录 |
| `auth` | 可选 `--sn`（默认沿用 `quote` 用过的） | `authenticated` `sn_bound` `service.is_store/is_door`；已选门店时**自动附带** `options`（门店核验 + `days`） |
| `options` | 可选 `--stationCode` | `selected_store` `days[].slots[].available`；`state=selected_store_unavailable` 时从 `stores` 改选 |
| `prepare` | `--stationCode` `--appointmentDate` `--timeBucket` `--name` `--phone` `--desc`（≤100 字；`--mode store`，默认） | `draft_id` `review`（含打码手机号），**不下单** |
| `submit` | `--draft_id` `--confirmed` | `submitted` `order`（可能为空对象）`review` |
| `close` | — | 关闭浏览器、删除状态文件；结束时必须调用 |

## 四、主线

```
报告触发推荐
  → quote --sn <device_serial>          保修 + 备件价
  → stores                              自动定位成功则一并拿到最近门店；失败不追问
  → 输出「服务推荐」节，用户二选一（预约 / 热线）
用户选预约
  → stores --city ... --address ...     沿用刚才成功的结果，或按用户提供的城市+地址；展示最近 + 2–3 家备选
  → login --stationCode <code>          用户本人在专用窗口登录（可能有拼图验证）
  → auth                                authenticated=true 且 sn_bound=true 才算成功；响应里已带 options.days
  → 用户选时段 + 提供姓名、手机号（可以一起问）
  → prepare --stationCode ... --appointmentDate ... --timeBucket ... --name ... --phone ... --desc "..."
                                        复述 review，补充保外备件价与工时限定
  → 用户明确确认 → submit --draft_id <id> --confirmed
  → close
```

- `desc` 用检测数字 + 用户诉求确定性拼接（如"电池健康度86.7%,循环140次,衰减速率偏快,用户反映续航不够用,要求更换原厂电池"），不放序列号以外的个人信息。
- 只能用 `days` 里 `available=true` 的时段；`prepare`/`submit` 都会再核一次。
- `submit` 成功但 `order` 为空对象：说"已提交但接口未返回工单号，请到「我的预约」核对"，**不编号码**。
- `submit` 一旦尝试（包括超时）禁止自动重发——"已尝试"标志写在状态文件里，重跑会被 `SUBMISSION_ALREADY_ATTEMPTED` 拦住；让用户核对「我的预约」。
  改门店/时段/联系人必须重新 `prepare`。
- 上门：以 `service.is_door` 为准，但独立入口的上门时段接口未验证，`--mode door` 会返回 `DOOR_SLOTS_UNVERIFIED`，不承诺上门闭环。
- 单据 10 分钟过期，鉴权 30 分钟过期。

## 五、登录与鉴权

- 默认路径 `login`：在独立临时用户目录里拉起一个普通可见的 Chrome/Edge 窗口，不碰用户日常浏览器的 profile 和 cookie 数据库。
  用户本人登录；`auth` 通过 CDP `Network.getCookies` 只读预约站的 `cerpreg-passport`（兼容 HttpOnly），在进程内换 token，
  模型只拿到 `authenticated / sn_bound / service`。关闭专用浏览器即清除登录态。
- **浏览器窗口必须在 `login` 和 `auth` 之间一直开着**（用户要在里面登录）。`login` 命令本身会立刻返回，窗口留在那里。
  Windows 上浏览器经系统 WMI 服务创建（响应里 `browser_launched_via=wmi`），不是本命令的子进程——宿主在命令结束时
  杀进程树、或等子进程句柄关闭，都影响不到它。`status` 的 `browser_open` 是真实探测结果，可用于确认窗口还在。
- **不询问 F12 / cookie，不让用户粘贴凭据，不把"用户说登录了"当作鉴权成功。** `auth` 返回 `waiting_for_login` 就继续等；
  用户坚持已登录时调 `order-page` 再 `auth`。`sn_bound=false` 让用户在预约页自行绑定设备后重新 `auth`。
- 宿主路径：只有宿主**明确提供**本机 CDP WebSocket 地址和联想页面的 `targetId` 时才 `login --endpoint ... --targetId ...`；
  不扫描端口、不连别的浏览器。关闭只断开连接，不关宿主浏览器。
- 浏览器被系统策略阻止时如实报告，不绕过。

## 六、降级路径（规定路径失败时怎么办）

| 情况 | 做法 |
|---|---|
| `NODE_TOO_OLD` | 把 `message` 里的安装命令给用户，装完重跑；不要尝试别的 Node 参数或版本开关 |
| `BROWSER_CLOSED` | 重新 `login` 一次让用户再登录。若刚 `login` 完、用户还没来得及登录就报这个错，说明本环境在命令结束时回收了浏览器，无法在线预约：如实告知，转热线 |
| `BROWSER_NOT_FOUND` | 让用户给一次 `--browserPath`；仍失败转热线 |
| `BROWSER_LAUNCH_FAILED` | 被系统策略阻止，如实报告，转热线 |
| `stores` 返回 `location_required` | 让用户给城市 + 中心地址/地标，`stores --city <市> --address <地标>` |
| 输出中文乱码 | 加 `--ascii` |
| 任何 `UPSTREAM_*` / `NETWORK` / `LOCATION_*` | 说"联想官网接口暂时不可用"，给 `source` / `manual_map_url` 里的页面链接让用户自查，不估数据；`submit` 阶段先核对「我的预约」 |

## 七、排错表

响应里的 `next` 已经写了下一步；这里只列需要额外判断的：

| code / state | 说明 |
|---|---|
| `waiting_for_login` | 等用户；用户说已登录 → `order-page` → `auth` |
| `LOGIN_REQUIRED` / `TOKEN_EXPIRED` | 在当前专用浏览器重新 `auth` 一次；仍失败报告接口鉴权异常 |
| `STATION_UNAVAILABLE` / `SLOT_UNAVAILABLE` | 重新 `options` 并让用户重选 |
| `SUBMISSION_ALREADY_ATTEMPTED` / `ALREADY_BOOKED` | 让用户看「我的预约」，不重试 |
| `DRAFT_EXPIRED` | 重新 `prepare` 并再次确认 |
| `SN_NOT_FOUND` | 让用户核对机身底部标签；非联想设备属正常 |
| `DOOR_SLOTS_UNVERIFIED` | 改约到店，或转热线 |

## 八、隐私边界

- 主机编号直接用本次诊断采集的，不再单独询问授权；手机号、联系人只在用户提供后用于 `prepare`，不进报告、不进对话之外的任何文件。
- 登录由用户本人在浏览器完成，agent 永远不代填账号、密码、验证码。
- 状态文件是登录 token 和待确认单据（含手机号）**唯一**允许存在的地方：只放用户目录、仅本人可读、35 分钟不动即作废、
  提交后单据即清除、`close` 后整个删除。原始 cookie 不落盘；文件内容不回显到模型输出。
