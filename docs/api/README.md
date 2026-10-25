# OpenAPI 契约流程

后端控制器及 DTO 是唯一契约来源，`openapi.json` 是受版本管理的导出产物，不手工编辑。

```powershell
pnpm openapi:export
pnpm openapi:check
pnpm api:generate
pnpm api:check
```

导出复用运行时的全局前缀与 Swagger 配置，只构造 Nest 元数据，不调用 `app.init()` 或 `listen()`。固定离线配置不会读取真实应用凭据，也不会建立数据库连接；Prisma 客户端生成本身亦无需数据库。导出保留 LF 和固定 JSON 缩进，CI 比较完整文件，检测遗漏更新，并拒绝重复 operationId。

控制器方法使用全局唯一且稳定的 `@ApiOperation({ operationId })`，重命名内部类时保持公开 operationId。请求/响应使用显式 DTO 和 Swagger 属性描述，不用 TypeScript interface 或仅 example 冒充数据契约。当前契约已覆盖健康、认证/账号、作者/图源、作品、翻校、审核、嵌字和发布等已实现业务，统一错误响应以 ErrorDto 表达。请求 DTO 在 tsx 开发与 tsc 构建中均通过显式类型 ValidationPipe 校验，拒绝额外字段。

`packages/api-client` 使用以下生成流程：openapi-typescript 7.13.0 从本目录 `openapi.json` 生成 `src/schema.ts`，openapi-fetch 0.17.0 提供请求客户端。前端消费该包，不手写角色枚举或复制 DTO。根 `api:generate` 先导出契约再生成客户端，`api:check` 依次比较两份产物，CI 执行相同检查。生成文件受版本管理，手工维护的入口和构建配置与生成代码分开。

客户端使用 API host-only Cookie，写请求为 JSON 并带 `X-Comiku-Request: 1`；浏览器自动发送的 Origin 必须精确匹配后端 `APP_ORIGIN`。未登录为 401；权限、来源或强制改密限制为 403；版本和账户名冲突为 409；输入校验为 400；限速为 429。本地开发通过 Vite `/api` 代理保持同源；生产允许同一主域下的前端与 API 子域分离，后端只对精确的 `APP_ORIGIN` 开放带凭据 CORS。

无参数的 JSON 写操作（例如成图会话解包）也须在 OpenAPI 中声明空对象请求体，客户端显式传 `body: {}`。不要仅发送无请求体的 POST 或只设置 Content-Type；来源校验同时要求符合 JSON 请求格式。

作品列表通过 `view=todo / recommended` 查询个人待办与推荐，未指定时查询普通作品列表。响应包含全量 `todoTotal`；个人视图的卡片包含 `personalTasks`，列明职责、是否可立即开始和多人分工完成状态。`phase` 与 `phaseCounts` 描述工作阶段，不能用个人视图创建新的工作流状态。资格过滤、分组排序、计数和游标分页均在服务端执行；游标所属作品已不在当前过滤范围时返回 409，客户端需要重新加载第一页。

新增业务接口仍需评审请求/响应、分页、错误码、资源权限、状态枚举来源和兼容性。内容审核提供申请人撤销接口（`POST /api/reviews/{id}/withdraw`），管理员决策接口接受 `continue_production`、`discard` 与 `restore_production`。审核操作聚焦于制作流程的可行性决策，可用参数与状态流转均以当前请求 DTO 与服务端校验为准。

批量嵌字下载使用 `/typeset/handoff-manifest` 获取全部本人待办，`POST /typeset/handoff-items/:workId` 准备单件包，`POST /typeset/handoff-items/:workId/:packageId/download` 显式确认交付。两次 POST 使用冻结的 revision/editor epoch；下载阶段在作品锁内重新校验，返回 ZIP。清单和准备包不触发嵌字开始，交付成功后的首次下载才建立边界；409 要求重新预览确认，不自动换基线。

成图批上传使用独立 `/typeset/upload-sessions` 契约：创建文件元数据会话并取得 PUT 签名；`/:id/extract` 校验并受限解包；`/:id/plans` 明确分组、合并、内容及人工目标后检查提交条件并生成冻结预览；`/:id/confirm` 接受 previewId，在同一事务中新增单作品版本并复用作品模块提交嵌字，重试返回原 versionId。响应 stageSubmitted 表示该次确认是否曾同步提交；仅保存而未同步提交的会话为 false，取消提交后重试原确认不会重新推进阶段。图片 URL 与恢复 GET 只允许会话本人。组间失败隔离；409 必须重新检查并明确确认，不能自动更换基线。请求字段与回应均由 OpenAPI 离线生成。
