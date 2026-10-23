# 阿里云 PostgreSQL API 接入现有 Cloudflare 网站

2026-10-14。网站来源：`https://calypso-db-web.wangzy-physics.workers.dev`，用户确认由 Cloudflare 连接 GitHub 自动部署，免费方案。GitHub 网站仓库：`wangzyphysics/calypso-db-web`。用户已经在服务器本机访问到 `http://127.0.0.1:8877/api/materials/statistics`。

状态：连接步骤和后端配置补丁已准备；未替用户安装隧道、修改 Cloudflare 绑定或部署线上代码。公网链接尚未生成。

## 关系

```text
GitHub 网站代码 → Cloudflare 构建／部署

团队浏览器 → Cloudflare 网站 /api/* → HTTPS API 入口
                                      ↓ Tunnel
                          阿里云 127.0.0.1:8877 API
                                      ↓
                          阿里云 PostgreSQL
```

GitHub 保存代码，数据库留在服务器；数据库内容、密码、备份不上传网站仓库。网站仍用同源 API，浏览器不直接连接 PostgreSQL。

先按临时 Quick Tunnel 操作，无需先购买域名；后续需要固定地址时可改为有域名的命名 Tunnel。[Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)、[命名 Tunnel](https://developers.cloudflare.com/tunnel/get-started/)。Quick Tunnel 重建会换地址，停止进程就失效，不提供可用性保证。

## 1. Mac：将两个配置文件上传服务器

旧服务器源码需要增加可配置的网站 Origin 和 Secure Cookie。本次不替换整套源码，避免夹带后续其他功能或数据库迁移。

替换下面 `new-preview` 为你实际的新服务器 SSH 别名，然后执行：

```sh
cd '/Users/wangzhenyu/workplace/codex/数据库网站设计/materials-backend-lab'
scp src/platform/runtime-config.mjs \
  new-preview:~/calypso-preview/materials-backend-lab/src/platform/
scp scripts/configure-cloudflare-runtime.mjs \
  new-preview:~/calypso-preview/materials-backend-lab/scripts/
```

## 2. 服务器：补丁及 API 启动

先 Ctrl+C 停止现有平台 API，数据库保持运行。执行：

```sh
cd ~/calypso-preview/materials-backend-lab
node scripts/configure-cloudflare-runtime.mjs
node --check src/platform/server.mjs
export CALYPSO_ALLOWED_ORIGINS=https://calypso-db-web.wangzy-physics.workers.dev
export CALYPSO_SECURE_COOKIES=true
npm run platform:serve
```

补丁先检查旧版本匹配，并保存 `src/platform/server.mjs.before-cloudflare-runtime`；只调整会话 Cookie 和 CLI 的配置，不访问数据库。重复执行已补丁版本会直接返回。遇到版本不匹配会停止，不强行覆盖。

Origin 不包含 `/login` 或 `?returnTo=...`。它表示**网站**来源，不是稍后生成的 API 地址。保持 API 终端运行。环境变量只在当前终端有效，新开终端启动 API 需重新设置。

## 3. 服务器另一个终端：安装 cloudflared

Ubuntu 按 Cloudflare 官方软件源安装：[软件源说明](https://pkg.cloudflare.com/index.html)。

```sh
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update
sudo apt install -y cloudflared
cloudflared --version
```

不要更改 PostgreSQL 的回环监听或开放数据库端口。

## 4. 服务器：临时 HTTPS API 入口

```sh
cloudflared tunnel --url http://127.0.0.1:8877 --http-host-header localhost
```

记录打印出来的 `https://随机名称.trycloudflare.com`，这是**API origin**。Host 覆盖参数是为了满足当前 API 对回环 Host 的限制；保留服务自身检查，而不是放开所有 Host。

保持此终端运行。在 Mac 或第三个终端测试，将域名换成实际值：

```sh
curl --fail https://随机名称.trycloudflare.com/api/materials/statistics
```

应返回同样的 JSON，不能是邮箱登录 HTML、重定向或 403。此 Quick Tunnel 链接可以直接访问 API，地址保密不等于团队鉴权。先验证连接；后续要严格限制团队身份，需配置适合 Worker 的服务认证与网站访问控制，不在 API 入口设置仅支持交互浏览器的邮箱挑战后期待 Worker fetch 自动通过。

## 5. Cloudflare：网站 Worker 的运行时变量

打开 Cloudflare → Workers & Pages → 当前 `calypso-db-web` Worker → Settings → Variables and Secrets，设置运行时文本绑定：

```dotenv
CALYPSO_BACKEND_MODE=remote
CALYPSO_REMOTE_BACKEND_URL=https://随机名称.trycloudflare.com
```

第二项只填写 origin，不带 `/api/materials`、`/login` 或查询参数。保存并部署变量更改，使运行中的 Worker 读取新值。[变量说明](https://developers.cloudflare.com/workers/configuration/environment-variables/)。

不要把这些只设置成 Build 阶段的 shell 变量：当前代理从 `cloudflare:workers` 的 env 读取运行时绑定。`.dev.vars` 只用于本地，也不会自动配置线上。

若仓库的 Wrangler 配置声明了同名 vars，需同步部署配置或使用正确环境，避免下次 GitHub 自动部署覆盖目标。当前项目由 Vite 生成 `dist/server/wrangler.json`，不要修改生成文件作为长期配置。

## 6. Cloudflare：前端构建变量

网站前端客户端还需要同源服务路径。如果之前线上未配置，放在 GitHub 自动构建所用的 Build 环境变量中：

```dotenv
NEXT_PUBLIC_MATERIALS_API_BASE=/api/materials
NEXT_PUBLIC_MATERIALS_PREVIEW_PATH=/previews
NEXT_PUBLIC_AUTH_API_BASE=/api/identity
NEXT_PUBLIC_CONTRIBUTIONS_API_BASE=/api/contributions
NEXT_PUBLIC_ENABLE_LOCAL_ACCOUNTS=false
NEXT_PUBLIC_ENABLE_DEMO_ACCOUNTS=false
```

这些 NEXT_PUBLIC 值会进入前端构建；修改后重新触发 GitHub 集成的构建部署。没有密码或令牌。GitHub → Cloudflare 的已有构建关系保持，数据库不加入该流程。[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)。

当前本地仓库已有 `lib/backend-target.ts`、同源代理和 API 路由。确认 Cloudflare 所用分支也包含它们；本次未替用户提交／推送代码，不能只凭本地文件存在认定线上构建已使用它。

## 7. 从网站域名验收

```sh
curl --fail https://calypso-db-web.wangzy-physics.workers.dev/api/materials/statistics
```

应返回服务器数据库统计。然后打开网站登录页，使用迁移过来的实际可登录账号，检查登录、材料检索和投稿。

常见错误：

| 现象 | 先检查 |
|---|---|
| Remote database API is not configured | Worker 运行时的 mode／URL，不能只设置构建变量 |
| 403 Local service only | 隧道的 HTTP Host Header 是否为 localhost |
| 403 Invalid origin or CSRF token | API 是否以实际网站 Origin 启动；是否先取得同源会话和 CSRF |
| 页面仍显示未配置 | NEXT_PUBLIC 构建变量，以及是否重新构建 |
| API 返回 HTML | 隧道认证挑战、错误地址或入口重定向 |
| 网站显示 API 不可达 | API／隧道进程是否仍运行；Quick Tunnel 地址是否变化 |

## 8. 测试与回滚记录

本地新增 runtime-config 测试覆盖准确 Origin、拒绝 URL 路径和不安全远程 Cookie、HTTPS 会话签发与注销 Cookie、API 实际 HTTP Origin／CSRF 校验。独立副本的 6 项领域／配置测试及 22 项 PostgreSQL 平台测试通过，写入仅发生在专属临时数据库。

补丁已在此前上传包中的旧 server.mjs 副本上测试：语法检查通过，重复执行不会再次修改。服务器上的实际执行和公网验收尚未完成。

回滚：停止 API，恢复已保存的 `server.mjs.before-cloudflare-runtime`，然后取消本次进程环境变量并按原本机模式启动；停止 Quick Tunnel 关闭临时公网入口。网站恢复此前实际可用的远程目标或部署版本；线上 Worker 切到 local 不能访问开发电脑的数据库。

不要在已经有新账号或投稿的远程库上重新 pg_restore 本地备份来处理网络问题。
