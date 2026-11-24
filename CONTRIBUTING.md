# 贡献指南

## 提交前检查

```bash
npm ci
npm run check
npm run test:all
npm run pack
```

## 项目约定

- `src/` 是 AIUI 唯一导入根；修改后必须运行结构检查、测试和打包。
- 眼镜页面保持纯黑 `#000000` 光学透明底，避免全屏彩色渐变、雾面或大面积光晕。
- 不提交真实 Bot ID、数据库表 ID、账号资料、设备日志、原始 IMU 研究数据或本地路径。
- 个人配置写入 `src/lib/service-config.local.js`（已忽略）。只修改 `config/service-config.example.js` 里的公开示例值。
- 排行榜共享成绩表使用 `rw_mode: 3`，私有表不批量修改权限；跨账号验收使用真实账号。
- 原始 IMU 不进入成绩接口。谱面目标与游戏准确率不能作为真实动作标签或识别准确率。
- 新增第三方素材时必须同时提交作者、来源、许可和修改说明。

应用云端更新与上架由项目维护者在 AIUI Studio 手动完成。
