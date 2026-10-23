# 统一数据接入：Contribute、后台页面与 CLI

2026-10-17，v16。本轮已实现并保留现有 `/api/contributions` API。

## 已实现的结构与边界

三个入口使用相同的 contribution-batch v3 契约，Phase → P–T condition → record；理论/实验分别标记在每条记录。支持已有 structure / xrd / raman / property / attachment；红外等其他曲线目前通过 property 的坐标物理量及单位描述。文件可被多条采集引用；未知 P/T 不补 0，相同 P/T 不自动合并实验轮次。没有结构的实验数据可接入。当前单值物性仍使用至少一行的数值文件，页面直接录入数值、向量/张量专用表单仍是后续工作。

- 普通 Contribute 保存与内部导入均调用 `src/ingestion/validation.mjs` 和 `src/platform/contributions.mjs`。
- 后台入口 `/admin?section=imports`（登录网站管理员后），JSON / ZIP+manifest / 多文件+manifest 均可。原有 Contribute JSON 导出可以直接导入。
- CLI `scripts/ingestion.mjs` 独立部署在后端目录，只使用本后端依赖及 HTTP API，无网站源码依赖，不直接写 PostgreSQL。
- 内部批次在同一批次/Phase/条件/记录/文件表中保存，沿用现有编辑、草稿、提交、审核、归档、检索与公开规则。
- 内部导入不会自动授予“平台标准计算”或“已确认稳定相”身份。其真实理论/实验来源与质量状态保留；公开理论贡献仍使用已有的原始贡献标记。

## 网页操作

1. 管理员登录 → Administration → Data imports。
2. 选择导出的 JSON，或根目录有 `manifest.csv` 的 ZIP，或同时选择清单与原文件。
3. 填写 Source namespace、External batch / revision key、Import reason。可明确选择复制 Research Profile 作为署名。
4. Validate & preview：服务端核对原始字节 SHA-256、大小、图关联及当前贡献规则，显示数量、待补字段或来源编号冲突。预览不保存投稿。
5. Save import draft：允许保存上下文尚未补齐的合法草稿，返回导入回执。打开 Open editor & submit 进入现有 Contribute 编辑器。
6. 在编辑器补齐数据，保存；在 My contributions 提交审核，再到 Contribution review 审核。选择公开且获批的批次沿用现有检索规则，私密批次仍不进入共享搜索。

只选择文件尚未持久化，离开导入页前请保存。回执描述首次导入，之后的编辑和审核以批次及其事件为准。来源编号按登录账号隔离，其他管理员无法通过导入列表读取未提交的私人草稿。归档后的重复导入只返回原回执，不自动恢复。

## 准备 CLI 数据

在 `materials-backend-lab` 目录执行。使用 Node >=22.13；推荐与服务端一致的 Node 22 LTS。

下载现有贡献 CSV 模板，填写 `record_id,file,origin,data_type,phase_key,condition_key,...`。一行是一条记录；同文件可重复引用，用 `x_column/y_column` 指定不同列。同名 Phase 及相同数值条件不用于猜测关联。`file` 为相对于 `--directory` 的路径，禁止越界路径。ZIP 请先解压到独立文件夹后使用 CLI。

`metadata.json` 示例中的值需要替换为自己的真实信息：

```json
{
  "title": "本批次标题",
  "contributor": {
    "name": "贡献者姓名",
    "email": "your-address@example.org",
    "institution": "所属机构",
    "researchGroup": "所属课题组"
  },
  "visibility": "private",
  "permissionConfirmed": true,
  "computationRequested": false
}
```

`permissionConfirmed=true` 表示你已确认有权提供数据；公开意愿与计算授权独立。没有主动填写时，默认私密、权限未确认、未请求计算。

```sh
npm run data:ingest -- prepare \
  --manifest ./input/manifest.csv --directory ./input \
  --metadata ./metadata.json --out ./package.json

npm run data:ingest -- check --input ./package.json
```

`prepare` 不覆盖已有输出；包文件权限为 600。它含原文件及元数据，按私密科研文件保管。`check` 输出与服务端相同规则的检查报告；离线报告不能代替服务端校验。`check` / `validate` 无待补项时退出码 0，内容待补时为 2，远程来源编号冲突时为 3，请求/解析错误为 1；`upload` 成功保存合法草稿时为 0，即使科学上下文尚待补齐。

## CLI 认证和上传

在 Git 之外的私有目录手动创建 `import-login.json`。使用网站管理员账号，不使用 PostgreSQL 账号。

```json
{
  "url": "http://127.0.0.1:8877",
  "origin": "http://127.0.0.1:5173",
  "username": "你的管理员用户名",
  "password": "你的当前网站密码"
}
```

服务器使用 HTTPS API origin；`origin` 填后端允许的网站 origin。Cloudflare Worker 同源代理也可作为 url，如 `https://calypso-db-web.wangzy-physics.workers.dev`，此时 origin 同为该网站。禁止向非回环 HTTP 地址发送密码。文件仅当前用户可读，执行 `chmod 600 /私有目录/import-login.json`。密码不作为命令行参数、不进入导入包；会话仅在单条命令内存中保存，结束时注销。

```sh
npm run data:ingest -- validate \
  --input ./package.json --credentials /私有目录/import-login.json \
  --source lab-xrd --key run-001 --reason "导入本次实验采集"

npm run data:ingest -- upload \
  --input ./package.json --credentials /私有目录/import-login.json \
  --source lab-xrd --key run-001 --reason "导入本次实验采集"

npm run data:ingest -- list --credentials /私有目录/import-login.json --offset 0 --limit 20
npm run data:ingest -- status --batch 回执中的batchId --credentials /私有目录/import-login.json
npm run data:ingest -- submit --batch 回执中的batchId --credentials /私有目录/import-login.json
```

CLI 上传只保存草稿。`submit` 是明确的另一步操作，不自动审核或公开。CLI 不输出密码、Cookie、CSRF 或数据库连接配置。

## API 契约

保留原保存、读取、提交、审核、归档、文件下载与事件接口。新增：

| 接口 | 权限 / 行为 |
|---|---|
| POST /api/contributions/validate | 登录用户；body `{draft}`；只读校验 |
| POST /api/contributions/admin/imports/preview | 管理员；校验及来源编号检查，不写批次 |
| POST /api/contributions/admin/imports | 管理员；幂等创建内部草稿及回执 |
| GET /api/contributions/admin/imports?offset=0&limit=20 | 当前管理员自己的回执，limit 1–100 |

preview/import body：`{draft,sourceNamespace,externalBatchId,reason}`；服务端拒绝多余的 owner/role 等顶层字段。服务器确定所有者及权限，写请求保持会话、Origin、CSRF 和大小限制。校验返回 `schemaVersion,packageHash,canSubmit,counts,issues`；issues 明确批次问题或具体 recordId。

同一账号、来源命名空间和外部批次编号形成幂等键；规范内容哈希忽略临时 ID/时间戳，但保留关联、原始文件哈希、科学上下文、署名和可见性。相同请求/并发请求返回同一回执。相同键不同内容返回 409；创建新修订编号后独立保存，避免覆盖已发布记录。回执和全部投稿数据在同一数据库事务内提交。

005-unified-ingestion.sql 仅增量增加回执表；既有 001–004 校验和不变，原 calypso_lab 科学表不变。部署新后端会通过原迁移机制应用 005；请先备份数据库。

## 历史源库与后续工作

现有 `npm run import` / calypso-ingest v1 保留为历史样本库初始化与回放工具，未将其计算任务/能量字段粗略压进贡献文件模型，也未重编号原 Material/Phase/Calculation。今后常规用户/管理员上传使用上述统一入口。历史 ingest v1 的无损接入适配器、跨批次向既有正式 Phase 追加的权限与归相、原位修订/差异预览、原生单值/张量、独立文件上传和对象存储、大批任务队列、服务账号令牌、VASP 回传尚未实现。当前限制沿用 100 文件 / 10 MiB 单文件 / 50 MiB 总量 / 300 记录；需要更大数据时先拆成可追踪的批次，不直接扩大 HTTP/base64 请求。

## 验证

```sh
npm run ingestion:test
npm run platform:test
npm run platform:domain:test
```

集成测试在真实本机 PostgreSQL 和临时 API 验证普通上传、后台导入及 CLI，覆盖只读预览、校验一致、并发重试、冲突、原字节、权限、私密、审核及归档；仅清理本次创建的测试数据。
