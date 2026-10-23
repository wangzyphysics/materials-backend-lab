# 20 个真实结构：本地 PostgreSQL 与后端转换验证

2026-10-14：平台后端已移除对网站源码的运行依赖。`src/domain` 保存后端自身的领域校验，pg/zod 在本项目依赖中；网站仍只通过 API 交互。只部署后端时执行 `npm ci --omit=dev --omit=optional --ignore-scripts`，无需 `calypso-web`。详细步骤见 [手动迁移指南](deploy/MANUAL_MIGRATION.md)，本次修改与独立验证结果见 [独立部署记录](deploy/BACKEND_INDEPENDENCE.md)。

生成独立后端源码包（不含数据库、凭据、node_modules 或历史 artifacts）：

```sh
npm run package:backend -- /你的私有目录/backend-source.tar.gz
```

`npm run platform:domain:test` 检查后端自身校验与相对模块边界；`npm run verify:independent` 将后端复制到没有网站的临时目录，安装生产依赖，并在专属临时 PostgreSQL 数据库验证平台 API。它只读取源科学样本，不向源平台库写入测试数据，结束后清理本次临时对象。完整数据库另用迁移指南中的 pg_dump 备份，不包含在源码包中。

数据已从 `../results-0430` 提取并写入 **原生 PostgreSQL 18.4**。本项目与原来的虚拟 `database-prototype`、网站 `calypso-web` 分开，原始 JSONL 没有修改。

当前可直接打开 [本地数据检查页](http://127.0.0.1:8878/)，切换 Material、查看展示晶胞与计算胞、计算结果和来源映射。选择任一氢材料后，可切换 1/15/60 GPa。该页是验证工具；现有网站通过新增本地平台 API（8877）接入，原检查 API 保留。

## 当前实际数据

| 对象 | 数量与含义 |
|---|---|
| Material | 20 个真实来源结构身份 |
| Phase | 10 个按组成限定的源 Phase 标签；8 个预测结构未归相 |
| Structure | 20 个展示晶胞 + 11 个 relax 输出胞 + 9 个 static 输出胞 |
| Calculation | 11 relax、9 static、20 symmetry、8 synthesizability，共 48 |
| 压力 | 11 个已报告压力；9 个材料的元数据压力为 null，未用 PSTRESS=0 补造压力 |
| Analysis | 0；未生成真实焓曲线或凸包 |

样本选择包括原数据中全部 9 个具有 static 的材料、`B2/n-mB24` 氢相的 1/15/60 GPa 三个真实压力点，以及 8 个不同体系/压力组合的预测结构。选择过程与来源见 [manifest.json](samples/manifest.json)。源 Phase 标签表示原文件的归属，未重新证明或修订其物理归相。

**展示晶胞和计算胞允许原子数不同。** 例如 `caly-259513` 的展示胞有 30 个位点，relax 计算胞有 15 个位点。它们是同一 Material 下的不同表示，能量引用实际计算胞，不要求二者原子数相等。导入器同时支持 `outputs.structure` 和 `trajectory` 最后一步两种旧结构格式。

源任务中的 `state=successful` 保留为源运行状态；`status=primary` 不被解释为收敛或发布确认。原始能量和方法兼容性标记为未核实，可以查看、追溯，尚不进入科学热力学比较。

## 已运行的验证

[verification.json](artifacts/verification.json) 保存检查项目、原生数据库版本、计数、材料 ID 和迁移哈希。

已实际检验：源行校验哈希；20 个身份与 48 条任务；双晶胞表示；两种 relax 格式；未知压力；三个实际压力点；重复和并发导入；后补 9 个真实 static 时 ID 不变；不同来源精确表示复用身份；冲突事务回滚；错误性质归属、原子数和覆盖几何被数据库拒绝；PostgreSQL→SQLite→PostgreSQL 全部逻辑记录与 ID 保留；两种数据库返回相同详情契约；只读 HTTP API。

MongoDB 已生成独立集合文档和索引定义，并检查文档格式转换往返无损；没有启动 MongoDB，也没有声称其数据库行为通过验收。

## 运行和复现

当前数据库及 API 已启动。下面是停止后重新运行或复现的命令：

```sh
cd '/Users/wangzhenyu/workplace/codex/数据库网站设计/materials-backend-lab'
npm ci --ignore-scripts
npm run db:start
npm run import
npm run verify
npm run export
npm run serve
```

`npm run import` 重复运行会复用原回执，不再创建 Material/Calculation。`npm run verify` 在本地 PostgreSQL 的专属临时 schema 中测试更新与错误写入，结束后清理本次创建的测试 schema；不重置主样本库。SQLite 的迁移副本保留于 `.local/portable.sqlite`。

需要从原始文件重新提取样本时运行 `npm run extract`。转换器发现样本覆盖或源任务数量变化会报错，要求重新检查选择规则。

原生 PostgreSQL 通过固定版本的 npm 二进制包放在项目中；Homebrew 下载失败后采用了这一方式。它运行独立服务进程，使用真实连接与事务，不是 PGlite/WASM。运行程序参考 [embedded-postgres 项目](https://github.com/leinelissen/embedded-postgres)，数据库启动参数参考 [PostgreSQL initdb](https://www.postgresql.org/docs/18/app-initdb.html)、[pg_ctl](https://www.postgresql.org/docs/18/app-pg-ctl.html)。

- 地址：`127.0.0.1:55432`
- 数据库：`calypso_lab`
- schema：`calypso_lab`
- 用户：`calypso_lab`
- 凭据：自动生成并保存在权限为 600 的 `.local/connection.json`；不进入导出包
- 数据目录：`.local/postgres`
- API 与检查页：`http://127.0.0.1:8878/`

没有开启系统自动启动服务。`npm run db:status` 检查实例；`npm run db:stop` 停止 PostgreSQL。API 在前台运行时用 Ctrl+C 停止，数据保留。

读取真实 PostgreSQL 的 SQL 查询：

```sh
npm run sql -- 'SELECT material_id,phase_id,formula,pressure_gpa FROM materials ORDER BY material_id'
npm run sql -- 'SELECT type,count(*) FROM calculations GROUP BY type ORDER BY type'
npm run sql -- 'SELECT m.material_id,s.role,s.nsites,s.volume_a3 FROM materials m JOIN structures s USING(material_id) ORDER BY m.material_id,s.role'
```

SQL 命令在只读事务中执行。该原生程序包不提供 psql 命令；也可用已有数据库客户端按上述连接信息查看。

只读 API 示例：

```sh
curl 'http://127.0.0.1:8878/api/v1/health'
curl 'http://127.0.0.1:8878/api/v1/materials?query=caly-259513'
curl 'http://127.0.0.1:8878/api/v1/phases'
```

完整 ID 与旧 ID 映射见 [import-receipt.json](artifacts/import-receipt.json)，可把其 `materialId` 用在 `/api/v1/materials/{id}`。API 有统计、基础文本检索、详情、Phase 压力列表与压力解析；未实现现有网站的全部搜索模式、筛选和分页，因此不是现有网站接口的完整替代品。

使用已迁移的 SQLite 副本验证同一页面和接口：

```sh
LAB_BACKEND=sqlite LAB_API_PORT=8879 npm run serve
```

然后访问 `http://127.0.0.1:8879/`。更换存储适配器不改变数据的 Material ID、API 详情字段或前端检查页。

## 数据结构与不同后端

业务结构继续采用 **Phase → Material → Calculation**。新增的 Structure 表只是表示与计算胞关联，不改变 Material 的身份层级。

```text
原始 JSONL → 格式转换器 → calypso-ingest v1
                          ↓
                 统一身份、校验与导入服务
                          ↓
              Repository 存储适配器
                ├─ PostgreSQL：已实测
                └─ SQLite：已实测

任何已实现后端 → calypso-transfer v1 → 另一个已实现后端
                              └→ MongoDB 集合文档与索引样例
```

[BACKEND_CONTRACT.md](BACKEND_CONTRACT.md) 描述身份、转换、约束和 API 契约；[postgres-schema.sql](artifacts/postgres-schema.sql) 与 [sqlite-schema.sql](artifacts/sqlite-schema.sql) 是实际执行的建表代码。

| 逻辑对象 | PostgreSQL / SQLite | MongoDB 文档映射 |
|---|---|---|
| 相、材料、结构表示 | 独立表与显式外键 | 独立集合、字符串 ID 引用 |
| 计算、结果、方法、来源任务 | 独立记录、归属约束、不可变历史 | 独立集合；适配器须补等价归属/不可变校验 |
| 当前性质选择 | Material + 性质 + 方法范围的唯一指针 | 同样的唯一键与指针 |
| 来源 ID 映射 | 来源命名空间 + 外部 ID 唯一 | 唯一复合索引 |
| 大轨迹/原始文件 | 保存文件引用和来源行，不嵌进 Material | 同一原则，不创建无限增长的内嵌数组 |
| 分析与输入快照 | 当前为空，预留版本与计算引用 | 同样导出为空集合；正式算法需另行验收 |

导入包在入库前仅有来源 ID。后端先解析已有身份，确认新材料后才生成 UUID，并在事务提交后返回。`calypso-transfer` 是已经入库的迁移包，必须保留原 ID，目标库不重新分配。新空库重新导入原始记录会创建新身份；要迁移已有身份应使用迁移包。

## 交付文件

- `samples/raw/*.jsonl`：20 个材料及其已有任务的原始行副本。
- `samples/manifest.json`：原文件与样本文件 SHA-256、选择规则与旧 ID。
- `samples/ingest.json`：后端无关的标准导入记录，含展示/计算胞角色与源行引用。
- `artifacts/import-receipt.json`：已提交的 Material/Calculation 身份映射。
- `artifacts/transfer.json`：版本化、带哈希的完整逻辑迁移数据。
- `artifacts/mongo-documents.json`：文档数据库的集合与索引转换样例。
- `artifacts/verification.json`：真实执行的验收证据。
- `artifacts/page-cells.png`、`page-pressure.png`：实际浏览器的双晶胞与压力切换证据。

## 正式开发仍需决定和验证

本次验证的是 20 条真实源记录的本地流程与存储转换，尚不是最终生产设计。精确结构去重只处理原子排序和坐标周期规范化，不进行基变换、平移或原胞/常规胞等价匹配；不同来源的 Phase 标签冲突需要明确归相流程。未知压力不跨来源自动合并。

实际导入器应扩展多次同类型任务、Phase 审核/修订、结构等价匹配与容差版本、原始 VASP 的质量和能量定义确认、分析失效/重算机制、文件资源存储。虽然预留了分析表，目前没有真实热力学算法或经验证的方法比较集合。

建库文件具有版本与校验记录，变更应添加迁移，不能改写已经应用的 v1。基础检索服务当前针对 20 个样本读取并筛选；正式扩量需把筛选、游标分页和计数放入后端查询，并在目标数据规模下测试索引与并发。不能将本次迁移正确性当作生产性能证明。


## 网站、账号与贡献接入 — 2026-10-12

在相邻 calypso-web 执行 `npm run dev:local` 可一并启动。本目录也提供 `npm run platform:bootstrap`（预置数据库测试账号）、`npm run platform:serve`（8877）和 `npm run platform:test`（专用真实 PostgreSQL 集成测试）。新增 calypso_platform schema，原 calypso_lab 科学记录保持不变。密码文件仅在 `.local/platform-test-accounts.json`。详见 [网站本地接入说明](../calypso-web/docs/LOCAL_DATABASE.md)。自动 VASP 计算与第三方认证没有接入。

## Administrator statistics (2026-10-13)

The integrated web administration page is `http://127.0.0.1:5173/admin`. Existing seeded administrator credentials remain private in `.local/platform-test-accounts.json`. The protected aggregate endpoint is `GET /api/identity/admin/statistics`; public homepage aggregates remain at `/api/materials/statistics`.

`npm run platform:stats` prints the same aggregate JSON in a repeatable-read READ ONLY transaction. `npm run --silent platform:stats > /tmp/calypso-statistics.json` exports it locally. Preset/QA accounts are excluded from research/community totals. All definitions and filter/sort options are documented in `../calypso-web/docs/STATISTICS_AND_RESULTS.md`. No scientific tables or applied migrations were changed in this revision.

## v11 showcase and lifecycle

Migration 003 adds audited account status, reversible deletion/restoration and demo markers. `npm run platform:showcase` creates explicitly synthetic passwordless identities and private contribution metadata for charts; it leaves science data and genuine account credentials unchanged. `npm run platform:stats -- --demo` exports their aggregate view. The scientific search excludes every demo identity, and the real review queue excludes demo batches. Full result pagination/grouping and lifecycle contracts: `../calypso-web/docs/STATISTICS_AND_RESULTS.md`.

## Unified uploads and internal imports — 2026-10-17

Contribute, administrator Data imports (`/admin?section=imports`) and the new HTTP CLI now share the contribution v3 contract, server validation and transactional writer. Run `npm run data:ingest -- --help` for offline manifest preparation, validation, upload, submission and receipt/status commands. Repeated internal imports return the existing receipt; changed content under the same source key is rejected. See [the unified ingestion guide](docs/UNIFIED_INGESTION.md) for setup, permissions, limits, migration 005 and the separate legacy initialization path. No VASP runner or automatic publication is enabled.

## Structure details and authorized exports — 2026-10-18

The platform API now implements authenticated `GET /api/materials/records/:recordId` and `/api/materials/records/:recordId/download?format=json|cif|poscar|csv|original&cell=...`. The read-only projection distinguishes display cells from actual calculation cells and preserves raw-energy validation status. Exact source-phase pressure records are returned without interpolation or stability inference. The same visibility checks protect contributor details and original-file downloads; contact emails are omitted. Run `npm run materials:detail:test` for PostgreSQL authorization/export tests. No scientific table or SQL migration was changed. Update this independent API together with the frontend to enable the new detail pages remotely.
