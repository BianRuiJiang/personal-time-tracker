# 个人时间记录

一个部署在 GitHub Pages、数据存储在 Supabase PostgreSQL 的极简时间记录应用。支持邮箱登录、多设备同步、快捷按钮、自动睡眠、无交互自动暂停和原始数据导出。

## 使用

1. 打开网页。
2. 使用邮箱和密码注册或登录。
3. 输入活动后点击「开始记录」，或点击自定义快捷按钮立即切换。
4. 在「明细」里查看、选择日期或删除误操作记录。
5. 在「导出」里下载当日或全部 CSV / JSON。

应用使用 `Asia/Shanghai` 时区。统计日从每天 05:00 到次日 05:00。每天北京时间 23:00 自动开始「睡觉」，07:00 自动结束；连续 120 分钟无交互时，活动结束时间按最后一次交互加 120 分钟计算。自动化由 Supabase pg_cron 执行，不依赖浏览器保持打开。

## 本地开发

```bash
npm install
cp .env.example .env.local
npm run dev
npm test
npm run build
```

`.env.local` 只用于本地开发，不能提交。

## 部署配置

1. Supabase 控制台打开 **SQL Editor**，完整粘贴并执行 [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql)。
2. 确认 **Database > Extensions** 中 `pg_cron` 已启用；执行迁移后检查 **Database > Cron jobs** 是否有三个任务。
3. 打开 **Authentication > URL Configuration**：
   - Site URL：`https://<你的 GitHub 用户名>.github.io/personal-time-tracker/`
   - Redirect URLs：加入同一地址。
4. 首次注册前，可在 **Authentication > Providers > Email** 暂时关闭 **Confirm email**，便于本地和第一次部署验证。开启邮箱确认时需保证 Supabase 邮件可达。
5. GitHub 仓库打开 **Settings > Secrets and variables > Actions > Variables**，添加：
   - `VITE_SUPABASE_URL` = `https://noiazbpozqxayhkksvsx.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = 你的 Supabase publishable key
6. GitHub 仓库打开 **Settings > Pages**，Source 选择 **GitHub Actions**。
7. 推送到 `main` 后，Actions 会自动测试、构建并部署。

只需要 publishable key，浏览器代码不含 `service_role`、`sb_secret_` 或数据库密码。不要把高权限密钥写入 GitHub 变量。

## 测试

- PGlite 数据库测试覆盖切换、并发唯一约束、自动暂停幂等、睡眠计划幂等、用户隔离和历史删除。
- Vitest 界面测试覆盖默认按钮、自定义按钮、删除确认、导出调用和响应式规则。
- 时间测试覆盖统计日边界、睡眠跨日拆分和导出格式。
- CI 额外执行 TypeScript 检查和 Vite 生产构建。
