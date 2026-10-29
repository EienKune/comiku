# 环境配置与排错

根 `.env.example` 是配置模板。复制为 `.env` 后再填写；不要把真实配置提交到仓库。源码、构建产物与 Prisma 按文件位置找到项目根目录；进程环境变量优先于文件。生产可使用绝对路径 `COMIKU_ENV_FILE` 指定 secret 文件，指定文件不可读时拒绝启动。

## 本地环境

| 配置                                                | 含义                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `NODE_ENV`                                          | development / test / production                                         |
| `APP_ORIGIN`                                        | 浏览器入口，默认 `http://localhost:5173`；必须精确匹配实际端口          |
| `HOST` / `PORT`                                     | API 监听地址，默认 `127.0.0.1:3000`                                     |
| `VITE_API_BASE_URL`                                 | 开发留空，Vite 将 `/api` 代理到 API；分离部署时填写 HTTPS API origin    |
| `DATABASE_URL`                                      | 实际业务库 PostgreSQL URL，密码特殊字符需 URL 编码                      |
| `POSTGRES_DB/USER/PASSWORD/PORT`                    | 开发 Compose 参数；修改后同步更新 DATABASE_URL                          |
| `POSTGRES_TEST_PORT`                                | 开发 Compose 测试库端口，默认 5433                                      |
| `TEST_DATABASE_URL`                                 | 仅供独立集成测试，数据库名称必须以 `_test` 结尾                         |
| `COMPOSE_PROJECT_NAME`                              | 可选，用于在同宿主机运行多个实例时隔离 Compose 容器与卷；需配合不同端口 |
| `OBJECT_STORAGE_DRIVER`                             | 开发默认 local；生产必须 r2；测试使用内存替身                           |
| `LOCAL_STORAGE_PATH`                                | local 文件目录，默认 `.comiku-data/objects`，相对项目根目录             |
| `TRUSTED_PROXY_CIDRS`                               | 明确信任的代理 IP/CIDR，默认空；不接受通配信任或跳数                    |
| `TYPESET_BATCH_MAX_MIB` / `TYPESET_BATCH_MAX_WORKS` | 单批成图上传和展开后的容量/作品上限，默认 512 MiB / 20 部               |

`pnpm dev` 包含独立 worker；若单独运行 `pnpm dev:server`，需另开终端运行 `pnpm dev:worker` 才能生成缩略图、处理抓取和后台 ZIP。`pnpm images:backfill` 每次最多登记 100 个需要补齐缩略图的文件，再由 worker 处理。

已有卷不会因更改 `POSTGRES_PASSWORD` 自动改密。使用 `docker compose -f docker-compose.dev.yml stop` 停止开发数据库；不要删卷重建来修复配置。

## R2

显式使用 r2 时完整配置下列四项：

```dotenv
OBJECT_STORAGE_DRIVER=r2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_KEY_PREFIX=
```

Account ID 为 32 位十六进制。实现根据 Account ID 生成 S3 endpoint，不读取 `R2_ENDPOINT`、`R2_BUCKET_NAME` 或管理 API Token。请使用 R2 S3 Access Key/Secret，并填 `R2_BUCKET`。密钥不放入前端变量。

`R2_KEY_PREFIX` 是可选的对象路径前缀，通过相同的 `.env` 或 `COMIKU_ENV_FILE` 读取。例如 `R2_KEY_PREFIX=source-test/` 将逻辑 key `source/example.jpg` 存为 `source-test/source/example.jpg`；数据库仍保存逻辑 key。普通上传、签名上传/读取、流读取、HEAD 和删除均通过同一前缀包装器。留空保持原路径；只接受以 `/` 结束的安全目录段。前缀用于共桶命名隔离，不代替独立权限；已有数据切换前缀前须迁移对象并同步生命周期规则，配置更改不会自动搬运。

Bucket 保持私有，CORS 精确允许当前浏览器 origin，方法为 GET/PUT/HEAD，允许 content-type、x-amz-meta-sha256，按需暴露 ETag。浏览器直接向签名 URL 上传/下载，API 和 worker 负责权限、HEAD/魔数/摘要、解包及采用校验。业务对象与备份对象使用独立 Bucket 和凭据。

只能给 `staging/candidate-upload/`、`staging/typeset-upload/`、`staging/user-avatar/`、`staging/direct-upload/` 设置一日过期规则；使用 `R2_KEY_PREFIX` 时规则也须包含该前缀。不要给所有业务对象统一短期过期。原图、缩略图、可恢复版本、交接和发布历史各有引用与清理规则。

local 与 R2 不是自动迁移关系：更换驱动不会搬运已有对象。使用独立测试库/桶验证 R2，不要把原 local 数据库直接切到空 R2 Bucket。

## X 与后台调度

提供 X 官方 API 与网页会话两种适配器，真实服务可用性需自行验证；无凭据时其他手动图源和制作流程仍可使用。

| 配置                                                    | 用途                                      |
| ------------------------------------------------------- | ----------------------------------------- |
| `X_BEARER_TOKEN`                                        | 官方 API Bearer Token                     |
| `X_OFFICIAL_DAILY_BUDGET` / `X_OFFICIAL_MONTHLY_BUDGET` | 官方回退请求计数上限；任一为 0 即关闭回退 |
| `X_WEB_BEARER_TOKEN`                                    | 网页会话 Bearer                           |
| `X_WEB_AUTH_TOKEN` / `X_WEB_CSRF_TOKEN`                 | 本人合法会话 auth_token 与 ct0            |
| `X_WEB_USER_MEDIA_QUERY_ID`                             | 当前 UserMedia 查询 ID                    |
| `X_WEB_USER_BY_SCREEN_NAME_QUERY_ID`                    | 作者资料同步所需查询 ID                   |
| `X_WEB_FEATURES_JSON`                                   | 当前网页请求 feature 对象，默认空对象     |
| `SOURCE_SCHEDULE_ENABLED`                               | 自动抓取总开关，默认 false                |
| `SOURCE_SCHEDULE_MINUTES`                               | 调度周期，默认 60、最小 5 分钟            |
| `SOURCE_OVERLAP_MINUTES`                                | 已完成水位重叠窗口，默认 10 分钟          |
| `SOURCE_FAILURE_THRESHOLD` / `SOURCE_COOLDOWN_MINUTES`  | 连续失败阈值及冷却，默认 3 次 / 360 分钟  |

网页核心配置需成套提供，Cookie、query ID 和 features 可能过期。官方预算按 UTC 日/月累计请求，不等于账单费用上限，也不替代平台套餐控制。先用少量授权作者手动联调，再决定是否启用周期抓取和付费回退。任何凭据都不粘贴到公开 issue、截图或日志。

## 可选图片识别

继续通过 `.env` 或 `COMIKU_ENV_FILE` 指定 API/worker 配置。`IMAGE_ANALYSIS_ADAPTER` 默认 disabled；example 仅演示，ba-pixai 使用 `IMAGE_ANALYSIS_CONFIG_FILE` 指向仓库外的私有 JSON，external 另需模块绝对路径。详见[模型接口](adapters/image-analysis.md)。

当前模型由上述配置加载的 adapter 身份生成 modelKey，API 与 worker 必须使用一致配置并一起重启切换。逐图历史结果按 `(mediaId, modelKey)` 保留；候选的 `analysisModelKey` 只是汇总缓存的来源标记，不是启用开关。只有与当前模型匹配的成功汇总才参与优先级和排序；其余暂按原分组内时间排序。worker 每轮最多从 20 条已有当前模型结果的候选重建汇总，无需重新推理已成功的图片。未配置模型时保留数据库历史，页面不使用旧分数。

BA 常驻推理进程可用独立 EnvironmentFile 注入 `PIXAI_MODEL_DIR`、`PIXAI_CHECKPOINT`、`PIXAI_HEAD_FILE`、`PIXAI_SERVICE_TOKEN` 与线程预算；三个模型路径必须绝对，不搜索默认或隐藏目录。环境文件放在部署者选定的私有位置，不需要在仓库新增 config 或 models 目录。API/worker 的 dotenv 加载不会自动为另一个 Python 进程注入变量；由服务管理器或启动环境提供。

采集历史在“管理 → 系统管理”中查询，只有管理员可访问完整批次列表。候选池的“同步图源”由图源/管理员手动触发全部已授权且启用采集的账号，不依赖候选筛选条件。

## 常见问题

- **pnpm 版本不匹配**：运行 `Get-Command pnpm -All`（PowerShell）或 `which -a pnpm`，确认调用 9.1.2。已有正确版本时调整 PATH；没有则安装 `npm install --global pnpm@9.1.2`。不要关闭 engine-strict 或无版本安装最新版。
- **作品详情通用服务器错误**：先检查 API 日志和 `pnpm db:status`。有待应用迁移时先停止当前运行的 API/worker 进程，执行 `pnpm db:deploy`，然后重启；不要 reset 或 demo:init。数据库 ready 不代表迁移齐全。
- **数据库连不上**：确认 Docker 和对应 PostgreSQL 容器健康、端口与 DATABASE_URL 一致；重启系统后先启动 Docker。不要直接删除 Docker 虚拟磁盘或数据卷。
- **Vite 换到其他端口**：先关闭本项目遗留进程，或同步 APP_ORIGIN 后重启。浏览器地址和 Origin 不一致会拒绝写请求。
- **Windows API 端口 EACCES**：检查 `netsh interface ipv4 show excludedportrange protocol=tcp`；换一个不在排除范围内的 PORT，Vite 会读取同一配置。
- **请求来源或格式无效**：使用配置的页面 origin；JSON 写请求需正确 Content-Type 和 `X-Comiku-Request`，空请求体接口也按客户端契约发送 `{}`。不要移除服务端来源检查。
- **缩略图/ZIP 长时间排队**：检查 worker、数据库、任务状态与临时磁盘容量，使用 `pnpm ops:status`。不要通过重复提交覆盖版本基线。
- **安装后缺少 Prisma Client**：运行 `pnpm db:generate`；构建和测试脚本会自动生成。不要从另一台机器复制生成客户端或原生依赖。

普通测试与 CI 不访问真实外部服务；相关凭据、费用、访问权限和网络测试属于部署者显式启用的独立工作。
