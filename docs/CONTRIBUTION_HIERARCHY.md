# 数据贡献：Phase → P–T 条件 → 数据记录

2026-10-14（v13）。当前网站通过同源 API 连接本机 PostgreSQL，草稿、原始文件、提交、批次审核与可恢复归档均已接入。VASP 自动计算适配器尚未接入，不展示虚构计算进度。

## 页面与数据组织

1. 建立 Phase，填写 formula/composition；相名称建议填写，允许留空。
2. 在 Phase 下建立独立 P–T 条件组，可注明加压、卸压、加热、冷却或计算背景。
3. 在条件组下添加数据卡片，每张卡片分别选择 `experimental` / `theoretical`，再选择 structure / xrd / raman / property / attachment。
4. 填写归属和公开意愿，保存草稿；完整批次在 My Contributions 中提交审核。

Phase 的 composition 是主要组成信息。投料组成和实测元素组成可选，分别保存，不替代主 formula。结构未知的实验数据可以上传；没有可计算结构的谱图不会自动进入 VASP 工作流。

每个 Phase 从创建草稿起拥有 `PH-…` 永久贡献 ID。名称留空时显示 `Unidentified phase · <ID 最后八个字符>`，完整 ID 在编辑页显示。改名或审核不重新编号。名称、ID、提供者相鉴定状态、批次审核、计算与入库状态独立；名字不是相鉴定证据。`tentative` / `identified` 须提供鉴定依据，属于贡献者声明，不代表平台独立确认，更不代表稳定。

当前贡献 Phase 归属一个批次，数据库全局唯一；跨批次追加到既有 Phase、与正式材料/相注册表关联、相合并/拆分、混相的共享测量关联，留待后续明确审核与权限策略。不能靠名称、formula、空间群或相同 P–T 自动认定相身份。

## 条件与记录

条件使用独立 ID，相同 P–T 的不同实验轮次可以分别建立组。压力明确区分 `reported` / `target` / `unreported`；温度区分 `reported` / `not-modelled` / `unreported`。未报告或未建模没有数值，不默认填 0；0 GPa 与 0 K 本身是明确数值。目标压力不作为实测/报告压力进入公共压力筛选。

卡片继承 Phase 组成和条件组 P–T。实际采集/计算条件有差异时，开启 record-specific conditions，单独保存覆盖值与定义。实验记录不能将计算目标压力或未建模温度当成实验条件；确实缺失时可显式声明 unreported。

样品/实验轮次标识、采集标签、时间、仪器/软件为记录附加信息，不占主层级。一个条件组可以含多类数据、同类多次采集和两种来源。

文件与记录分离：同一原始文件可定义多个记录，各自指定 X/Y 列、来源和条件；原始字节只保存一份。不同 Phase 也可以分别引用同批次的同一个原文件，但不会自动解释为已确认混相。可选结构关联须指向同一 Phase、同一条件组中的具体结构记录；实际条件覆盖仍需贡献者/审核者核对。

EOS 等跨条件曲线目前可作为带说明的 property 原始记录保存；逐点关联多个条件、拟合方法与参数等结构化模型尚未实现，不假装已建立 Pressure Explorer。

## 文件与批量导入

- 多文件、ZIP（一个可选 manifest.csv）、CSV 清单、JSON 草稿均支持。
- 100 原文件，单文件 10 MiB，原始字节总计 50 MiB，300 数据记录；ZIP 展开后按此检查。
- CIF/POSCAR 做基础格式检查。数值 CSV/TXT/TSV/XY 可预览；Raman/XRD 至少两个有效点，property 至少一个。保留原值和顺序，不平滑、拟合或转单位。
- 2D 图像、仪器专有文件作为 attachment 保留，不声称已解析谱图。
- SHA-256 验证原始字节；绝对路径、父目录跳转、文件映射歧义和未映射文件拒绝导入。

清单一行对应一个数据记录。下载的空白 CSV 不插入示例科学记录。

| 字段 | 含义 |
| --- | --- |
| `record_id`, `file`, `origin`, `data_type` | 必需列；唯一记录 ID、原文件路径、来源和类型 |
| `phase_key`, `condition_key` | 本次导入关联键；condition_key 在 phase_key 内分组，不是正式数据库 ID |
| `formula`, `phase_name`, `phase_status`, `phase_evidence` | Phase 共享组成、名称和鉴定声明；旧 `phase_label` 仍兼容 |
| `feed_composition`, `measured_composition` | 可选补充组成 |
| `pressure_gpa`, `temperature_k`, `pressure_mode`, `temperature_mode` | 条件组共享数值与定义；无模式但有数值时按 reported，无数值时 unreported |
| `condition_label`, `condition_path`, `condition_notes` | 条件组标签、路径与说明 |
| `acquisition_label`, `acquired_at`, `instrument`, `sample_id` | 单次采集/计算标签、时间、仪器/软件及可选样品标识 |
| `structure_record_id`, `processing` | 可选具体结构记录关联；raw / processed |
| `x_quantity`, `x_unit`, `y_quantity`, `y_unit` | 坐标物理量及单位 |
| `x_column`, `y_column` | 唯一列名或从 0 起列索引 |
| `method`, `source`, `notes` | 每条记录的实际方法、来源与科学备注 |

共享键的重复行可以省略已经给出的共享字段；出现冲突则报错，不采用最后一行覆盖。没有 phase_key/condition_key 的旧清单逐记录建立独立容器，不靠文件名或数值猜测分组。同一文件路径可以重复用于不同采集/曲线。

## 保存、审核与公开

保存允许科学上下文不完整，保持私密。实际提交时服务端重新校验关联、文件、组成、条件、方法、来源、鉴定依据、联系信息与贡献权限。空 Phase 需移除或添加数据。当前审核以整个批次为单位，逐记录部分审批尚未实现。

`private` 仅所有者与具备权限的审核者可访问；未提交私密原文件不向管理员开放。`public-after-review` 只有提交并获批后才能进入检索。理论贡献保留红星及标准化待处理说明，实验数据保留实验来源标签。贡献 ID 用于组织同批相的数据，不将贡献者鉴定等同平台科学结论。首页科学统计仍明确仅计导入数据，不把待鉴定贡献加入已确认晶相数量。

用户上传结果与未来平台标准计算输出将是不同记录，保持输入/输出关联。公开意愿与计算授权分别保存；计算不能自动改变私密范围。未经工作流适配器返回的真实步骤与完成数，不生成百分比或剩余时间。

## 数据库与兼容

草稿版本为 3：`phases[]`、`conditions[]`、`records[]`、`files[]`。每个 record 有 phaseId / conditionId，保留 formula / phaseLabel / pressureGPa / temperatureK 兼容投影；Phase 和共享条件是权威来源，服务端重新计算投影，禁止记录伪造另一个组成。

PostgreSQL 以 draft_json 保存完整元数据，原字节在 files，记录在 records；增量迁移 004 建立 contribution_phases / contribution_conditions，以全局主键及批次内外键保护身份关联。不修改已应用迁移或 calypso_lab 科学表。

旧 v2 草稿读取时逐记录生成独立 Phase/条件容器，ID 确定且重读稳定，不回写原库；编辑保存后写 v3。原文件、记录 ID、方法、归属、私密范围与权限保留。v1 单结构 JSON 导入仍支持。导出后作为新批次导入时重新生成批次、Phase 和条件 ID，并完整映射关联，避免跨批次身份冲突。

HTTP 路径保持 `/api/contributions/batches`、`/batches/:id`、`/:id/submit`、`/:id/events`、`/:id/files/:fileId`、`/admin/review` 与 `/:id/restore`；写操作保持认证、CSRF 和版本冲突检测。审核队列增补 phases / conditions，旧响应缺失时客户端按空数组兼容。
