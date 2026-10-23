# 后端无关契约 v1

数据库选型可以继续比较，但身份含义、单位、来源、版本与前端契约应先保持一致。本次已经实现 PostgreSQL、SQLite 的相同逻辑模型与服务；MongoDB 提供文档映射，没有提供已验收的数据库适配器。

## 身份与科学含义

1. **Phase** 组织不同压力下的 Material。源标签按来源和组成限定，防止不同元素的同名结构标签被合成一个相。当前归属依据为 source_provided，缺失不自动补造。
2. **Material** 表示一个具体材料结构与已报告的压力条件。平台 ID 是稳定的字符串 UUID，与数据库主键技术、压力、配方和结构哈希分开。
3. **Structure** 是 Material 的一种表示。展示胞、relax 输出胞和 static 输出胞分别保存；不能用展示胞位点数强制覆盖计算胞位点数。当前计算关联依据为源 Material ID，未重新认证物理等价性。
4. **Calculation** 是独立任务，有稳定的平台 ID、源任务别名、方法、输入、输出结构和结果。输入 POSCAR 仍在输入中保留，不能当作最终结构。已导入记录不可覆盖；改算是新任务，性质选择指针可以改为新任务。
5. **Energy** 保留源数值、定义状态与实际胞的 E/V/N。缺失压力和未确认的能量定义保持未知，不自动计算焓。后续需要标准能量对象与经过质量验证的方法比较范围。
6. **Analysis** 保存条件、算法版本、输入计算引用与数值快照，不能仅存图片或依赖当前选用指针。现有分析表为空；科学算法、失效检测和发布校验待正式实现。

`identity_policy=exact_display_representation_v1` 是当前明示的匹配边界。它不宣称“哈希不同必定是不同物理结构”。源映射冲突拒绝写入，未实现的等价匹配应进入后续审核流程。

## 导入与迁移是两件事

| 项目 | `calypso-ingest` | `calypso-transfer` |
|---|---|---|
| 用途 | 原始来源转换后的标准导入 | 已存在数据库之间的迁移 |
| 身份 | 旧 Material/Task ID + 来源命名空间 | 已分配的 Material/Calculation/Phase/Structure ID |
| ID 行为 | 校验/匹配后创建或复用 | 必须保持全部 ID 和引用 |
| 数据版本 | schema_version=1 | schema_version=1 |
| 重复操作 | 源唯一键、内容冲突检查、包回执幂等 | 相同记录允许复用，不同已有记录拒绝覆盖 |
| 完整性 | 原始文件/行哈希与原解析字段 | 数据哈希、结构哈希/数量/体积、外键、归属与事务 |

每份任务必须带稳定的 external_task_id；不能用文件行号、目录名或化学式推测要更新哪个 Material。入库回执保存来源到平台 ID 的映射；后补计算复用已有 Material，重新 relax 得到不同结构时要重新登记/匹配。

新库若重跑原始导入，将分配本实例的新 ID。换后端保留身份时，使用导出包，不能在目标后端重新计算并分配 ID。

## 适配器必须提供的行为

当前接口包括：事务、来源和身份锁、按逻辑实体读取/插入、更新 Material 修订信息、更新当前性质指针、延迟约束与完整性检查、初始化版本迁移、关闭连接。领域服务只调用这些接口；SQL 占位符、JSONB/TEXT、事务命令与 schema 位于适配器。

任何新适配器至少通过下列验收：

- 同样输入给出同样的身份解析结果，来源别名唯一，任务内容冲突不覆盖旧结果。
- 一次失败的导入不留下部分来源、结构、任务或选用指针。
- 竞争导入不能重复分配同一身份。本例 PostgreSQL 使用来源锁与有序结构身份锁，SQLite 使用写事务串行化。
- 当前性质必须属于所选 Material、任务类型与方法范围；不能只保存一个无归属验证的 Calculation ID。
- 计算能量的位点数/体积对应其实际计算胞，允许展示胞不同。
- 几何、已导入的计算与结果、已保存的分析历史不可覆盖。
- 输出同样的详情 DTO，并支持迁移往返后全部逻辑记录、ID 和数值保持一致。
- 故障、并发、重复、非法引用、旧版本迁移包都应有具体检查，不以“能插入”代替完整验收。

PostgreSQL 用外键、唯一键、CHECK、触发器、事务及 advisory lock 实现这些约束；SQLite 使用外键、触发器和事务。数据库约束覆盖了归属、身份覆盖与 E/V/N 对应等部分，科学结构匹配、收敛与方法比较仍属于需要专门验证的领域服务。

## MongoDB 转换原则

集合与逻辑实体相对应：phases、materials、structures、calculations、calculation_results、methods、material_sources、calculation_sources、property_choices、analyses、analysis_inputs 等。

`_id` 保存平台已有的字符串 ID，不换成新的 ObjectId。Material 引用展示 Structure 和 Phase；Calculation 引用 Material、方法和实际输出 Structure。原始文件、大数组和全部历史不无限嵌入 Material 文档。

`mongo-documents.json` 给出集合文档与唯一/检索索引。它已经通过文档转换的逆变换，但跨文档外键、事务及不可变约束需要 MongoDB 适配器实际实现与验收，不能用导出文件存在来宣称 MongoDB 后端完成。

## 前端契约

前端访问 HTTP API，数据库账号与连接信息只在后端。详情使用固定的 `materialId`、`phaseId`、`pressureGPa`、`displayStructure`、`structures`、`calculations`、`selectedCalculations`、`sources` 等字段。

Phase 的压力列表列出实际 Material ID；切换点后按 ID 读取详情。缺失压力返回 unavailable；同压多结构返回 requires_material_selection，不能按数据库返回顺序随意选第一条。当前检查页用按钮证明离散点联动，正式滑动条之后再开发。

该本地 API 是最小验证契约，未完成现有网页的全部搜索过滤模式，也不提供写入 HTTP、账号权限、任务队列或完整下载服务。现有网页接入前需统一它自己的 API 契约与这里的领域模型。

## 版本与精度

物理 schema 记录应用版本与 DDL 校验；导入/迁移格式也有独立版本。增加任务类型可以注册，但结果语义、单位和验证器必须同时定义；更改身份规则、压力含义或能量定义不能静默复用旧版本。

本次 JSON 数值与应用服务使用有限的 IEEE-754 数值。PostgreSQL 的 pressure_gpa 使用无固定小数位的 numeric，适配器输出统一数值；SQLite 使用 REAL。样本往返已实际验证。若将来要求超过该精度的精确小数，应在新格式中明确十进制字符串及其转换策略，不能悄悄截断。

迁移包引用的原始文件需要一并搬迁，并核对 manifest；仅恢复数据库记录不等于备份完整。凭据、数据目录锁与运行时迁移记录不进入逻辑迁移包。
