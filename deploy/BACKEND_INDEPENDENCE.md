# 后端独立部署记录

2026-10-14。目标：网站与平台后端只通过 HTTP API 交互，部署后端不携带网站源代码。此次仅修改 `materials-backend-lab`，网站代码、数据库 schema 与原库数据不作修改。

## 变更

- 将此前平台 API 使用的账号、投稿、结构文件、检索、元素和地区校验纳入后端 `src/domain`，保持原业务语义。
- 修改平台服务、统计、检索、bootstrap、showcase 和测试的 import，均改用本项目内模块；没有运行时引用 `calypso-web/lib`。
- 将固定版本 zod 3.25.76 增加为后端运行依赖，更新自己的 package.json 与 package-lock.json。
- 增加独立源码打包命令。源码包包含后端自己的安装配置、校验、源码、脚本、样本、测试、检查页和文档；排除 node_modules、.local、artifacts、.git、日志等。
- 更新手动迁移指南，不再打包网站 lib、不在服务器共同父目录拼装临时 package.json，改为后端目录内 `npm ci --omit=dev --omit=optional --ignore-scripts`。

浏览器自身的表单校验继续用于提示，后端独立校验仍是写入授权和数据校验的依据。接口契约相同不要求双方源代码相互 import。以后字段、枚举或限制变更应更新契约并验证旧客户端兼容性，不能只修改一端然后假定另一端必然同步。

## 已执行验证

```sh
npm run platform:domain:test
npm run verify:independent
```

独立验证创建了不含相邻网站目录的临时后端副本：

1. 使用本后端自己的锁文件安装生产依赖，当前 Mac 主机安装成功。原先附加 Linux/x64 参数的检查未能证明真实 Linux 上的平台检查行为；用户随后在 Linux 上遇到 EBADPLATFORM，已修正依赖分类与安装命令。
2. 新建本次专属临时 PostgreSQL 数据库，从源库只读复制 20 个科学材料样本。
3. 领域校验／模块边界测试 3 项通过。
4. 只在临时数据库加入明确标记的演示夹具，以满足现有展示统计测试前提。
5. 平台 PostgreSQL API 测试 21 项通过，覆盖账号、权限、检索、分页、归相、投稿、审核、文件归属和恢复流程。
6. 清理本次创建的临时数据库和源码副本。没有向源平台库写入测试账号、投稿或演示数据。

首次隔离检查发现测试扫描器将子进程内的相对 import 当作主脚本 import，已改为明确的隔离目录模块 URL。第二次发现已有测试依赖演示统计夹具，已只在临时库补齐夹具。最终完整重跑退出码 0。

测试进程运行在当前 Mac。此前 Linux 参数模拟的结论不成立；不能将 Mac 安装成功作为 Linux 验证。此次将本机 PostgreSQL 包改为 optionalDependencies，并使用明确的 --omit=optional；真实 Linux 安装仍以用户服务器的执行结果为准。

## 现在怎样打包

在后端目录：

```sh
npm run package:backend -- "$CALYPSO_BACKUP/backend-source.tar.gz"
```

归档内只有 `materials-backend-lab`。`CALYPSO_BACKUP` 沿用手动迁移指南中的私有备份目录；目标文件已存在时需换新路径。数据库内容仍使用单独的 `calypso.dump`，不能用源码包代替。

完整迁移和恢复命令见 [MANUAL_MIGRATION.md](MANUAL_MIGRATION.md)。网站当前已有 local/remote API 配置，独立后端替换完成后仍保持接口路径，不需要改网站页面代码。远程 HTTPS 入口、可信 Origin 和 Secure Cookie 的配置仍属于后续接入步骤。

## Linux 安装修复记录

用户反馈 `npm ci --omit=dev` 在 Linux/x64 仍校验普通开发依赖中的 Mac 二进制，抛出 EBADPLATFORM。已将二进制改为可选依赖，更新锁文件，并在服务器命令显式省略可选依赖。pg/zod 仍是普通运行依赖。打包器也设置 COPYFILE_DISABLE 与 COPY_EXTENDED_ATTRIBUTES_DISABLE，避免新归档携带 macOS 扩展属性。数据库结构和备份不作更改。现有服务器可以按 [安装报错处理](INSTALL_TROUBLESHOOTING.md) 原地修复，无需重新恢复数据库。
