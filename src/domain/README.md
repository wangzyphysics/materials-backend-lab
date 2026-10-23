# 后端领域校验

此目录是后端自身的运行代码，不引用网站目录。2026-10-14 为解除部署依赖，将当时已在平台 API 使用的账号、投稿、结构文件、检索、元素和地区校验纳入后端，保持原语义；运行依赖 zod 已写入后端 package.json 和锁文件。

后端校验是写入与权限判断的依据；浏览器校验用于交互提示，不能替代服务端校验。两端可以独立发布，通过 API 契约保持兼容。未来修改字段、限制或状态时，应更新 API 契约及契约测试；不要再次通过相邻网站源码 import 同步实现，也不要假设浏览器与服务端文件必然一致。

范围保持与当前临时平台一致：CIF/POSCAR 基础检查不等于科学结构标准化；审核通过不等于收敛确认或稳定性证明。数据模型和数据库 schema 本次没有修改。

2026-10-14 后续投稿更新：本地 `batch-contribution.ts` 现在独立校验 v3 Phase / P–T / record 关系，保持 v2 读取兼容；增量迁移 004 建立贡献身份表。`tests/hierarchy.test.ts` 与平台集成测试覆盖新契约，前后端仍可独立运行。具体字段和接口见后端 `docs/CONTRIBUTION_HIERARCHY.md`。

## Teaching previews (2026-10-15)

The contribution v3 contract accepts the additive exampleOnly flag (default false). Known TUTORIAL ONLY: record-source markers also set it. The API rejects such drafts before file validation or database writes; readiness also blocks submission. This prevents accidental submission of the bundled teaching examples and does not certify scientific authenticity. It requires no SQL migration.
