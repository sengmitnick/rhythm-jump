# 节奏开跳 · 灵珠排行榜示例

这个目录提供可复用的灵珠工作流代码节点和协议测试。后端只负责排行榜：两张表、两个有效操作，每首歌每个谱面版本一个全时段榜。

公开仓库不包含任何真实 Bot ID、数据库表 ID、玩家成绩或账号信息。默认 `agentId` 为空，游戏会离线保存最近成绩。

## 数据模型

- `rhythm_user`：`user_id`、`display_name`、`created_at`、`updated_at`。
- `rhythm_score`：一次结算一行；核心字段为 `run_id / user_id / display_name / song_id / song_title / chart_version / score / played_at / score_basis`，其余统计字段见 [tables.csv](tables.csv)。
- 以 `song_id + chart_version` 分榜，每人取最高分；同分按最早 `played_at`，再按 `user_id`。
- 共享成绩表必须使用多用户读写模式 `rw_mode: 3`，账号资料表保持私有。设置、备份、回读和跨账号验收见 [rw_mode 指南](../../docs/lingzhu-leaderboard-rw-mode.md)。

## 工作流

```text
开始(USER_INPUT)
 └→ 代码 A：解析/校验（node_dispatch.py）
     └→ 选择器
         ├ score.submit      → 新增用户 → 新增成绩 → 查询提交成绩 → 包装成绩
         ├ leaderboard.list  → 查询排行榜 → 包装榜单
         └ 否则              → 包装错误
                                  └→ 汇总 → 结束(output = 汇总.response_json)
```

- `score.submit`：写用户快照和成绩，查询本曲最近 100 行，返回提交结果和本人位置。
- `leaderboard.list`：查询同一窗口，返回前 8 名与本人位置。
- `node_dispatch.py`：校验固定协议、曲目、谱面版本与分数统计，输出数据节点变量及 `payload_json`。
- `node_wrap.py`：解析代码 A 的结果，对查询行按用户去重、排序和分页。
- `node_merge.py`：汇总各分支的 `response_json`。
- 数据节点按 `song_id` 与 `chart_version` 过滤，返回 100 行。字段映射和表结构以 [tables.csv](tables.csv) 为准。
- 结束节点返回文本 `{{output}}` 并开启流式输出。当前客户端兼容灵珠 Bot 的 `{"output":"..."}` 包裹格式。

完整字段与错误码见 [protocol.md](protocol.md)。

## 接入自己的应用

1. 在自己的灵珠环境创建 `rhythm_user` 与 `rhythm_score`，字段参考 [tables.csv](tables.csv)。
2. 按上图创建工作流，将三个代码文件分别放入对应代码节点，并连接新增、查询与包装节点。
3. 单独测试每个代码节点，再在工作流试运行中测试 `score.submit` 和 `leaderboard.list`。
4. 发布工作流和外层灵珠 API 智能体，将**自己的 Bot ID**填入 `src/lib/service-config.js` 的 `agentId`。
5. 使用两个真实账号完成同一首正式曲目，确认双方均能看到两条成绩。不要用单账号试运行或伪造 `actor.id` 代替跨账号验收。

## 本地契约测试

```bash
npm run test:backend
```

测试使用 Python 标准库和 SQLite，不连接真实灵珠环境，也不会写入线上数据。

## 安全边界

- 分数由客户端上报（`score_basis=client_reported`），服务端只做统计与上限校验，不能用于发奖或防作弊场景。
- `actor.id` 来自客户端声明，平台没有设备证明；修改客户端可以冒充账号。
- `total_players` 只统计查询窗口内的用户。用户量增大后应改为服务端排序与分页。
- 原始 IMU 研究日志不进入成绩协议。
