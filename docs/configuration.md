# 环境配置与排错

根 `.env.example` 是配置模板。复制为 `.env` 后再填写；不要把真实配置提交到仓库。源码、构建产物与 Prisma 按文件位置找到项目根目录；进程环境变量优先于文件。生产可使用绝对路径 `COMIKU_ENV_FILE` 指定 secret 文件，指定文件不可读时拒绝启动。

X/Pixiv 资料解析返回有效期十分钟的 `profileProof`，绑定操作人、作者范围、平台及账号身份。X 新增关联、修改 handle 和重新启用采集时需要该凭证；Pixiv 支持仅填数字 ID 手工维护，采用解析资料或平台头像时校验凭证。生产及多 API 实例通过私有环境配置同一个随机 `AUTHOR_PROFILE_PROOF_SECRET`（建议至少 32 字符）；未配置时使用进程内随机密钥，重启或切换实例后需重新同步尚未保存的资料。该密钥用于资料凭证签名，平台采集继续使用独立的凭据 generation。

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

开发、测试与生产模板使用 PostgreSQL 18，小版本随所选 18 系列官方镜像更新；主版本不自动升级。18 的数据卷挂载到 `/var/lib/postgresql`，默认 `PGDATA=/var/lib/postgresql/18/docker`。旧 17 数据卷不能直接交给 18 启动，升级步骤见[部署说明](deployment.md#postgresql-主版本升级)。

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

只能给 `staging/candidate-upload/`、`staging/typeset-upload/`、`staging/user-avatar/` 设置一日过期规则；使用 `R2_KEY_PREFIX` 时规则也须包含该前缀。`staging/direct-upload/` 由应用根据任务租约与终态回执分阶段清理，不得配置按对象年龄自动删除的规则；升级前须核对桶中实际规则并排除此路径。不要给所有业务对象统一短期过期。原图、缩略图、可恢复版本、交接和发布历史各有引用与清理规则。

local 与 R2 不是自动迁移关系：更换驱动不会搬运已有对象。使用独立测试库/桶验证 R2，不要把原 local 数据库直接切到空 R2 Bucket。

## X 与后台调度

群通知使用可选 `NOTIFICATIONS_ENABLED`（默认 false）和绝对路径 `NOTIFICATION_CONNECTIONS_FILE`。连接、token 环境变量和精确 IP 白名单由部署者在私有文件配置，API/worker 共享同一配置；网页只选择已配置连接。业务 Service 不调用通知模块，后台已通过持久 WorkEvent 异步接入作品变化。启用后会自动推送持久起点之后符合已启用群订阅的事件；首次起点之前的历史不自动补发，全局暂停后恢复沿用原起点。启用真实连接前应核对群目标、订阅和模板。详见 [群通知](notifications.md)。

角色生日使用独立的 `BIRTHDAYS_ENABLED`（默认 false），API 与 worker 保持一致。开启后系统管理可配置工作台展示、上海时区的提醒时间和 0／1／7 天偏移；提醒还需要通知总开关及目标群的生日订阅。未开启不请求 SchaleDB、Kivo 或轮询生日任务，开启只展示也不需要配置群通知。Kivo 公开资料不需要平台登录凭据，分批缓存后合并至本地名册。资料与提醒的恢复、有效期和身份规则见[角色生日](birthdays.md)。

日常采集与账号资料同步使用 gallery-dl 的 X/Pixiv 实现，Python 环境、平台配置文件和首次同步范围见 [gallery-dl 说明](../apps/server/src/source-ingestion/adapters/gallery-dl/README.md)。旧网页会话与官方 API 实现保留为历史源码和合成测试；运行时按已配置的 gallery-dl 通道执行。

| 配置                                                   | 用途                                     |
| ------------------------------------------------------ | ---------------------------------------- |
| `SOURCE_SCHEDULE_ENABLED`                              | 自动抓取总开关，默认 false               |
| `SOURCE_SCHEDULE_MINUTES`                              | 调度周期，默认 60、最小 5 分钟           |
| `SOURCE_OVERLAP_MINUTES`                               | 已完成水位重叠窗口，默认 10 分钟         |
| `SOURCE_FAILURE_THRESHOLD` / `SOURCE_COOLDOWN_MINUTES` | 连续失败阈值及冷却，默认 3 次 / 360 分钟 |

先用少量授权作者手动验证 gallery-dl 的私有配置，再决定是否启用周期抓取。任何凭据都不粘贴到公开 issue、截图或日志。`X_OFFICIAL_DAILY_BUDGET` / `X_OFFICIAL_MONTHLY_BUDGET` 仍是自定义计费 client 的兼容预算输入，日常模块不会因此注册官方 API 或启用回退。

## 可选图片识别

继续通过 `.env` 或 `COMIKU_ENV_FILE` 指定 API/worker 配置。`IMAGE_ANALYSIS_ADAPTER` 默认 disabled；example 仅演示，ba-pixai 使用 `IMAGE_ANALYSIS_CONFIG_FILE` 指向仓库外的私有 JSON，external 另需模块绝对路径。详见[模型接口](adapters/image-analysis.md)。

当前模型由上述配置加载的 adapter 身份生成 modelKey，API 与 worker 使用一致配置；已有持久激活记录时，先排空并停止旧 worker，再按[模型接口的受控激活流程](adapters/image-analysis.md#persistent-scheduling-and-activation)切换，最后一起重启。识别任务由匹配已激活身份的 worker 处理。逐图历史结果按 `(mediaId, modelKey)` 保留；候选的 `analysisModelKey` 记录汇总缓存的来源。审核分区、代表分类和排序直接核验当前模型的逐图结果及文件 SHA，采用有效图片的最高排序分，标签规则和有效逐图证据共同决定自动区域。无有效分数时按时间和 ID 排序。稳定审核会话固定当次分区与顺序，显式刷新后采用最新规则和分数。worker 每轮最多处理 20 条候选的汇总修复，复用已有逐图结果。识别关闭时保留历史记录，审核继续使用原帖标签规则。

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

## Source image size and recovery

`SOURCE_MEDIA_MAX_MIB` limits original image downloads (default 50 MiB, integer 1–100). Both declared and actual streamed bytes are checked; rejected bodies are cancelled. This also applies to remote author profile downloads using the shared downloader; manual uploads retain their separate 25 MiB limit. Each active download can briefly retain chunks plus the final buffer (roughly twice the limit); X and Pixiv may download concurrently. Account for these buffers, thumbnail processing and the separate model process before increasing the limit. Pixel safety limits are unchanged.

Image analysis accepts original input up to 32 MiB. Larger images within the collection limit can be stored as candidates, but their analysis fails at input validation. Retrying the same oversized image reaches the same limit.

Size-limit and forbidden-URL rejections retain controlled media reasons and put the discovery in `needs_attention`. Unsupported-type and empty-body responses remain retryable, since a CDN can transiently return an HTTP-200 error page or empty response. Diagnostics contain controlled reasons, `limit_bytes`, and `declared_bytes` or `observed_bytes` when available. After changing configuration, operators inspect terminal gaps and explicitly authorize recovery.

Transient post gaps first become eligible after 5 minutes; after the first failed recovery campaign they wait 10 minutes, then 30 minutes between remaining campaigns, up to eight campaigns. Each campaign uses the normal job executor (at most three executions, 5/10-second delays). Platform gates, the shared per-platform queue and the maintenance scan determine execution after eligibility. Account cooldown uses `SOURCE_COOLDOWN_MINUTES`.

## Online source credential maintenance

Online editing is opt-in: set `SOURCE_CREDENTIALS_STATE_DIRECTORY` to an existing absolute private directory (0700) outside the checkout and Docker build context. The configured gallery JSON and referenced Cookie files must be owned by the service user (0600), with private writable parent directories. Native Windows online editing is read-only because POSIX mode bits do not establish a Windows ACL.

All participating API and worker processes must see the **same files**, not merely matching path strings. Use a shared writable private directory; independent hosts and read-only single-file Docker mounts do not meet this contract. Do not externally edit these files while an update operation is active. Platforms sharing configuration or referenced Cookie material cannot be edited independently.

The administrator flow is pause, wait for confirmed execution completion, save, optional bounded authentication verification, then explicitly resume. Pausing preserves queued jobs and account settings. Closing the dialog does not resume the platform. A lease deadline is not proof that a subprocess or network stream has stopped. New credentials must still respect a trusted platform cooldown.

The directory contains private recovery material, including previous credentials. It must have restricted access and an appropriate private backup policy. Unresolved operations retain their material; do not delete it to unlock the UI. See [source-ingestion maintenance](adapters/source-ingestion.md) for explicit recovery boundaries. X accepts paired `auth_token`/`ct0` fields; Pixiv accepts an application refresh token. A browser `PHPSESSID` Cookie is a different credential and is not an application refresh token.

## 登录期限

`AUTH_SESSION_IDLE_SECONDS`（默认 1800）控制没有实际操作的空闲期限；`AUTH_SESSION_ABSOLUTE_SECONDS`（默认 28800）控制每次登录的固定上限。两项为可安全表示的正整数秒数，空闲期限不能大于绝对期限。私有协作环境可分别设置为 `604800` 和 `2592000`，即空闲 7 天、登录满 30 天重登。

页面可见时的真实点击、键盘或滚轮操作通过同源 `/api/auth/activity` 续空闲期；后台轮询、页面仅保持打开、重新切到前台都不续期。客户端请求与服务端写入分别节流，最短间隔为 300 秒与空闲期限一半的较小值。活动请求不消耗普通业务写入配额，仍有独立的账号和 IP 限流。绝对期限及 Cookie 不随活动延长；登出、撤销会话、禁用账号和改密继续使旧会话失效。新配置不会批量延长旧会话的绝对到期时间，重新登录后使用新上限。
