# 联想接口背景与字段含义

> **非必读。** 操作步骤全在 `standalone-service.md`。这份只解释接口从哪来、字段什么意思、
> 为什么代码这样判——遇到 `UPSTREAM_*` 错误、字段含义疑问、或要向用户解释数据来源时再查。

接口全部来自联想官方站点前端 JS 的逆向（2026-09-11 抓取），没有稳定性承诺。接口一变，工具会报
`UPSTREAM_SHAPE`，这时按降级路径处理，不要编数据。实现在 `scripts/service-lib/api.mjs`（由仓库 `src/` 派生，不在 Skill 内改）。

## 1. 查保修（`warranty`）

| 项 | 值 |
|---|---|
| 页面 | https://newsupport.lenovo.com.cn/guardeploySearch.html?from=guarteen |
| 接口 A | `GET /api/machine/getmachineinfo?sn=<SN>` → 机型、**完整 MTM**、购机日期 |
| 接口 B | `GET /api/drive/<SN>/drivewarrantyinfo` → `data.detailinfo.{warranty,onsite,other}[]` |
| 登录 | 不需要 |

接口 A 顺带解决了完整 MTM 的问题：本机 WMI 只给 4 位机型代码（`82TL`），`machine.mtm`（`82TL007KCD`）只有这里有。

**电池是否在保不能只看整机。** 消费机的电池保修通常只跟随首年基础保修；延保条款经常写明「不包含电池」。判定规则：

| 情况 | `battery_covered` | 对用户怎么说 |
|---|---|---|
| 基础保修仍有效 | `true` | 电池随整机在保，到店免费检测更换（以门店核定为准） |
| 只有延保有效且条款写明不含电池 | `false` | 整机延保还在，但电池保外，需自费 |
| 有效延保未写明是否含电池 | `null` | **如实说不确定**，让门店核定 |
| 全部到期 | `false` | 保外 |

「智询常伴」这类软件咨询服务的 20 年期限和电池无关，代码已排除，不要把它说成"保修到 2044 年"。

## 2. 查备件价（`price`）

| 项 | 值 |
|---|---|
| 页面 | https://newsupport.lenovo.com.cn/pricesearchpc.html?sn=<SN> |
| 接口 | `GET /api/SmartFault/getSmartFaultPrice?machineNo=<SN>` |
| 登录 | 不需要 |

返回按部件名做 key（`电池`、`主板`…）：`machinePriceData.standard.media_price` 是**原厂标准备件价**（报给用户的数，不含工时）；
`preference / depot` 多数机型为 null；`faultPrice` 映射成 `repair_credit`。

**膨胀金是抵扣券，不是附加费用、不是定金。** 商品页原文："此膨胀金可双倍抵扣单台电脑的单次维修费用，不可叠加使用；过期退，未服务可退"——
付 ¥80 能抵 ¥160。但**倍数、适用门店、是否在售都不在接口里**（实测那张券写明仅限阳光雨露服务站，且已下架），
讲之前必须打开 `repair_credit.url` 核实。`available=false` 是联想没公示，引导打热线，**不要估价**。

## 3. 最近门店（`stores`）

| 项 | 值 |
|---|---|
| 页面 | https://newsupport.lenovo.com.cn/serverNet.html |
| 自动定位 | 官网同源的腾讯 `location/v1/ip`（官网 `js/tmap.js` 在 Chrome 下就是这么做的） |
| 地址覆盖 | 同源腾讯 `place/v1/suggestion`，把用户给的中心地址转成腾讯坐标 |
| 门店接口 | `GET /api/station/list?city=<城市>&type=笔记本&order_by=Distance&tencentLat=&tencentLng=` |
| 登录 | 不需要 |

- **门店接口不能省坐标。** 2026-09-14 实测北京市空坐标返回 `200404 / not find station`，补入坐标返回 76 家。所以入口始终先取坐标，
  不会把参数问题呈现成"该城市没有服务站"。
- IP 定位是粗定位（`precise=false`），展示时写明识别到的城市/区县并标"粗略排序"；VPN 会把位置带到出口所在地。
- 地址明确时入口自动选点；多个候选无法区分时返回 `location_selection_required`。区县级地名（以省/市/区/县结尾）算区域粗定位。
- 不要把 WGS84 坐标直接当腾讯坐标。
- `StationTitle` 是门店招牌名（对用户报这个），`StationName` 是承接公司工商全名（只做备注）。
- 附近门店（免登录 `station/list`）≠ 可预约门店（登录后的 `repair/appointment/station`），后者才是 `options` 核验的依据。

## 4. 预约链路

三个后端：`newsupport.lenovo.com.cn/api`（查询）、`csrecommend.lenovo.com.cn/api`（门店、时段、提交、鉴权）、
`servicesmall.lenovo.com.cn/api`（设备列表、服务类别、行政区划）。

鉴权两段式，缺一不可（照抄页面 JS 的拦截器）：
- `shop/login/check`：`cerpreg-passport` cookie → 用户 token（代表**用户**）。
- `oauth/token`：页面公开的 app_id/secret → 页面 token（代表**页面**，任何打开页面的人拿到的都一样）。
- `appoint/machine/*` 只带 `Authorization`（单数）；`repair/*` 带 `Authorizations`（复数）+ `Authenticates`。
  写错单复数的症状是返回 3001/3002/3004，看起来像 token 过期，实际是头名字不对。

提交：
- 提交前必须先 `checkServiceProductForSubmit` 换一段服务端签名（`bodyStr`），否则 434 拒掉。
- `repair_time` = `"YYYY-MM-DD HH:00:00"`（所选日期 + 时段起点），由代码从 `appointmentDate + timeBucket` 拼，模型不用记。
- 页面口径：当天的时段一律不可选，其余看 `free > 0`。
- 返回 444 = 该设备已有预约单（`ALREADY_BOOKED`）。
- payload 字段名混用下划线和驼峰，是联想那边的，不要"顺手统一"。

实机验证状态（2026-09-14，Windows）：地址查店、选店、拉起专用 Chrome、用户拼图与登录、读取鉴权、绑定设备、核验门店并取实时时段、
prepare、submit 全部跑通；上门时段来源未验证。

## 5. 联系人工

没有接入坐席系统。用户选人工时给 `400-990-8888`；不能宣称已转接、已排队或生成工单，不编造客服响应。
