# ali-grumat 部署记录

日期：2026-10-14（Asia/Shanghai）。用户授权直接配置服务器，网站继续由 GitHub → Cloudflare Workers 自动构建部署。

## 2026-10-16 实时复核

再次通过 `ali-grumat` 检查：API 与隧道均 active、enabled，Linger=yes；服务器 `/health` 返回 HTTP 200、backend=postgres；本机统计为材料 20、相 10。当前隧道仍为 `https://magnitude-indexes-aviation-middle.trycloudflare.com`，其公网统计返回 HTTP 200、材料 20。

因此服务器端已部署并可通过 HTTPS API 读取。Cloudflare 网站是否完成运行时和构建变量配置仍须单独确认；不能将隧道成功等同于网站端到端验收成功。GitHub 只负责网站代码与构建触发，数据库内容不进入 GitHub。

## 当前结果

- SSH 别名：`ali-grumat`，登录用户 `wangzy`，home 为 `/home/wangzy`。
- 服务器 x86_64，检查时总内存 3627 MiB、可用 2965 MiB。
- 已有 PostgreSQL 监听回环地址 5432；没有对公网开放数据库。
- 原平台目录：`/home/wangzy/calypso-preview/materials-backend-lab`。
- 原备份清单：`/home/wangzy/calypso-migration/manifest.json`。
- 数据库复制在启动服务前通过严格校验：26 张表的行数、内容 SHA-256 和字段一致，1 条序列状态一致。没有重新 pg_restore 或导入材料。
- 平台 API 已配置允许网站 Origin `https://calypso-db-web.wangzy-physics.workers.dev`，会话／注销 Cookie 使用 Secure。
- 用户级服务 `calypso-api.service` 与 `calypso-tunnel.service` 已启用并运行；`Linger=yes`，退出 SSH 后继续运行。
- 临时 HTTPS API：`https://magnitude-indexes-aviation-middle.trycloudflare.com`。
- 已从该 HTTPS 地址读取统计，HTTP 200，材料 20、相 10、展示结构 20。
- Cloudflare 网站运行时变量待用户配置，网站到服务器的完整验收尚未确认。

上述 URL 是公开 API 入口，不能把随机域名视为团队身份认证；已有 API 的账号、投稿权限继续由后端判断。此次未配置额外 Cloudflare Access 身份策略。

## 已执行的服务器变更

1. 只读检查账号、资源、端口、Node 路径、服务管理状态和后端版本；没有输出连接文件内的密码。
2. 上传 `src/platform/runtime-config.mjs` 与 `scripts/configure-cloudflare-runtime.mjs`。
3. 执行：

```sh
cd ~/calypso-preview/materials-backend-lab
~/.local/calypso-runtime/node-v22.20.0-linux-x64/bin/node \
  scripts/migration-backup.mjs verify ~/calypso-migration/manifest.json
~/.local/calypso-runtime/node-v22.20.0-linux-x64/bin/node \
  scripts/configure-cloudflare-runtime.mjs
~/.local/calypso-runtime/node-v22.20.0-linux-x64/bin/node \
  --check src/platform/server.mjs
```

补丁原文件保存为 `src/platform/server.mjs.before-cloudflare-runtime`。只补 Origin 与 Cookie／CLI 配置，没有用当前更高版本源码覆盖服务器，避免引入其他数据库迁移。

4. `sudo -n` 不可用；改用用户目录和用户级 systemd，不安装系统软件。执行 `loginctl enable-linger wangzy` 成功，随后检查 `Linger=yes`。
5. 安装 Cloudflare 官方 `cloudflared` 2026.10.0 到 `~/.local/bin/cloudflared`。服务器直接从 GitHub 下载慢，改在 Mac 下载同一官方资产并上传；本机下载和服务器接收均核对官方资产 SHA-256：

```text
d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db
```

官方资产来源为 GitHub `cloudflare/cloudflared` 的 `2026.10.0` release，资产 `cloudflared-linux-amd64`。只停止本次创建的慢下载进程，未停止其他服务器进程。来源与校验记录保存在服务器 `.local/cloudflared-release.json`。
6. 用户服务文件位于 `~/.config/systemd/user`，本地同名副本保存在本目录。API 用 Node 22.20.0，隧道强制 HTTP/2，并设置 `--http-host-header localhost` 保持现有 API 回环 Host 校验。
7. 执行 `systemctl --user daemon-reload`，再分别 `enable --now calypso-api.service` 和 `enable --now calypso-tunnel.service`。服务故障会自动重启。

## 实际功能检查

- API 启动后本机统计接口 HTTP 200。
- 创建一个匿名会话验证 Cookie，检查 Secure、HttpOnly 与 CSRF 值存在，不记录 Cookie／CSRF 令牌。此操作只新增正常会话，不读取账号密码。
- 配置的网站 Origin + 正确会话／CSRF，空登录字段返回 400，说明通过来源检查后进入字段校验。
- 外部网站 Origin 返回 403。
- 隧道日志显示连接已注册，HTTP/2；ICMP/ping 权限提示不影响本次 HTTP API。未因此修改内核或安全组。
- HTTPS 隧道统计接口 HTTP 200，记录保存于服务器 `.local/cloudflare-api-verification.json`。

启动后会话等运行数据允许正常变化，不能再用恢复前的全表哈希要求运行库始终不变。

## 用户需要配置的 Cloudflare 项

现有 Worker：`calypso-db-web`。在 Settings → Variables and Secrets 设置**运行时**文本绑定并保存部署：

```dotenv
CALYPSO_BACKEND_MODE=remote
CALYPSO_REMOTE_BACKEND_URL=https://magnitude-indexes-aviation-middle.trycloudflare.com
```

不能只设置构建阶段变量；`.dev.vars` 也不能代替线上绑定。API origin 不含路径或查询参数。

如果前端仍显示服务未配置，在 GitHub 自动构建使用的 Build 环境变量中确认：

```dotenv
NEXT_PUBLIC_MATERIALS_API_BASE=/api/materials
NEXT_PUBLIC_MATERIALS_PREVIEW_PATH=/previews
NEXT_PUBLIC_AUTH_API_BASE=/api/identity
NEXT_PUBLIC_CONTRIBUTIONS_API_BASE=/api/contributions
NEXT_PUBLIC_ENABLE_LOCAL_ACCOUNTS=false
NEXT_PUBLIC_ENABLE_DEMO_ACCOUNTS=false
```

这些公共值只包含同源路径／开关，没有数据库密码；修改后重新触发构建。网站代码无需因本次服务器部署而重写；此次也未向 GitHub 提交或推送代码。

## 管理命令

在服务器以 wangzy 执行：

```sh
systemctl --user status calypso-api.service calypso-tunnel.service
journalctl --user -u calypso-api.service -n 30 --no-pager
journalctl --user -u calypso-tunnel.service -n 50 --no-pager
systemctl --user restart calypso-api.service
```

Quick Tunnel 重启或服务器重启后通常生成新的随机地址，需要从隧道日志取得新 URL 并更新 Cloudflare 的远程 URL。网络短暂中断的内部重连与进程重启不同，不必主动重启以排查所有问题。该临时入口不提供可用性保证；固定域名可后续改为命名 Tunnel。

## 回滚

如需撤销本次公网服务：

```sh
systemctl --user disable --now calypso-tunnel.service calypso-api.service
```

在确认 API 已停止后，恢复 `server.mjs.before-cloudflare-runtime` 可回到原本机配置。数据库保持，不删除 schema，不再次恢复旧备份。用户留驻可能被其他服务使用，回滚本应用时不自动关闭留驻或删除其他用户服务。

Cloudflare 网站恢复此前可用目标／部署；切回 local 只适用于本地开发，远端 Worker 无法访问开发电脑的 127.0.0.1。
