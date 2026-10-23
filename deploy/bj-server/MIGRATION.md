# bj-server 数据库迁移记录

日期：2026-10-13（Asia/Shanghai）  
状态：**完成连接与资源检查；因资源余量不足暂缓部署。数据库尚未复制到远程。**

用户随后找到新服务器，决定自行执行迁移。可执行步骤及辅助脚本见 [手动迁移指南](../MANUAL_MIGRATION.md)；本页继续保留旧 bj-server 的实际检查记录，不能据新指南推断旧服务器已经迁移。

本文区分已经执行的操作与待执行步骤，不将预案记为成功迁移。不保存密码、SSH 私钥、账户派生密码或会话令牌。

## 1. 目标与范围

用户要求保留 Cloudflare 编译、部署网站的流程，将本地数据库复制一份到阿里云，并允许网站选择本地或远程后端。后来补充：如果当前约 400 MB 可用内存不足，暂不部署，考虑更换服务器。

目标连接为：

```sshconfig
Host bj-server
    HostName 39.107.94.61
    Port 22
    User server
```

目标架构：

```text
Cloudflare 网站 → 同源 /api/* 代理 → 服务器上的 HTTPS API → PostgreSQL
本地开发网站   → 同源 /api/* 代理 → 本机 API                → 本机 PostgreSQL
```

切换对象是 API 地址，数据库连接文件属于 API 后端。不会在浏览器中放数据库密码或提供任意数据库地址选择器。

本地代码已经增加账户、会话、投稿及审核功能，因此未来完整复制数据库时，应覆盖 `calypso_lab` 科学数据 schema 与 `calypso_platform` 平台 schema。仅使用原 `artifacts/transfer.json` 会遗漏账户、投稿和上传文件；它不是完整平台备份。

## 2. 已执行：服务器只读检查

通过现有 SSH 配置，非交互认证成功：

```sh
ssh -o BatchMode=yes -o ConnectTimeout=12 bj-server \
  'uname -a; id; df -h /; free -m; command -v docker; command -v psql; command -v node; command -v python3'
```

检查结果：

| 项目 | 实际结果 |
|---|---|
| 系统 | Ubuntu 22.04.4 LTS，Linux x86_64 |
| 用户 | `server`，UID/GID 1000；显示的所属组为 `server` |
| 磁盘 | 根分区约 40 GB，已用 19 GB，可用 19 GB |
| 内存 | total 1690 MiB，used 1070 MiB，free 70 MiB，available 421 MiB |
| Swap | 0 |
| Docker | `/usr/bin/docker` 存在，但用户不能访问 Docker socket |
| sudo | `sudo -n` 返回需要密码，没有免密 sudo 权限 |
| Node.js / psql | 本次 `command -v` 未发现 |
| Python | `/usr/bin/python3` |

追加只读检查：

```sh
ssh -o BatchMode=yes bj-server \
  'docker ps --format "{{.Names}} {{.Image}} {{.Ports}}"; sudo -n docker ps --format "{{.Names}} {{.Image}} {{.Ports}}"; sudo -n true; ss -lnt; cat /etc/os-release; ls -ld ~/calypso-preview'
```

Docker 命令因权限不足失败，**未获取容器清单**。监听端口包括 80、8080、3306、27017、27018、10290 等；仅据端口不能确认所有程序或其业务用途。目标 `~/calypso-preview` 当时不存在。没有修改安全组、停止容器、安装系统软件或创建远程数据目录。

## 3. 已执行：本地部署准备

在当前工作区创建了 `deploy/bj-server` 记录目录和 `.local/migration-bj` 空准备目录。没有生成或传输数据库备份。

为评估无 sudo 的用户目录部署，下载了固定版本运行包到本地 `/private/tmp`：

```sh
npm pack @embedded-postgres/linux-x64@18.4.0-beta.17 \
  --pack-destination /private/tmp --ignore-scripts
curl --fail --location --output /private/tmp/node-v22.20.0-linux-x64.tar.xz \
  https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz
curl --fail --location --output /private/tmp/node-v22.20.0-SHASUMS256.txt \
  https://nodejs.org/dist/v22.20.0/SHASUMS256.txt
```

Node 包 SHA-256 与官网同版本 SHASUMS256 文件一致：

```text
node-v22.20.0-linux-x64.tar.xz
00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc

embedded-postgres-linux-x64-18.4.0-beta.17.tgz
795d587bb466423385db256dc81e61f2ee40c9e10efde21e881f3e997dd1bdb2
```

PostgreSQL 包由 npm 下载并校验 registry 的包完整性；上面的 SHA-256 是本地归档指纹。两份运行包均**未上传、未在服务器安装或启动**，临时目录文件不视为长期交付或备份。

## 4. 暂缓决定

421 MiB 是当前可用内存，不是总内存。小型 PostgreSQL 与 Node API 可能可以启动，但这台服务器已经有现有服务，没有 swap，无法在未验证负载的情况下承诺上传、查询、密码登录时仍有足够余量。

遵照用户“400M如果不够，就算了，可能再换个服务器”的指示，本轮不继续远程安装与迁移，不压缩或停止已有业务。更换服务器后先重新检查实际资源；建议有约 2 GB 以上可用内存作为此临时平台的起始余量，这是工程建议，不是测试得出的硬性最低要求。

## 5. 已实现：网站本地／远程选择

选择器位于 `calypso-web/lib/backend-target.ts`，同源代理位于 `calypso-web/lib/local-backend-proxy.ts`。保留既有路由和函数导出以兼容当前网站。选择发生在 Worker 服务端绑定中，不修改本地 `.dev.vars`、`.env.local` 或线上设置。

本地开发配置：

```dotenv
CALYPSO_BACKEND_MODE=local
CALYPSO_LOCAL_BACKEND_URL=http://127.0.0.1:8877
```

未来远程评审配置（地址为占位符，当前没有可用远程 API）：

```dotenv
CALYPSO_BACKEND_MODE=remote
CALYPSO_REMOTE_BACKEND_URL=https://your-api.example.com
```

前端仍使用 `/api/materials`、`/api/identity`、`/api/contributions`，不在前端使用服务器数据库连接字符串。

规则：未设置 mode 时保持 local；local 只接受 HTTP 回环地址；remote 接受明确的 HTTPS 非回环 origin；禁止 URL 内用户名、密码、路径、查询和片段；缺少地址或服务失败返回 503，不自动切换到另一套数据。浏览器查询参数不能选择数据库。更改 Cloudflare 绑定后需让部署运行时读取新配置。

切换不会同步数据。两个数据库自复制时间点起可以各自产生更新，需明确后续哪一份为主库；不能简单覆盖远程新投稿或用户记录。

## 6. 下一台服务器上的迁移步骤（待执行）

以下是操作顺序，不是已执行的命令记录：

1. 检查系统、架构、可用内存、磁盘、已有服务、SSH 与安装权限。确认独立部署目录和未被占用的端口。
2. 在本地生成事务一致的完整备份，记录科学／平台 schema 版本、各表行数和哈希。备份需包含账户、投稿、`bytea` 文件和 identity sequence；仅复制科学迁移 JSON 不足。私有备份权限设为 600。
3. 在新服务器安装 PostgreSQL 和 Node.js，建立独立实例／数据库和新凭据。数据库仅监听回环或受控内网，不对公众暴露。不能直接复制 Mac 数据目录／二进制到 Linux。
4. 通过 SSH 传输备份，核对 SHA-256。恢复到新空库，保留全部 ID、时间、账户及文件关系；已有目标库必须先备份，不能直接覆盖。
5. 逐表比较行数、逻辑内容和文件 SHA-256；验证外键、版本与 sequence 下一值，验证旧 ID 映射、压力点、登录与投稿读取。记录实际数据库版本、数据摘要与恢复回执。
6. 部署与当前网站契约一致的平台 API（8877 的平台服务，不是只有材料查看功能的 8878 检查服务），配置受信网站 Origin 与 HTTPS Secure Cookie，以及团队访问边界。现有平台服务默认仅允许本机 5173 Origin，必须先调整、验证，不能直接发布后期待登录写入自动正常。
7. 配置 HTTPS API 入口；Cloudflare 同源代理使用 remote 绑定。若使用 Tunnel，Worker 到 API 的服务认证与团队浏览器登录需分别验证；不能让面向浏览器的邮箱认证页面被当成 API JSON 返回。
8. 从实际 Cloudflare 网站验收检索、详情、压力切换、账号和投稿，确认本地模式仍可用。标明本次是一次性复制，不声称已配置持续同步。
9. 根据团队评审需求确认唯一主库和后续同步策略，备份后再执行增量同步。用户／投稿更新不能用仅科学表的导入包覆盖。

## 7. 回滚与恢复

本轮远程零写入，因此不需要远程回滚。没有改变原服务器已有容器、服务、端口或数据库。

网站选择配置的回滚：保留或恢复 `CALYPSO_BACKEND_MODE=local` 与原本机 API 地址；这只适用于本地网站运行，Cloudflare 远端 Worker 无法访问开发电脑的 127.0.0.1。远程部署若需回滚，应恢复上一个实际可用远程 API 地址／部署版本，不能用 local 假装仍在线。

未来数据库迁移失败：保持网站原目标不变，停止本次创建的专属 API／数据库服务，保留日志和恢复前备份；确认归属后再清理专属部署，禁止删除或重置服务器上其他数据库。

## 8. 本轮验证结果

在 `calypso-web` 目录实际执行：

```sh
node --experimental-strip-types --test tests/backend-target.test.ts
npm run typecheck
npm test
npm run build
```

结果：配置选择测试 3 项通过；类型检查退出码 0；全部网站测试 **49 项通过、0 失败**；Cloudflare/Vite 构建退出码 0，包含材料、身份和投稿三个 API 路由。构建工具对部分页面路由的静态分类提示保持原有行为，没有声称已经完成线上部署。

配置测试覆盖 local 默认行为、remote 显式选择、禁止隐式回退、HTTP 远程地址／URL 凭据／非法路径拒绝。这些是配置与构建验证，远程 URL 仍是占位符。

**未执行**：远程恢复、持续同步、远程平台 API 启动、Cloudflare 线上绑定修改或线上部署。不得据本地配置测试声称远程连接已经成功。
