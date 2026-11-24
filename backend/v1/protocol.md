# 节奏开跳 · 灵珠排行榜协议 v1

状态：两张表已建，工作流已接线并发布（v0.0.2，2026-11-16）；灵珠试运行已跑通 `score.submit` 与 `leaderboard.list`。

## 1. 数据流

```text
AIX 页面
  → createOpenAPI()
  → api.agent.invokeAgentApi({ agent_id, question = JSON 字符串 })
  → 灵珠智能体 / 工作流
  → 代码A 解析校验
  → 选择器
      user.upsert      → 新增用户 → 更新用户 → 查询用户 → 代码B
      score.submit     → 新增成绩 → 查询本曲成绩 → 代码B
      leaderboard.list → 查询本曲成绩 → 代码B
      其他             → 代码B（直接返回 error_json）
  → 合并 → 结束(output = response_json)
  → SSE step=content 拼接
  → 页面 JSON.parse
```

## 2. 请求信封

`question` 必须是纯 JSON 字符串，不能带 Markdown 代码块或自然语言。

```json
{
  "v": "rhythm-jump/1",
  "request_id": "req_20261115_0001",
  "actor": { "id": "rokid_account_id", "name": "小林" },
  "op": "score.submit",
  "data": {
    "song_id": "party-full",
    "chart_version": 3,
    "run_id": "run_20261115_0001",
    "score": 65000,
    "max_combo": 40,
    "perfect": 60,
    "good": 10,
    "miss": 24
  }
}
```

规则：

- 顶层必须恰好是 `v`、`request_id`、`actor`、`op`、`data`；多余字段拒绝。
- `actor.id` 来自 `getProfile().accountId`，`actor.name` 来自 `userName`；客户端声明，平台没有可复验签名。
- `request_id` / `run_id` 允许 `A-Za-z0-9_.:-`，长度 1–100。
- 单次输入上限 24 KiB；禁止重复键、`NaN` / `Infinity`。
- 所有 ID 都是字符串；平台 64 位整数 ID 不能按 number 传。

## 3. 操作

| op | data | 说明 |
| --- | --- | --- |
| `user.upsert` | `{"display_name":"小林"}`，可省略 | 当前不写用户表，只返回合成用户；用户行由 `score.submit` 写入 |
| `score.submit` | 见上 | 提交一局成绩，返回本曲榜单和本人名次 |
| `leaderboard.list` | `{"song_id":"party-full","chart_version":3,"limit":8}` | 本曲全时段榜单；limit 1–20 |

### 曲目登记

代码 A 里维护一张很小的曲目表：

```python
SONGS = {
  'party-full': {'title': 'Party Sector', 'duration_ms': 96000,
                 'notes_by_version': {3: 94, 4: 69}},
  'beatucada': {'title': 'Beatucada', 'duration_ms': 108475,
                'notes_by_version': {1: 32}},
  'into-my-dream': {'title': 'Into My Dream', 'duration_ms': 146571,
                    'notes_by_version': {1: 54}},
  'summer-overload': {'title': 'Summer Overload!', 'duration_ms': 145424,
                      'notes_by_version': {1: 55}},
}
```

每新增一首曲目或更新谱面版本，都须更新代码 A 的曲目表和对应拍数，再发布工作流。

### score.submit 的服务端校验

- `perfect + good + miss == notes`，拍数按曲目和谱面版本读取
- `max_combo <= perfect + good`
- `score <= 1000 * perfect + 500 * good`
- `score` 在 `0..1000 * notes`
- `accuracy` 不由客户端上传，由服务端按 `perfect + 0.6 * good / notes` 计算
- `played_at` 由服务端 `time.time()` 写入

这能挡住秒结算、统计造假和明显超上限的分数，但挡不住重放一段真实成绩；榜单只作展示。

## 4. 响应

`score.submit` 和 `leaderboard.list` 的正文以 `RHYTHM_RESULT` 开头，换行后是协议 JSON。AIX 从正文中提取 JSON。灵珠部分调试入口也会返回 `{"output":"<response_json 字符串>"}`，客户端兼容这种包裹。


成功：

```json
{
  "v": "rhythm-jump/1",
  "request_id": "req_20261115_0001",
  "ok": true,
  "data": {
    "song_id": "party-full",
    "song_title": "Party Sector",
    "chart_version": 3,
    "score_basis": "client_reported",
    "entries": [
      { "position": 1, "is_me": 0, "display_name": "阿青", "score": 72000, "achieved_at_ms": 1794460000000 }
    ],
    "me": { "position": 3, "score": 65000 },
    "total_players": 4,
    "submitted": { "score": 65000, "position": 3, "is_best": 1 }
  },
  "error": null
}
```

`submitted` 只在 `score.submit` 出现。`me` 在未上榜或没有成绩时为 `null`。`total_players` 是本次查询窗口内去重后的人数（工作流取前 100 行）。

`user.upsert`：

```json
{"v":"rhythm-jump/1","request_id":"t1","ok":true,
 "data":{"user":{"user_id":"u1","display_name":"小林","created_at":1794460000000,"updated_at":1794460000000}},
 "error":null}
```

失败：

```json
{"v":"rhythm-jump/1","request_id":"...","ok":false,"data":null,
 "error":{"code":"INVALID_REQUEST","message":"字段、类型或范围不合法","retryable":false}}
```

### 错误码

| code | 含义 | 页面处理 |
| --- | --- | --- |
| `INVALID_REQUEST` | 字段、类型、范围不合法 | 不重试，记录异常 |
| `UNSUPPORTED_VERSION` | `v` 不匹配 | 升级客户端 |
| `UNKNOWN_OPERATION` | op 不存在 | 修正 |
| `DB_ERROR` | 写入/查询失败 | 可重试 |
| `NO_BRANCH` | 工作流没有分支产出结果 | 检查接线 |

## 5. 排行榜语义

- 每首歌、每个谱面版本一个榜：`song_id + chart_version`。
- 每个用户取最高分；同分按最早 `played_at`，再按 `user_id` 稳定排序。
- 只统计数据表里的成绩行；没有开局/结算表，也没有周榜重置。
- `entries` 目前最多返回 `limit` 条；页面默认 8 条。
- 客户端重试可能产生重复成绩行；榜单按用户去重，重复行不会改变最高分。为了减少重复，超时重试必须复用同一个 `run_id`。

## 6. 身份与安全边界

```js
const api = await createOpenAPI();
const profile = await api.account.getProfile();
const actor = {
  id: String(profile.accountId || ''),
  name: String(profile.userName || '玩家').slice(0, 24),
};
```

- `accountId` 是稳定标识；`userName` 可改、可重复，只能作展示名。
- 这两个值都来自客户端，平台没有设备证明；改包可以冒充任意 `accountId`。
- 不传手机号、头像、设备号等个人信息。
- 分数是客户端上报（`score_basis=client_reported`），不用于发奖。
- 用户表只作账号/展示名记录；榜单直接读成绩行里的 `display_name` 快照。
