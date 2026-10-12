# 个人时间记录

极简的个人时间记录网页：手机和电脑登录同一账号即可共享当前状态与历史记录。

- 线上地址：<https://bianruijiang.github.io/personal-time-tracker/>
- 技术栈：React + TypeScript + Vite + Supabase（PostgreSQL / Auth / Realtime）
- 托管：GitHub Pages，Actions 自动测试、构建、部署

## 使用

1. 用邮箱和密码注册或登录。
2. 在底部输入框写下正在做的事，点「记录」；或点自定义快捷按钮直接切换。
3. 中间列表按天展示记录，每条显示开始时刻与总时长。当前进行中的那条有绿色左条与描边。
4. 左滑单条记录露出「删除」，点一下即可删除。
5. 长按自定义快捷按钮可像移动桌面图标一样拖动排序。
6. 右上角「重置」会先自动下载当日 CSV，再清空全部记录（不弹确认框）。

写入策略：先在本地立即渲染，再同步到云端。同步失败会回滚到服务器状态并提示，不做离线队列。

## 时间规则

统一使用 `Asia/Shanghai`。

- 统计日从每天 05:00 到次日 05:00。
- 每天 23:00 自动结束当前活动并开始「睡觉」，次日 07:00 结束睡眠。
- 睡眠期间可以从界面直接记录新活动，切换时「睡觉」会在切换时刻自动结束。
- 连续 120 分钟无交互自动结束当前活动，结束时间按最后一次交互加 120 分钟计算。
- 自动化由 Supabase `pg_cron` 执行，不依赖浏览器保持打开；重复执行幂等。

## 本地开发

```bash
npm install
cp .env.example .env.local   # 填入 Supabase URL 与 publishable key
npm run dev
npm test
npm run build
```

`.env.local` 仅本地使用，已在 `.gitignore` 中排除。

## 部署配置

已完成（当前仓库状态）：

1. Supabase 数据库已应用 [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql)：3 张表、7 条 RLS 策略、5 个安全 RPC、3 个 pg_cron 定时任务。
2. Supabase **Authentication > URL Configuration** 已设置为 `https://bianruijiang.github.io/personal-time-tracker/`。
3. GitHub **Actions > Variables** 已配置 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_PUBLISHABLE_KEY`。
4. GitHub **Pages > Source** 已设为 GitHub Actions。

换新环境部署时需要重做上述四步，并确认 `pg_cron` 扩展可用。

只使用 publishable key；浏览器代码与仓库中不含 `service_role`、`sb_secret_`、数据库密码或任何访问令牌。

## 设计规范

全站配色与状态色统一由 [`docs/design-system.md`](docs/design-system.md) 定义，样式集中在 `src/styles.css` 的 `:root` 令牌，`tests/ui.test.tsx` 中有守护用例锁定色板。

## 测试

- `tests/database.test.ts`：切换活动、同名独立保存、并发唯一约束、自动暂停幂等、睡眠幂等、用户数据隔离、历史删除（PGlite 真实执行迁移 SQL）。
- `tests/ui.test.tsx`：当前活动展示、时间格式、默认/自定义按钮、左滑删除、长按拖动排序、重置、乐观写入与失败回滚、响应式与色板规则。
- `tests/time.test.ts`：统计日边界、跨日睡眠拆分、CSV/JSON 导出、时长格式。
- CI 额外执行 `tsc --noEmit` 与生产构建。
