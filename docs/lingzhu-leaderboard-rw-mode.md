# 灵珠共享排行榜：rw_mode 设置与修改方法

适用于使用灵珠数据库和工作流实现跨账号排行榜的 AIUI 项目。最后验证：2026-11-21，灵珠前端版本 1.12.1，节奏开跳。

## 先确定表权限

`rw_mode` 是**资源库中数据库表的权限属性**，不在工作流查询节点里，也不属于 AIX 配置。工作流访问表时会应用它；查询节点没有写 `user_id` 条件，并不代表查询已跨账号。

| rw_mode | 模式 | 对排行榜的影响 |
| --- | --- | --- |
| `1` | 单用户读写，LimitedReadWrite | 平台按调用者隔离记录；谁登录就只看到谁自己的成绩 |
| `2` | 用户只读，ReadOnly | 用户可以读取，不能新增成绩；开发者仍可管理数据，不适合玩家直接提交的成绩表 |
| `3` | 多用户读写，UnlimitedReadWrite | 可以跨用户查询成绩，适用于当前新增成绩、查询共享榜单的工作流 |

只把需要共享的成绩表设为 `3`，账号资料等私有表维持各自权限。模式 `3` 提供多用户读写能力，本身不等于“读取所有人、只能修改自己”；工作流应限定允许的操作。节奏开跳只开放新增成绩及查询榜单，没有更新、删除他人成绩的接口。

共享查询仍按真实 `user_id` 聚合每人的最高分；平台生成的 `uuid` 保持真实调用者归属，不通过伪造固定账号来凑出共享榜单。

## 典型故障及排查顺序

典型表现：开发者在资源库只看见自己，换账号登录游戏后又只看见新账号；两边都能提交成功，却无法互相看到成绩。

1. 核对使用的是同一张成绩表、同一环境、同一曲目和谱面版本。
2. 读取这张表的实际 `rw_mode`；如果为 `1`，先解决平台调用者隔离。
3. 再检查工作流查询是否额外按本人过滤，以及聚合、排序和返回字段。
4. 成绩行已经存在但页面不可用时，另查智能体正文流及客户端解析；空 SSE 回包与表权限是不同问题。

测试数据与线上数据相互隔离。修改 `rw_mode` 不会把测试库迁移到线上库，也不自动补齐从未提交的成绩；多用户共享仍受应用、渠道和所选环境边界约束，不代表不同应用或渠道自动互通。应用使用人数、完成正式曲目人数和榜单人数不是同一统计口径。

## 修改入口

从灵珠 **资源库 → 对应数据库表** 开始。若平台版本提供“表格权限模式”入口，可选择多用户读写后保存，并按下文回读验证。

2026-11-21 使用的页面没有显示权限切换控件。本次通过浏览器 DevTools 的 **Network → 编辑并重新发送 → 网络控制台** 调用平台自己的数据库接口完成修改。这是平台控制台使用的内部接口，不作为稳定公开 OpenAPI 契约。下面的接口及步骤在该版本实测有效；以后平台版本变化时，以资源库实际发出的请求为准。

API 基地址：`https://rcs.rokid.com/aiPlatform/api`。

| 用途 | 方法及地址 | 正文 |
| --- | --- | --- |
| 读取当前表配置 | `POST /memory/database/get_by_id` | `{"id":"目标数据库表ID"}` |
| 更新表配置 | `POST /memory/database/update` | 保留当前配置中的更新字段，仅修改 `rw_mode` |

### 1. 读取并备份

1. 登录灵珠，打开目标表，开启 DevTools 的 **Network／网络** 面板，再刷新资源库页面。
2. 找到 `get_by_id` 请求，确认请求正文 `id` 是目标表 ID。请求应返回 `code: 0` 和 `database_info`。
3. 右键该请求 → **编辑并重新发送**，打开 Edge 的网络控制台。保持 `POST` 和 JSON 正文。
4. 在 **Fetch → Credentials mode** 选择 **Include for all requests (include)**。这是同一平台现有登录会话的认证方式，不需复制 Cookie 或令牌。
5. 发送读取请求；在响应区点 **Download**，把完整响应保存为 `get_by_id.json`。这是改动前的备份。

本次网络控制台默认的 `same-origin` 不适用于这里的跨域 API，重放读取曾返回 `500 internal server error`；切到 `include` 后读取成功。遇到这一现象先核对会话认证，不能据此认定数据丢失。

使用的是网络请求编辑器，不是 JavaScript Console。若浏览器出现安全拦截，由操作者自行处理；自动化不要绕过警告。

### 2. 根据备份生成更新正文

**不要只发送 `id` 和 `rw_mode`，也不要手写重建 `field_list`。** 数据库更新接口会处理表结构，应保留当前字段及其 ID、顺序、类型、必填属性等信息。

该版本平台更新接口使用这些配置字段：`id`、`icon_uri`、`table_name`、`table_desc`、`field_list`、`rw_mode`、`prompt_disabled`，以及存在时的 `extra_info`。从读取结果生成正文，只把 `rw_mode` 改为 `3`。下面的本地脚本仅生成文件，不发送网络请求：

```bash
python3 - get_by_id.json rw-mode-update.json <<'PY'
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
response = json.loads(source.read_text())
assert response.get('code') == 0, '读取配置未成功'
info = response['database_info']
assert isinstance(info.get('id'), str) and info['id'], '缺少目标表 ID'
assert isinstance(info.get('field_list'), list) and info['field_list'], '字段列表为空'
assert info.get('rw_mode') in (1, 2, 3), '未知权限模式，先核对平台版本'
assert source.resolve() != target.resolve(), '不要覆盖原始备份'
keys = ('id', 'icon_uri', 'table_name', 'table_desc', 'field_list',
        'prompt_disabled', 'extra_info')
payload = {key: info[key] for key in keys if key in info}
payload['rw_mode'] = 3
target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
print('目标表:', info['table_name'], info['id'])
print('权限:', info['rw_mode'], '->', payload['rw_mode'])
print('保留字段数:', len(payload['field_list']))
print('已生成:', target)
PY
```

检查打印的表名和 ID，确认是本项目需要共享的成绩表。配置备份留在本地，不把登录凭据或原始账户元数据放入公开文档。

### 3. 保存并回读

1. 在网络控制台中，将 URL 改为 `https://rcs.rokid.com/aiPlatform/api/memory/database/update`，正文替换为生成文件的完整 JSON。保持 `POST`、`Content-Type: application/json` 和 credentials `include`。
2. 发送一次更新，检查响应业务码 `code: 0`；HTTP 200 本身不代表业务更新成功。
3. 把 URL 改回 `get_by_id`，正文恢复为 `{"id":"同一个目标表ID"}`，重新发送读取，下载为 `get_by_id-after.json`。
4. 核对 `rw_mode == 3`，并确认 `id`、`space_id`、`datamodel_table_id`、表名、描述、`field_list`、`prompt_disabled`、存在时的 `extra_info` 和原配置一致。以重新读取的持久化配置为准。

本次 `update` 成功响应中的部分元数据（如 `space_id`、`datamodel_table_id`）为零或空的占位值，随后 `get_by_id` 回读仍为原来的真实值。不要把更新响应当作完整持久化配置，也不要根据其中的占位值覆盖备份或再次更新。

如果需要恢复原权限，用原始备份按相同方式构造完整更新正文，恢复原 `rw_mode`，再回读核对。已有记录无需删除重建。

## 验收：必须跨真实账号

1. 使用真实账号 A、B，在同一环境完成同一曲目和谱面版本，确认两条成绩都已提交。
2. 分别打开该曲目的排行榜，确认都能看到 A、B；“你”的标记跟随当前登录账号。
3. 确认分数、排序、每人最高分及结算返回的本人名次一致。读榜与提交后查名次的两个查询节点都应使用同一张共享成绩表。
4. 如果客户端缓存了旧榜，退出榜单后重新打开，必要时等缓存过期；节奏开跳当前缓存为 60 秒。
5. 单账号试运行、在请求 JSON 里仅更换业务 `actor.id`、本地排序测试，都不能证明平台的调用者隔离已经解除。

本次修改表权限后立即生效，无需重新发布工作流或重新打包 AIX。其他项目修改后也应实际回读和查榜确认，不只凭更新接口成功判断完成。

## 节奏开跳验证记录

- 仅将共享成绩表 `rhythm_score` 从模式 `1` 改为 `3`，账号资料表 `rhythm_user` 不改。
- 修改前备份了完整表配置，修改后回读确认表标识和全部 14 个业务字段保持一致。
- 修复后，多个真实账号此前提交的成绩可以在同一曲目榜单中共同显示，无需重玩。
- 已在 Studio 实际查榜，并由用户在眼镜端确认共享榜单可见。配置备份和账号昵称不放入公开仓库。

## 实现核对来源

- [Rizon 1.12.1 数据库枚举及接口定义](https://static.rokidcdn.com/prod/coze-frontend/1.12.1/static/js/index~1.b1cc5520.js)：模式枚举与 get/update 请求字段。
- [Rizon 1.12.1 数据库页面实现](https://static.rokidcdn.com/prod/coze-frontend/1.12.1/static/js/async/1663.4173683e.js)：修改模式时复制当前数据库配置；本次版本的权限组件没有可见控件。
- 本项目实际 `get_by_id` 修改前/后响应、资源库历史记录、Studio 实际查榜及用户真机确认，构成本次修复依据。
