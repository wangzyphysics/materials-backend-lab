# Linux 安装报错处理

2026-10-14，用户在服务器解压成功，但 `npm ci --omit=dev --ignore-scripts` 出现 `EBADPLATFORM`：`@embedded-postgres/darwin-arm64` 不支持 Linux/x64。

原因：旧后端包把 Mac 本地 PostgreSQL 二进制列为普通开发依赖。用户服务器的 npm 仍对该节点执行平台检查。此前 Mac 上附加 Linux 参数的测试未覆盖这个真实行为，不能作为 Linux 验证。

数据库在服务器已经通过系统 PostgreSQL 运行，API 只需要 pg 驱动，不需要 Mac 二进制。本地源代码已将这个包改为 optionalDependencies，更新锁文件；服务器安装显式使用 `--omit=optional`。下面可以原地修复已上传的旧包。

## 服务器修复命令

在服务器运行，不需要 sudo，不修改数据库：

```sh
cd ~/calypso-preview/materials-backend-lab
python3 - <<'PY'
import json
from pathlib import Path
p=Path('package.json')
backup=Path('package.json.before-linux-fix')
if not backup.exists():
    backup.write_bytes(p.read_bytes())
data=json.loads(p.read_text())
name='@embedded-postgres/darwin-arm64'
version=data.get('devDependencies',{}).pop(name,None)
if version:
    data.setdefault('optionalDependencies',{})[name]=version
if not data.get('devDependencies'):
    data.pop('devDependencies',None)
p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
PY
npm install --omit=dev --omit=optional --ignore-scripts
node --input-type=module -e "await import('pg'); await import('zod'); console.log('依赖安装正常')"
```

这里使用 `npm install` 是为了同时修正旧锁文件，不能在修改 package.json 后直接对旧锁文件运行 `npm ci`。不使用 `--force` 绕过平台检查，也无需删除 PostgreSQL 或重新运行 pg_restore。

之后按迁移指南继续建立 `.local/connection.json`，执行：

```sh
node scripts/migration-backup.mjs verify ~/calypso-migration/manifest.json
```

如果连接文件已经存在，保留并确认其中使用远程库的密码、数据库名和端口，不重复创建、不输出密码。严格校验完成前不要启动 API。

## tar 警告

`LIBARCHIVE.xattr.com.apple.provenance` 是 macOS 扩展属性。GNU tar 的这类提示本身不表示源码解压失败；用户日志中的后端源码文件已正常出现。当前真正阻断的是 npm 的 EBADPLATFORM。

新的打包器会禁止导出这些扩展属性。已经成功解压的源码不必为了消除警告重新迁移数据库。

## 后续新包

使用已修正的 package.json 和 package-lock.json，生产安装命令统一为：

```sh
npm ci --omit=dev --omit=optional --ignore-scripts
```

Mac 本地开发默认安装仍可取得可选 PostgreSQL 包；服务器只使用系统 PostgreSQL，不运行 Mac 专用的 db:start。
