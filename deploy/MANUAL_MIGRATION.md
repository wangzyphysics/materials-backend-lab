# 手动迁移完整 PostgreSQL 数据库

日期：2026-10-13（Asia/Shanghai）。适用：Mac 本地 PostgreSQL 18 → 新的 Ubuntu 22.04 / 24.04 服务器，具备 SSH 和 sudo 权限。

2026-10-14 修订：后端已独立，不再引用网站源码。第四、七步改为只打包、安装 `materials-backend-lab`，不用上传 `calypso-web/lib`。如果已经制作过旧源码包，请重新制作；数据库备份方式不变。

同日安装修订：Mac 专用 PostgreSQL 包已改为可选依赖，服务器安装显式使用 `--omit=optional`。已上传旧包并遇到 EBADPLATFORM 时按 [安装报错处理](INSTALL_TROUBLESHOOTING.md) 原地修复，不重新恢复数据库。

**本指南没有在新服务器执行。** 新服务器的连接地址、系统和资源尚未提供。非 Ubuntu、无 sudo 或已有数据库服务时，不要直接执行安装段；先调整对应步骤。

采用 PostgreSQL 官方 `pg_dump` 自定义归档 + `pg_restore`。它可以跨 Mac/Linux 架构迁移，保留表、数据、索引、约束、函数和序列；不是复制 Mac 二进制或 `.local/postgres` 数据目录。[pg_dump 文档](https://www.postgresql.org/docs/18/app-pgdump.html)、[pg_restore 文档](https://www.postgresql.org/docs/18/app-pgrestore.html)。

## 迁移范围与验收

- 源库：本机 `127.0.0.1:55432` 的 `calypso_lab` 数据库。
- 目标库：新服务器 PostgreSQL 中新建的 `calypso_preview`，角色同名。目标**必须是新空库**，不覆盖任何已有业务库。
- 迁移整库，包含 `calypso_lab` 科学 schema、`calypso_platform` 平台 schema、账户、密码派生记录、投稿、数据库内上传文件、会话、审核事件和序列。服务器数据库角色另建，使用新密码；不搬运本机数据库管理员密码。
- 网站继续由 Cloudflare 编译部署。数据库迁移后，还需要平台 API 和 HTTPS 入口才能接网站。
- 此次是一次性复制。后续两边各自新增的用户、投稿和材料不会自动合并。

2026-10-13 的只读检查：当前 26 张表，材料 20、相 10、结构表示 40、计算 48；平台还有用户 183、批次 48、记录 120。平台数量会变化，以你实际备份时生成的 `manifest.json` 为准，不以本段固定数字验收。

辅助脚本 `scripts/migration-backup.mjs` 将 `pg_dump` 和各表校验放在同一个导出的数据库快照下。校验包含所有非系统普通表的字段定义、逐行内容哈希、行数及序列值。它不是大数据流式工具，本项目当前规模可用。序列值不受事务快照完全保护，所以备份／校验期间要暂停写入。

## 一、Mac：配置新服务器连接

将新机器写入 `~/.ssh/config`，下面的 IP 和用户必须替换：

```sshconfig
Host new-preview
    HostName 新服务器IP
    Port 22
    User 你的登录用户
```

测试：

```sh
ssh new-preview
```

后文 `new-preview` 均指新机器，**不指旧 bj-server**。

## 二、新服务器：检查并安装 PostgreSQL 18

在服务器终端执行：

```sh
cat /etc/os-release
uname -m
free -m
df -h /
ss -lnt
sudo -v
```

确认有足够空闲资源。如果已有 PostgreSQL、占用的数据库端口或其他业务，不删除、不停用它们；使用独立实例或确认可用的已有 PostgreSQL 18。

以下是 Ubuntu 官方 PostgreSQL 软件源安装方法，仅适用于需要新安装的机器：[官方安装说明](https://www.postgresql.org/download/linux/ubuntu/)。

```sh
sudo apt update
sudo apt install -y postgresql-common ca-certificates curl
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt update
sudo apt install -y postgresql-18 postgresql-client-18
pg_lsclusters
/usr/lib/postgresql/18/bin/pg_restore --version
```

记录 `pg_lsclusters` 中 **18** 实例的实际端口。下例为 5432；如果系统给它分配了 5433，改成 5433。后续命令在同一个服务器终端执行：

```sh
export CALYPSO_PG_PORT=5432
sudo -u postgres /usr/lib/postgresql/18/bin/psql -p "$CALYPSO_PG_PORT" -d postgres -c 'SHOW server_version;'
sudo -u postgres /usr/lib/postgresql/18/bin/psql -p "$CALYPSO_PG_PORT" -d postgres -c 'SHOW listen_addresses;'
```

确认版本 18.x。数据库保持 localhost／回环监听，安全组无需开放数据库端口。远程管理通过 SSH 完成。

新建目标角色与数据库，角色密码在终端提示时输入，不写进命令行：

```sh
sudo -u postgres /usr/lib/postgresql/18/bin/createuser -p "$CALYPSO_PG_PORT" --pwprompt calypso_preview
sudo -u postgres /usr/lib/postgresql/18/bin/createdb -p "$CALYPSO_PG_PORT" --owner=calypso_preview --template=template0 --encoding=UTF8 calypso_preview
```

`createuser` 默认不授予 superuser、创建角色或创建数据库权限。若提示角色／数据库已存在，停止这一段，核实是否为本次新建对象，不执行删除或覆盖。

## 三、Mac：安装备份客户端，暂停写入

当前项目内的 PostgreSQL 二进制只有服务端和控制工具，没有 `pg_dump`，所以另装客户端。Homebrew `libpq` 提供客户端工具：[公式说明](https://formulae.brew.sh/formula/libpq)。

```sh
brew install libpq
"$(brew --prefix libpq)/bin/pg_dump" --version
```

这里必须确认 `pg_dump` 为 **18.x**。源库为 18，不要用 14／16／17 客户端。若 Homebrew 下载失败，先解决镜像／下载问题；未获得可用客户端时不要跳过备份步骤。

停止本地平台 API、网站中正在进行的写入、数据导入和种子脚本。可以在相应终端按 Ctrl+C 停止 API／网站；**数据库保持运行**。迁移验收完成前不要向两端写入，否则严格哈希比较会出现预期差异。

在 Mac 的新终端执行：

```sh
cd '/Users/wangzhenyu/workplace/codex/数据库网站设计/materials-backend-lab'
npm run db:start
export CALYPSO_BACKUP="$PWD/.local/manual-migration-$(date +%Y%m%d-%H%M%S)"
node scripts/migration-backup.mjs backup "$CALYPSO_BACKUP" "$(brew --prefix libpq)/bin/pg_dump"
```

成功输出 `backup_created`，目录内有：

```text
calypso.dump      完整数据库私有归档
manifest.json    同一快照的各表校验、序列值、归档 SHA-256
```

脚本从现有 `.local/connection.json` 读取本地凭据，密码不会出现在命令行或输出中。目录权限 700、文件权限 600。备份包括私人账号和投稿，不能放进公开 Git 或网站静态资源。

检查归档可读取：

```sh
"$(brew --prefix libpq)/bin/pg_restore" --list "$CALYPSO_BACKUP/calypso.dump"
```

如果失败，保留错误信息，选择新的备份目录重试。脚本拒绝覆盖已有备份文件。不要将部分生成的归档继续用于恢复。

## 四、Mac：准备校验脚本和 API 源码

以下打包后端自身，包括领域校验、package.json、锁文件、源码、脚本、样本、测试、检查页和文档；排除 `.local`、node_modules、历史 artifacts、本机数据库及凭据：

```sh
cd '/Users/wangzhenyu/workplace/codex/数据库网站设计/materials-backend-lab'
npm run package:backend -- "$CALYPSO_BACKUP/backend-source.tar.gz"
```

记录命令输出的 SHA-256。归档内只有 `materials-backend-lab`，没有网站目录。后端所需校验在 `src/domain`，运行依赖在后端 package.json 和锁文件中。数据库仍由单独的 `calypso.dump` 恢复。

## 五、Mac：通过 SSH 上传

先在服务器创建一个**本次新建的**私有接收目录；如果该名字已存在，换一个名字并同步修改后续路径，避免覆盖：

```sh
ssh new-preview 'umask 077; mkdir "$HOME/calypso-migration"'
scp "$CALYPSO_BACKUP/calypso.dump" "$CALYPSO_BACKUP/manifest.json" \
  "$CALYPSO_BACKUP/backend-source.tar.gz" new-preview:~/calypso-migration/
```

## 六、新服务器：核对归档，恢复到新空库

在服务器执行：

```sh
cd ~/calypso-migration
chmod 600 calypso.dump manifest.json backend-source.tar.gz
python3 - <<'PY'
import hashlib,json
from pathlib import Path
expected=json.loads(Path('manifest.json').read_text())['archive_sha256']
actual=hashlib.sha256(Path('calypso.dump').read_bytes()).hexdigest()
assert actual==expected, '归档校验失败：停止恢复'
print('归档 SHA-256 一致:', actual)
PY
sha256sum backend-source.tar.gz
```

源码包哈希应与 Mac 输出一致。确认目标仍为刚创建的空库，再执行恢复：

```sh
/usr/lib/postgresql/18/bin/pg_restore \
  --host=127.0.0.1 --port="$CALYPSO_PG_PORT" \
  --username=calypso_preview --dbname=calypso_preview --password \
  --no-owner --no-acl --single-transaction --exit-on-error \
  calypso.dump
```

输入第二步创建的**服务器数据库角色密码**。不是 Mac 本地数据库密码，也不是 SSH 密码。

恢复不使用 `--clean`，不删除已有数据库。`--single-transaction --exit-on-error` 在出错时回滚本次恢复的事务；看到任何错误就停止，保留归档和日志排查，不继续启动 API。目标库不应先运行 `db:start`、平台 bootstrap 或其他建表脚本，以免空库被提前填充。

## 七、新服务器：安装轻量 Node 运行环境

需要 Node.js >=22.13。已有合适版本可跳过安装。下面固定使用官方 Node 22.20.0，不改系统 Node：

```sh
mkdir -p ~/.local/calypso-runtime
cd ~/.local/calypso-runtime
```

根据 `uname -m` 选择一个值，x86_64 用 x64，aarch64 用 arm64：

```sh
export CALYPSO_NODE_ARCH=x64
curl --fail --location --output "node-v22.20.0-linux-$CALYPSO_NODE_ARCH.tar.xz" \
  "https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-$CALYPSO_NODE_ARCH.tar.xz"
curl --fail --location --output SHASUMS256.txt \
  https://nodejs.org/dist/v22.20.0/SHASUMS256.txt
sha256sum --check SHASUMS256.txt --ignore-missing
tar -xJf "node-v22.20.0-linux-$CALYPSO_NODE_ARCH.tar.xz"
export PATH="$HOME/.local/calypso-runtime/node-v22.20.0-linux-$CALYPSO_NODE_ARCH/bin:$PATH"
node --version
```

只有相应归档显示 `OK` 后才解压。上面的 PATH 只对当前终端有效；换终端需要重新 export，或运行程序时使用该 Node 的绝对路径。

建立新的源码目录，不覆盖已有部署：

```sh
umask 077
mkdir ~/calypso-preview
cd ~/calypso-preview
tar -xzf ~/calypso-migration/backend-source.tar.gz
cd materials-backend-lab
npm ci --omit=dev --omit=optional --ignore-scripts
```

使用后端自己的锁文件安装运行依赖，包括 pg/zod。不安装 Mac 专用开发二进制，也不在服务器安装或编译网站。

创建**新的服务器**数据库连接配置，密码交互输入，不拷贝 Mac 连接文件：

```sh
mkdir -m 700 .local
python3 - <<'PY'
from pathlib import Path
import getpass,json,os
os.umask(0o077)
port=int(input('PostgreSQL 18 实际端口 [5432]: ') or '5432')
password=getpass.getpass('calypso_preview 数据库角色密码: ')
config={'host':'127.0.0.1','port':port,'database':'calypso_preview','user':'calypso_preview','password':password}
target=Path('.local/connection.json')
with target.open('x') as f:
    f.write(json.dumps(config,indent=2)+'\n')
os.chmod(target,0o600)
print('已保存私有连接配置，没有输出密码')
PY
```

不要在服务器运行当前 Mac 专用的 `npm run db:start`；服务器实例由已安装的 PostgreSQL 管理。

## 八、新服务器：严格验收

**先不要启动平台 API，不要登录、投稿或重新导入。** 否则会话、限频及事件等表发生变化，会使迁移哈希不再相同。

```sh
cd ~/calypso-preview/materials-backend-lab
node scripts/migration-backup.mjs verify ~/calypso-migration/manifest.json
```

成功应输出 `status: verified`，表内容和字段一致，序列值一致。如果某表报不同，先排查备份后是否有写入、目标是否已有数据、恢复错误；不要用“材料数量相同”代替整库验收。

可追加查看关键计数，输入服务器数据库角色密码：

```sh
/usr/lib/postgresql/18/bin/psql -h 127.0.0.1 -p "$CALYPSO_PG_PORT" \
  -U calypso_preview -d calypso_preview -W \
  -c 'SELECT count(*) AS materials FROM calypso_lab.materials; SELECT count(*) AS calculations FROM calypso_lab.calculations; SELECT count(*) AS users FROM calypso_platform.users; SELECT count(*) AS batches FROM calypso_platform.batches;'
```

通过以上验证才算数据库复制完成。既有 Material/Phase/Calculation/user ID 均保留，数据库名字和连接密码可以改变。

## 九、数据库迁移后，网站怎样接入

先在服务器回环地址测试平台 API：

```sh
cd ~/calypso-preview/materials-backend-lab
node --experimental-strip-types src/platform/server.mjs
```

另一个服务器终端：

```sh
curl --fail http://127.0.0.1:8877/api/materials/statistics
```

当前服务器代码默认仅监听 127.0.0.1:8877，适合在同机由 HTTPS 代理／Tunnel 转发。网站使用的是这个平台 API，不是 8878 的单独材料检查 API。

**以下接入工作仍需配置，不会因恢复数据库自动完成：**

1. 配置稳定的 HTTPS API 地址或 Cloudflare Tunnel；数据库端口继续不对公众开放。
2. 将实际 Cloudflare 网站 HTTPS Origin 加入平台 API 的写入白名单，配置 HTTPS Secure Cookie；现有代码默认只允许本机 5173，直接发布会导致注册、投稿等写入被拒绝。
3. 确定团队访问限制，以及 Worker 到 API 的服务访问方式。
4. 在 Cloudflare 网站的服务端绑定设置：

```dotenv
CALYPSO_BACKEND_MODE=remote
CALYPSO_REMOTE_BACKEND_URL=https://实际API地址
```

前端继续请求 `/api/materials`、`/api/identity`、`/api/contributions`。Mac 本地开发保持 `CALYPSO_BACKEND_MODE=local` 和 `CALYPSO_LOCAL_BACKEND_URL=http://127.0.0.1:8877`。详见相邻网站的 `docs/BACKEND_SELECTION.md`。

## 十、失败处理、回滚与下一次同步

- 备份失败：不要传输／恢复部分归档，换一个新目录重新备份。
- 恢复失败：不要先切网站目标；保留原本地库与归档，排查错误后恢复到确认空的专属目标库。不要执行全服务器清理命令。
- 校验失败：保持两边暂停写入，比较报错表和序列；不要通过删除用户／投稿来凑相同数量。
- 完成后：保留私有原始备份与清单；原本地数据库无需删除。
- 下一次更新：先约定哪一端是主库。远程已经收到新的用户、投稿后，不能拿新的本地整库备份覆盖它；需要合并／增量同步设计，或只在确认可丢弃的全新评审副本中做再次完整恢复。

填写自己的操作记录：

```text
新服务器别名／地区：
系统／架构／资源：
PostgreSQL 版本／端口：
Mac 备份目录／时间：
数据库归档 SHA-256：
源码包 SHA-256：
恢复命令退出码：
verify 输出：
API 本机测试结果：
Cloudflare API 地址及绑定：
网站端到端验收结果：
后续唯一主库：
```

## 本指南的验证边界

辅助脚本已通过语法检查，并在当前真实本地数据库上执行只读清单检查，成功读取 26 张表。随后拿该清单复核仍在使用的本地库，脚本报出了 `rate_limits`、`sessions` 和 sequence 的变化；这次复核没有通过，不视为静态一致性验证成功。这说明实际操作需要暂停写入并使用实际备份的清单，不能拿较早的实时清单验收持续变化的库。

新的服务器尚未连接，实际 `pg_dump`、跨机 `pg_restore` 与云端网站验收由你按以上步骤执行；没有声称这些操作已经完成。
