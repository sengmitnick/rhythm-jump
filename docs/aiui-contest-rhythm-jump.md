# 用灵珠做后端、用 IMU 做输入：AIUI 体感游戏「节奏开跳」开源实践

> 征文活动：[AIUI 十二月征文计划](https://forum.rokid.com/post/detail/3911)
> 开源仓库：[https://github.com/sengmitnick/rhythm-jump](https://github.com/sengmitnick/rhythm-jump)
> 智能体名称：节奏开跳　｜　AIUI ID：【真实 AIUI ID】　｜　上架状态：【未提交 / 审核中 / 已上架，附真实链接】

「节奏开跳」是一款运行在 Rokid AI 眼镜上的体感节奏游戏：玩家不做任何手柄操作，跟着音乐和迎面而来的空间箭头完成**左跨、右跨、原地起跳**，眼镜 IMU 负责判断动作和时机，画面、声音、分数与排行榜给出即时反馈。

这篇文章只讲两个核心：

1. **怎么用灵珠（Lingzhu）当后端，做出一个真正跨账号共享的排行榜；**
2. **怎么把头部单点 IMU 变成可玩、可解释的体感输入。**

其余属于支撑部分，源码里都有。文章里出现的每个结论，都标明了它是「自动化测试」「Studio 预览」还是「真机证据」。

---

## 一、先说结论：两个核心分别解决了什么

| 核心 | 要解决的问题 | 本项目给出的答案 |
| --- | --- | --- |
| 灵珠做后端 | AIUI 应用没有自带服务器，成绩想跨账号比较就必须有云端存储和查询 | 灵珠数据表存成绩，工作流做校验/去重/排名，AIX 通过 `api.agent.invokeAgentApi` 以流式协议调用 |
| IMU 做输入 | 眼镜只有一个头部传感器，看不到手脚 | 不追求全身追踪，只把「重心横向移动」和「失重起跳」两类头部可观测信号设计成玩法 |

这两个核心共享一条铁律：**能观测到什么，就只承诺什么。** 排行榜不假装分数可信，体感不假装肢体被追踪。

---

## 二、核心一：把头部 IMU 变成节奏输入

### 2.1 为什么只保留三个动作

头部单点 IMU 能稳定观察到的是「整个身体重心变化传到头部的运动」，而不是四肢位置。手臂挥动、脚步落地在头部信号里往往很弱，甚至被走路、说话、扶眼镜淹没。

所以玩法只保留三个动作，它们都有清晰的头部特征：

- **左跨 / 右跨**：横向加速度出现方向明确的一次推进并回稳；
- **原地起跳**：合加速度出现短暂失重，随后落地冲击。

下蹲等动作在早期实现里做过，但可观测性和可玩性都不如这三个，最终从谱面和绘制中一起关掉。**动作设计本身就是传感器可观测性设计。**

### 2.2 先建坐标系，再谈识别

原始加速度是设备坐标系的读数。玩家站着不动时重力方向的分布，会因为佩戴角度、抬头低头而完全不同。直接拿 `accel.x` 判断左右，换个人就会失效。

[src/lib/body-state.js](src/lib/body-state.js) 的做法是：站稳平视时采一次基准四元数，把世界重力旋转到该姿态，得到「世界上方向」；再用基准姿态下的设备 X 轴投影到水平面，得到「世界右方向」。

```js
this.lateralAccel = dot(acceleration, this.worldRight);
const neckOffset = dot(
  rotateVectorByQuaternion(NECK_TO_SENSOR, quaternion),
  this.worldRight
);
```

这一步之后，所有判断都发生在与佩戴姿势无关的坐标系里。

### 2.3 校准不是「读一帧」

校准阶段需要的是**新鲜的加速度与四元数配对**，并检查：

- 眼镜是否处于合理佩戴方向（倒置读数要被拒绝）；
- 玩家是否站稳（静止噪声要足够小）；
- 数据是否连续到达，是否发生断流；
- 复用旧基准时，新读数是否仍接近旧姿态。

姿态明显变化、运动中传感器断流、应用退到后台，都会让旧基准失效。项目里有专门的测试覆盖「眼镜倒置后重新戴正能恢复」「校准复用需要新的配对数据」「最后一帧没有新数据要作废基准」。

### 2.4 左右跨：要的是「一次动作」，不是「当前位置」

最容易写错的地方：把侧移积分成一个位置，然后判断「位置偏左了就算左跨」。实际游玩时这个逻辑会连续得分，也会在玩家没动的时候误判。

正确做法是把侧移识别成**有起点、有方向、有回稳的一次事件**：

1. 去除重力，得到水平线性加速度；
2. 补偿头部相对颈部的圆弧运动（扭头不应该算跨步）；
3. 短时积分出速度和位移；
4. 达到阈值且方向明确时，产出一个 `dodge-left` / `dodge-right` 事件；
5. 事件被谱面消费一次后，同一动作不能再次得分。

```js
if (!this.strokeFired && this.strokeDirection * distance >= o.sideEnter) {
  this.strokeFired = true;
  this.lateralMove = {
    action: this.strokeDirection < 0 ? 'dodge-left' : 'dodge-right',
    at: now,
    distance
  };
}
```

在 [src/lib/game.js](src/lib/game.js) 里，这个事件带着自己的时间戳进入判定，并通过 `_usedMovement` 记录「这次动作已经被哪一拍用掉」，从根上解决一次动作刷多拍的问题。

### 2.5 起跳：用失重，不用积分高度

对加速度二次积分求高度，几秒钟就会漂移到无法使用。项目改用原始合加速度判断失重：

```js
const rawMagnitude = Math.hypot(accel.x, accel.y, accel.z);
const weightless = rawMagnitude < this.options.weightless;
```

失重进入 `airborne`，落地冲击清空它。起跳状态和侧移状态各自独立维护，最后由谱面决定当前这一拍需要哪个动作。

### 2.6 判定窗口，以及它不代表什么

[src/lib/game.js](src/lib/game.js) 的三层时间窗：

```js
export const PERFECT_MS = 90;
export const GOOD_MS = 180;
export const OK_MS = 400;
export const EXPIRE_MS = OK_MS + 40;
```

超出窗口仍未命中就记 Miss；暂停时时钟冻结；同一拍只结算一次。

**必须说清楚的一点**：结算页上的 `accuracy` 是「踩中谱面的比例」，属于游戏表现分，不是动作识别准确率。要评价后者，需要另采带人工标签的数据，并报告漏检、误检、方向混淆和静止误触发。项目里的研究日志明确标注 `groundTruth: 'not-labelled'`，本文也不会给出任何 Precision / Recall / F1 数字。

---

## 三、核心二：用灵珠做后端，做出跨账号排行榜

AIUI 应用本身没有自建服务器，这是很多体感、运动类应用的第一个坎：成绩存哪、谁来排名、怎么跨账号比较。灵珠提供了数据表 + 工作流 + API 智能体这套组合，正好可以当作轻后端。

### 3.1 数据模型：两张表，一次结算一行

| 表 | 作用 | 关键字段 |
| --- | --- | --- |
| `rhythm_user` | 用户快照 | `user_id`、`display_name`、`created_at`、`updated_at` |
| `rhythm_score` | 成绩流水 | `run_id`、`user_id`、`display_name`、`song_id`、`chart_version`、`score`、`played_at`、`score_basis` |

设计取舍：

- **每首歌每个谱面版本一个榜**：`song_id + chart_version`，改谱面就换版本，不会把旧成绩混进新判定标准里；
- **每人取最高分**，同分按最早 `played_at`；
- **全时段榜**，不做周榜重置，减少一次「结算时段」的复杂度；
- 保留 `score_basis = client_reported`，把信任边界写进数据本身。

完整字段定义见 [backend/v1/tables.csv](backend/v1/tables.csv) 与 [backend/v1/schema.sqlite.sql](backend/v1/schema.sqlite.sql)。

### 3.2 工作流：校验在前，查询在后，包装统一

```text
开始(USER_INPUT)
 └→ 代码 A：解析 / 校验（node_dispatch.py）
     └→ 选择器
         ├ score.submit      → 新增用户 → 新增成绩 → 查询本曲前 100 行 → 包装成绩
         ├ leaderboard.list  → 查询本曲前 100 行 → 包装榜单
         └ 否则              → 包装错误
                                  └→ 汇总（node_merge.py）→ 结束(output)
```

三个代码节点各管一件事：

- **代码 A（`node_dispatch.py`）**：校验协议外壳（顶层必须恰好是 `v / request_id / actor / op / data`）、曲目白名单、谱面版本、分数与判定数量的上下限，以及 `perfect + good + miss` 是否等于谱面音符数。校验结果压成 `payload_json` 传给后续节点。
- **代码 B（`node_wrap.py`）**：把查询回来的行按 `user_id` 去重取最高分、排序、分页，并算出本人名次。
- **汇总（`node_merge.py`）**：三个分支只有一条会产出，取第一个非空结果。

关键经验：**把校验集中在代码 A，数据节点只做「按条件写」和「按条件查」**。数据节点越简单，改曲目、改阈值时需要的改动就越少。

### 3.3 协议：一个自描述的 JSON 信封

请求是一个版本化的 JSON：

```json
{
  "v": "rhythm-jump/1",
  "request_id": "req_...",
  "actor": { "id": "rokid_account_id", "name": "玩家" },
  "op": "leaderboard.list",
  "data": { "song_id": "beatucada", "chart_version": 1, "limit": 8 }
}
```

`request_id` 不是装饰：客户端用它丢弃过期回包，避免上一首曲子的榜单画到当前结算页上。协议细节见 [backend/v1/protocol.md](backend/v1/protocol.md)。

### 3.4 客户端：流式回包比文档更难伺候

AIX 端通过 `api.agent.invokeAgentApi` 调用，返回的是流式事件。真实接入时会同时遇到好几种形态：

```js
stream = api.agent.invokeAgentApi({
  body: {
    conversation_id: this._conversationId,
    agent_id: this.agentId,
    question: JSON.stringify(envelope)
  }
});
```

[src/lib/leaderboard-client.js](src/lib/leaderboard-client.js) 做了几件现场才知道要做的事：

- 兼容分段 `message.content`、结束事件的 `final_answer`、`message.metadata.output`，以及灵珠 Bot 外层 `{"output":"..."}` 的包裹；
- 处理「先来一个空 end、随后才来正文」的真实时序，给结束事件一个短的宽限期再判失败；
- 解析前校验 `v` 与 `request_id`；
- 整条链路有总超时，流式错误与解析错误分开处理。

这些分支在测试里都有对应用例（空 end、仅 `final_answer`、部分内容回退到完整答案、工具回包穿透、超时拒绝等）。

### 3.5 踩得最疼的一坑：`rw_mode`

现象很有迷惑性：两个账号都能提交成绩，工作流查询语句里也确实只按 `song_id + chart_version` 过滤，但每个账号登录后**只能看到自己的成绩**。

问题不在 SQL，也不在排序代码，而在数据库表的权限模式：

| `rw_mode` | 含义 | 对排行榜的影响 |
| --- | --- | --- |
| `1` | 单用户读写 | 平台按调用者隔离记录，谁登录只看谁的 |
| `2` | 用户只读 | 玩家无法提交成绩 |
| `3` | 多用户读写 | 支持新增成绩 + 跨账号查询的共享榜单 |

**`rw_mode` 是表级属性，不是工作流属性，也不是 AIX 配置。** 共享成绩表必须是 `3`，账号资料表则保持自己的权限，不跟着批量放开。

修改时的纪律同样重要：

1. 先备份完整表配置（含字段 ID、顺序、类型、必填）；
2. 只改目标表的 `rw_mode`；
3. 回读确认表标识与字段都没变；
4. **用两个真实账号验收**——单账号试运行、在请求里换一个 `actor.id`，都不能证明平台的调用者隔离已经解除。

本项目只把 `rhythm_score` 从 `1` 改成 `3`，回读保留全部 14 个业务字段，修复后多账号历史成绩在同一榜单中可见。完整步骤（含备份脚本、回读核对、跨账号验收清单）整理在 [docs/lingzhu-leaderboard-rw-mode.md](docs/lingzhu-leaderboard-rw-mode.md)，可以直接给其他 AIUI 项目复用；这套接线与排障流程也整理成了可直接调用的技能 [rokid-lingzhu-backend](https://github.com/sengmitnick/rokid-lingzhu-backend)。

### 3.6 信任边界：排行榜能排，不代表分数可信

服务端会校验数量关系与上限，但**无法证明客户端真的做了那个动作**：`actor.id` 由客户端声明，改包就能冒充。因此：

- 榜单适合功能演示与普通游玩；
- 不适合发奖、正式竞赛或任何需要可信裁决的场景；
- 真要用于比赛，需要另加服务端验证、请求签名、防重放与可信身份链路。

把这句话写进 README 和协议文档，比写一个看起来很严谨的校验函数更诚实。

---

## 四、两个核心怎么接起来

### 4.1 本地永远优先

结算顺序是固定的：**先写本地 `rhythm-history`（最近 20 局），再尝试同步云端**。本地写失败会明确报错；云端失败只提示「排行榜未同步 · 本地已保存」。断网、未登录、后台还没发布，都不影响玩家看到自己这一局的结果。

### 4.2 离线是默认状态，不是异常状态

公开版本 `agentId` 默认为空，排行榜直接进离线态。这让仓库可以被任何人克隆后直接跑起来，也避免把作者的线上榜单暴露给所有下载者。

### 4.3 状态机把两个核心隔开

[src/lib/session.js](src/lib/session.js) 统一管理教程 / 校准 / 游玩 / 暂停 / 结算，排行榜只是其中一种页面状态。好处是：传感器断流只会暂停游戏，不会把结算页冲掉；从结算打开排行榜再返回，仍然回到原来的结算快照。

---

## 五、智能体 ID 不进仓库：示例配置 + 本地忽略

排行榜需要一个 Bot ID。把它写进源码再开源，等于把自己的线上入口交出去，别人还能往你的表里写数据。

所以仓库采用「示例配置 + 本地忽略」：

```text
config/service-config.example.js     ← 提交进仓库，agentId 为空
src/lib/service-config.local.js      ← git 忽略，存放真实 Bot ID
src/lib/service-config.js            ← 运行时入口，只做再导出
```

```bash
npm run config:init   # 第一次：从示例生成本地配置，已存在则不覆盖
```

配套的两个小设计：

- 所有 npm 脚本（`check` / `test` / `pack` / `preview`）都会先跑 `config:init`，所以新克隆的仓库**开箱即可检查、测试、打包**，不会因为缺文件而失败；
- `init` 永远不会覆盖已有文件，填好的配置在升级、拉取代码后依然保留。

同一套配置对象里还放着研究诊断开关（`motionDiagnostics`、`fullMotionTrace`）和本地日志接收地址，这些同样属于「个人环境参数」，一起走本地文件。

---

## 六、交互与界面

- **纯黑底**：眼镜端统一 `#000000` 光学透明底，只用单色绿细线画轮廓。原因是光学显示下大面积深色渐变会在视野里形成色膜，这不是审美偏好，是可读性问题。
- **轻量空间舞台**：一台约 46° 垂直视场的透视相机，投影贴地靶位、轨道和来袭箭头；头部转动只产生受限视差，HUD 固定不动。
- **两套输入**：镜腿滑动切换焦点并单击确认；也可以在菜单里转头瞄准，停留 3 秒确认。固件会把一次滑动上报成一串方向键，所以代码里加了滑动静默窗口，避免一次滑动跳好几项。
- **先教再玩**：首次进入是安全准备页与新手教程，左、右各成功两次再学起跳，教程不用倒计时 Miss 催人。

![选曲界面（AIUI 预览）](docs/images/song-select.png)
![新手教程（AIUI 预览）](docs/images/tutorial.png)
![对局界面（AIUI 预览）](docs/images/gameplay.png)

> 以上为 AIUI 预览素材，用来说明界面与交互设计，不作为真机动作识别效果或整局稳定性的证明。
> 【作者补充：如有真机照片或录屏，请在此追加，并注明设备型号、系统版本、录制日期与对应 Commit。】

---

## 七、验证：把三类证据分开说

### 7.1 自动化测试（可重复）

2026-11-24，从公开快照干净安装后执行：

```bash
npm ci --cache .npm-cache
npm run check
npm run test:all
npm run pack
```

| 检查 | 结果 |
| --- | --- |
| AIUI 结构检查 | 通过：2 个页面、25 个脚本（含一份本地配置），本地模块路径全部解析 |
| Node 自动化测试 | **186 项通过，0 失败** |
| 灵珠排行榜契约测试（Python + SQLite） | **15 项通过，0 失败** |
| AIX 打包 | 通过，`output/rhythm-jump.aix` 约 3.50 MB |

Node 测试覆盖：判定时间窗与过期 Miss、一次动作只结算一拍、合成 IMU 样本下的侧移与起跳、头动补偿、校准复用与断流、页面生命周期、纯黑背景与空间绘制、音频资源复用与失败回退、排行榜多种流式回包形态、研究日志的分块与异常路径。Python 契约测试覆盖协议外壳、分数上下限、榜单去重与排序，全部在内存 SQLite 上跑，不碰线上数据。

**这些是自动化夹具，不是真人识别准确率。** 记录见 [docs/validation.md](docs/validation.md)。

### 7.2 Studio 预览（可检查）

预览能核对页面加载、模块路径、布局、Canvas 绘制和部分交互流程。它证明不了真机上的采样率、时延、音频偏移、功耗和光学观感。

### 7.3 真机（本次未新增）

现有记录能支撑的真机结论只有一条：**用户已在眼镜端确认修复后的共享排行榜可见。** 本次公开快照没有做新的真机采样，因此本文不声称：

- 三首曲目都完成了整局真机验证；
- 达到了某个动作识别准确率；
- 完成了长时间功耗与稳定性验收；
- 应用已经上架。

【作者补充：最终真机验证表——设备型号、系统版本、Studio 版本、Commit、曲目、时长、已完成项、观察到的现象、失败项。】

---

## 八、复盘

**1. 设备能力要按最差情况设计。** 传感器会断流，回调会迟到，音频图有容量上限，存储会失败。生命周期、超时、回退和释放必须和玩法一起写，而不是最后再补。

**2. 传感器边界要写进玩法，而不是写进免责声明。** 看不全手脚，就把动作收敛到头部能看见的重心变化，让教程、谱面、判定共享同一套能力边界。

**3. 平台的权限模型比查询语句更先决。** 查询没写 `user_id` 不等于跨账号；`rw_mode` 才是那张表的隔离开关，而且必须用真实账号验收。

**4. 后端校验要和信任边界一起说。** 数量与上限校验能挡格式错误，挡不住伪造。把 `score_basis` 和「不用于发奖」写进文档，比事后解释便宜。

**5. 个人 ID 不应该进入开源仓库。** 示例配置 + 本地忽略 + 自动初始化，既保证开箱可用，也不泄露线上入口。

后续方向：采集带人工标签的多用户数据并分别报告漏检/误检/方向混淆；在真机上记录整曲帧间隔与音频偏移；榜单扩量后改服务端排序与分页；若要用于竞赛，再补可信提交链路。

---

## 九、开源与素材说明

```text
src/        AIUI 页面、IMU 判定、空间绘制、排行榜客户端
backend/v1/ 灵珠工作流代码节点、协议、表结构与契约测试
config/     智能体定义、服务配置示例
tests/      Node 自动化测试
tools/      结构检查、谱面导入、研究日志工具
docs/       验证记录、rw_mode 指南、预览素材
```

- 仓库：[https://github.com/sengmitnick/rhythm-jump](https://github.com/sengmitnick/rhythm-jump)
- 配套技能：[rokid-lingzhu-backend](https://github.com/sengmitnick/rokid-lingzhu-backend) —— 灵珠后端接线、流式回包排障与跨账号共享榜单的 Codex skill
- 原创代码：[MIT License](LICENSE)
- 第三方素材：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- 验证记录：[docs/validation.md](docs/validation.md)
- 对应版本：【Tag 或 Commit】

正式曲目来自 OutFox Serenity v2.5，署名与修改记录见 [src/assets/audio/serenity/CREDITS.txt](src/assets/audio/serenity/CREDITS.txt)：

| 内容 | 作者 | 许可 |
| --- | --- | --- |
| Beatucada | Kurio Prokos | CC BY-SA 4.0 |
| Into My Dream | Lagoona / Andreas Viklund | CC BY 4.0 |
| Summer Overload! | © 2022 Akako Hinami | CC BY-SA 4.0 |
| 三首 Beginner 谱面 | Daniel Rotwind | CC BY 4.0 |

项目把 SSC 谱面转换为带时间戳的左跨 / 起跳 / 右跨事件并省略下箭头，录音从 Opus 转为 64 kbps MP3，选曲试听使用 8 秒 48 kbps 片段；改编内容沿用源素材许可。旧练习谱面 Party Sector（Joth）按 CC0 1.0 使用。MIT 许可不覆盖第三方音频与谱面。

---

## 作者提交前核对项

- [ ] 补充作者昵称、真实 AIUI ID、实际上架状态与可核验链接。
- [ ] 补充最终 Tag / Commit、真机验证表与对应版本的截图或录屏。
- [ ] 如需给出识别指标，补充标注方法、样本量、负样本与 Precision / Recall / F1；否则不要填写。
- [ ] 论坛以「普通贴」发布到「征文计划」板块并保持公开可见。
- [ ] CSDN 发布同一篇原创文章，可见范围设为「全部可见」。
- [ ] 如参与多平台奖励，按活动规则补充对应平台链接与截图。
