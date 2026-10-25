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
```

Account ID 为 32 位十六进制。实现根据 Account ID 生成 S3 endpoint，不读取 `R2_ENDPOINT`、`R2_BUCKET_NAME` 或管理 API Token。请使用 R2 S3 Access Key/Secret，并填 `R2_BUCKET`。密钥不放入前端变量。

Bucket 保持私有，CORS 精确允许当前浏览器 origin，方法为 GET/PUT/HEAD，允许 content-type、x-amz-meta-sha256，按需暴露 ETag。浏览器直接向签名 URL 上传/下载，API 和 worker 负责权限、HEAD/魔数/摘要、解包及采用校验。业务对象与备份对象使用独立 Bucket 和凭据。

只能给 `staging/candidate-upload/`、`staging/typeset-upload/`、`staging/user-avatar/`、`staging/direct-upload/` 设置一日过期规则；不要给所有业务对象统一短期过期。原图、缩略图、可恢复版本、交接和发布历史各有引用与清理规则。

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
