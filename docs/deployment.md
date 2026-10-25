# 生产运行与真实服务联调

本仓库提供基于 Ubuntu/Linux 的生产部署模板（涵盖 Pages 前端、Caddy 反向代理、API/worker 服务、PostgreSQL、私有 R2 存储及加密备份策略）。由于外部平台接口及各团队生产环境存在差异，真实服务的连通性、生产容量及长期稳定性需由部署者在目标环境中完成实测。

## 1. 配置入口

| 文件                                                                   | 用途                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `deploy/Dockerfile`                                                    | Node 24.22.1 / pnpm 9.1.2 多阶段构建；runtime、tools、backup 三个目标   |
| `deploy/compose.production.yml`                                        | API、worker、迁移、PostgreSQL、Caddy；ops/backup/restore 为显式 profile |
| `deploy/production.env`                                                | 由 `.example` 复制，填写 IMAGE_TAG、APP_DOMAIN、API_DOMAIN；不放密钥    |
| `deploy/.secrets/runtime.env`                                          | 数据库 URL、业务 R2、X、抓取和容量参数；由 `runtime.env.example` 复制   |
| `deploy/.secrets/postgres-password`                                    | 应用账号 comiku 的密码，必须匹配 runtime.env URL                        |
| `deploy/.secrets/postgres-admin-password` / `postgres-backup-password` | PostgreSQL 管理员与只读备份账号的独立密码                               |
| `deploy/.secrets/origin-cert.pem` / `origin-key.pem`                   | Cloudflare Origin CA 证书和私钥                                         |
| `deploy/.secrets/backup.env` / `backup-key`                            | 独立备份 R2 凭据、政策、32 字节随机加密密钥的 64 位十六进制文本         |
| `deploy/.secrets/restore-password`                                     | 隔离恢复库密码，必须匹配 `RESTORE_DATABASE_URL`                         |
| `deploy/.backups/`                                                     | 可选离线加密归档输入/解密输出，不进入镜像或 Git                         |

真实文件均被 Git 和 Docker 构建上下文排除。Compose secrets 是宿主文件挂载，不是自动加密的密钥保险库；限制宿主访问。Linux 上 runtime.env、backup.env、backup-key 由 uid 1000 所有，权限 0400；三个 PostgreSQL 密码文件及 restore-password 由 uid 999 所有、0400，供 PostgreSQL 初始化读取；源站私钥只给 Caddy 读取。数据库密码使用 32–128 位独立随机英数字/下划线/连字符，便于安全注入 SQL 与 URL。`deploy/.backups` 若需要解密输出，设为 uid 1000 所有、0700。Windows Docker Desktop 的权限映射不同，正式服务器再核对。

API/worker/tools 通过绝对 `COMIKU_ENV_FILE` 加载相同配置，显式容器环境优先。备份只加载 `COMIKU_BACKUP_ENV_FILE`，不注入业务 R2/X 凭据。`pnpm deploy:check` 校验域名、提交标识、数据库密码对应关系、完整 R2 参数、证书匹配/有效期及已确认备份政策，不输出原始密钥。`--test` 只用于静态配置检查，不启用生产备份，也不证明真实凭据有效。

## 2. 网络、HTTPS 与 Pages

前端使用 `app.<主域>`，API 使用 `api.<同一主域>`。Pages 设置根目录构建命令 `pnpm --filter @comiku/web build`、输出 `apps/web/dist`，固定 Node 24.22.1 / pnpm 9.1.2，构建变量 `VITE_API_BASE_URL=https://api.<主域>`。只公开这一类前端配置，不放 R2/X 密钥。仓库的 `apps/web/public/_redirects` 提供 SPA 路由回退。改变 API origin 后重新构建。

API 仍精确匹配 `APP_ORIGIN`、携带凭据 CORS 和写请求 `X-Comiku-Request`，生产 Cookie 为 Secure、HttpOnly、SameSite=Lax、Path=/api、API host-only；在线 Swagger 关闭。不要使用默认 `pages.dev` 与任意另一主域拼接为正式登录部署。

源站方案采用 Caddy + Cloudflare Origin CA，Cloudflare 设置 **Full (strict)**。证书需覆盖 API 子域；Caddy 2.10.2 固定镜像。Origin CA 不用于浏览器直接访问源站。Caddy 不发布管理端口，不记录包含签名地址或 Cookie 的访问日志。

数据库/API/worker 不发布宿主端口，只有 Caddy 发布 80/443。Caddy 使用官方 Cloudflare IP 范围和 `CF-Connecting-IP`，只有连接对端属于这些范围才采用该头；再覆盖发往 API 的 X-Forwarded-For，并删除其他客户端 IP 头。API 只信任 `172.30.0.2/32` 的 Caddy，默认开发不信任任何转发头，不使用 hop count 或信任所有代理。未经 Cloudflare 的 HTTPS 源站请求返回 403。

上线前与官方 IPv4/IPv6 清单核对 `deploy/cloudflare.caddy`，并在云防火墙限制源站入口只来自 Cloudflare，SSH 只来自运维地址。Docker 发布端口可能绕过 UFW 规则，应同时使用云防火墙或正确的 DOCKER-USER/nftables 规则，不能只依赖 UFW。暂不提供未经核对就自动修改服务器防火墙的脚本。若 172.30.0.0/24 与现有网络冲突，必须同步调整 Compose edge 网段、API/Caddy 静态地址和可信地址，不能单独改其中一个。

## 3. 构建、首次启动与升级

下列命令在仓库根目录执行，先填好文件和检查参数；示例不包含可直接部署的真实域名或密码：

```sh
pnpm deploy:check
docker compose --env-file deploy/production.env -f deploy/compose.production.yml --profile backup build
docker compose --env-file deploy/production.env -f deploy/compose.production.yml up -d --wait
docker compose --env-file deploy/production.env -f deploy/compose.production.yml --profile ops run --rm tools pnpm admin:init
```

IMAGE_TAG 必须使用 7–40 位已审核 Git commit 十六进制标识。从待部署的提交取得该标识；版本标签（例如 v0.9.0）不能直接作为检查器支持的 IMAGE_TAG。构建参数同时记入镜像与备份元信息。runtime 镜像只带服务端生产依赖和 Linux 编译产物；tools 包含 Prisma/受控管理员命令，默认 API 不安装工具链。所有镜像在 Linux 内安装依赖，不复制 Windows node_modules。标准镜像源不可用时，可通过 `NODE_IMAGE`/`POSTGRES_IMAGE` 构建参数指定可信注册表的**同版本**镜像，不修改全局 Docker 配置、不降级运行时。

首次空卷通过 postgres-init.sh 创建非超级用户应用账号 comiku 和只读账号 comiku_backup；超级用户 postgres 的凭据只注入数据库容器。该初始化只在空卷执行，已有卷不自动更改账号或密码。备份使用只读账号和独立密码，不能写业务表。先等待数据库就绪，再由 migrate 前向迁移，只有迁移成功才启动 API/worker，API 健康后启动 Caddy。失败查看 migrate 日志，不自动执行 reset、db push 或 migrate resolve。PostgreSQL 数据与 Caddy 数据使用持久卷，禁止把 `down -v` 当日常重启命令。`admin:init`/`admin:recover` 只在交互终端运行，不将一次性密码输出重定向到日志。

升级前完成可用加密备份，核对当前软件/迁移版本与对象恢复窗口；暂停 Caddy/API/worker 的制作请求，构建或拉取审核后的新 IMAGE_TAG，然后重新 `up -d --wait`。迁移必须前向执行；回滚只在确认旧软件兼容当前 schema 后更换镜像，不逆向重写迁移。恢复数据库应先在隔离库演练，不覆盖正式库。

## 4. 资源、健康与任务

工程初始容器上限：API 768 MiB、worker 1280 MiB、PostgreSQL 768 MiB、Caddy 128 MiB；按需备份 384 MiB，迁移 384 MiB。常驻共 2944 MiB，为 4GiB 主机保留系统空间；CPU quota 是各进程上限而非保证份额。备份/迁移/恢复演练不要全部与峰值任务同时运行，资源限额需根据实际主机和负载测试调整。

API V8 heap 384 MiB、worker 512 MiB；图片原生缓冲及 tmpfs 也计入容器总内存。API `/tmp` 256 MiB、worker 384 MiB、备份 256 MiB，有独立容量上限；超过会失败而非无上限占满宿主磁盘。API/worker/迁移和备份的根文件系统只读、API/worker 非 root，并移除额外 capability。数据库和 Caddy 持久卷仍需宿主磁盘监控。

API 健康检查访问数据库就绪入口；worker 每 10 秒确认数据库连接并写本地心跳，45 秒过期判为不健康。心跳表示进程/数据库可用，不代表所有任务成功。重启策略处理进程退出，Docker 标记 unhealthy 不会自动重启仍活着的进程；先定位数据库、任务或容量问题再重启。停止时保留既定租约恢复规则。

```sh
docker compose --env-file deploy/production.env -f deploy/compose.production.yml ps
docker compose --env-file deploy/production.env -f deploy/compose.production.yml exec api node dist/ops/status.js
docker compose --env-file deploy/production.env -f deploy/compose.production.yml logs --tail 100 worker migrate
docker stats --no-stream
df -h
```

`ops:status` 输出重任务/网络任务状态计数、最老排队时间及 24 小时抓取运行状态，不输出 payload、授权头或原始上游异常。日志按容器 10 MiB×3 轮换。初期单 API 使用进程内限速，重启清空；可信 IP 避免所有用户共用 Caddy 限额，不宣称已有多实例集中限速。重任务全局并发 1、有限重试/持久租约继续沿用。真实自动抓取默认关闭，真实服务验证后再明确开启。

## 5. 私有文件与生命周期

业务 Bucket 保持私有，精确允许前端 Origin 的 GET/PUT/HEAD 及 content-type、x-amz-meta-sha256，暴露所需响应头。预签名 PUT/GET 使用 R2 S3 域名，不通过 Pages/API 代理。不要启用公开 r2.dev 或对正式对象统一短期删除。

一日 staging 清理只覆盖 `staging/candidate-upload/`、`staging/typeset-upload/`、`staging/user-avatar/`、`staging/direct-upload/`。应用完成权威校验和采用事务；缩略图随原文件引用、成图随版本恢复期、交接历史及发布来源保持可追溯，24 小时临时发布 ZIP 缓存按未引用条件清理。清理失败保留恢复点。

数据库备份不是图片备份。演练必须核对恢复库的 FileObject key 是否仍存在，以及版本、发布快照、任务与软件版本。制作对象历史恢复期和备份保留窗口需一起确认；切勿尝试恢复时间跨度过大的历史数据库备份，并假设已被云存储生命周期规则清理的对象能自动找回。

## 6. 加密备份与隔离恢复

`backup` 镜像使用 PostgreSQL 17 的 pg_dump/pg_restore 与固定 Node。pg_dump custom 输出直接流式进入 AES-256-GCM，先得到加密归档才上传独立私有 R2；不把数据库密码放进命令参数，也不向日志转发 pg_dump/SDK 的原始错误。归档包含认证保护的格式、时间、软件 commit 元信息，Prisma 迁移记录包含在数据库内。错误密钥、篡改或截断归档不能作为恢复输入，未通过认证的解密临时输出会清理。

备份使用数据库只读账号 comiku_backup；为备份 Bucket 使用单独的对象读写凭据，不向备份容器提供业务 R2/X 凭据。加密密钥在服务器受限文件之外保存一份离线副本，恢复时需密钥和归档两者；不要把唯一解密密钥只留在待备份服务器或仅存于同一 Bucket。

正式备份默认拒绝运行，直到用户确认周期、保留期、RPO/RTO，并填写 `BACKUP_POLICY_CONFIRMED=true`、四个政策变量。周期不得大于 RPO。保留天数需对应备份 Bucket `postgres/` 生命周期，由管理员配置；脚本不自动删除远端备份。RTO 是目标，不是未经演练的承诺。

```sh
docker compose --env-file deploy/production.env -f deploy/compose.production.yml --profile backup run --rm --no-deps backup backup
```

成功日志仅显示加密对象 key、字节数、版本；失败非零退出。`deploy/systemd/comiku-backup.service` 供 Ubuntu 使用，timer.example 的每天 02:30 **仅为示例**；依据确认周期调整并移除 `.example` 后才安装/启用。核对 `/opt/comiku` 路径，执行一次成功备份与恢复演练后再开启定时器；检查 `systemctl status`、`systemctl list-timers`、`journalctl -u comiku-backup.service`，备份失败不得忽略。`Persistent=true` 只补一次错过的调度。

隔离恢复库由 restore profile 提供，不发布端口、不连接应用 worker：

```sh
docker compose --env-file deploy/production.env -f deploy/compose.production.yml --profile restore up -d --wait postgres-restore
# backup.env 填写本次加密对象 BACKUP_OBJECT_KEY，RESTORE_DATABASE_URL 必须指向隔离库。
docker compose --env-file deploy/production.env -f deploy/compose.production.yml --profile backup run --rm --no-deps backup restore --execute
```

脚本强制数据库名以 `_restore_test` 结尾，并要求目标没有用户表；不使用 --clean，不覆写现有库。先校验/解密，再以单事务 pg_restore，随后人工核对迁移、关键行数、文件引用、任务状态与软件版本，记录实际恢复时间。不要自动启动恢复库中的待执行任务。演练库 tmpfs 为 512 MiB，备份容器解密期间加密归档与明文共用 256 MiB 临时空间；较大数据需另外建立受控隔离卷并调整受控容量；恢复演练占用较多临时资源，不建议在 2 核 4G 等有限配置的宿主机上与业务峰值任务争用资源。

离线恢复可以把加密归档放到 `.backups`，运行 `backup decrypt /archives/文件.comikubak /archives/文件.dump`；输出必须尚不存在。也可设置容器环境 `RESTORE_ARCHIVE_FILE=/archives/文件.comikubak` 后执行 restore，绕过 R2 下载但仍执行同样的认证/空库保护。正式故障切换或覆写生产库不由此脚本执行，需要单独制定并批准恢复动作。

离线 Linux 验证使用 `pnpm test:production`（先构建 CI 同名三类 test 镜像），创建随机命名的独立网络、数据卷和合成账号，验证迁移重放/漂移、非超级用户与只读备份权限、API/worker 健康、HTTPS/CORS/Cookie/CSRF、加密备份恢复和空库保护以及重建持久性，结束后清理测试创建的资源，不读取本机 `.env`。`backup --test --local-only --output /绝对路径/文件.comikubak` 只允许 `_test` 库，跳过真实 R2，用于同一备份实现的离线演练；不代替真实 Bucket 验收。

## 7. 本地真实 R2 / X 联调准备

本地联调可使用 `pnpm dev`，不需要域名或正式服务器；Linux/HTTPS/代理链需另行验证。使用独立测试库和测试桶，新建测试作者/作品，不把原有 local 文件记录直接切换为 R2，也不要在真实 R2 环境运行只支持 local 的 demo:init。

联调所需配置与样本：

1. **R2 私有测试 Bucket**、Account ID、只授权该桶的 Access Key/Secret；CORS 精确允许实际本地 Origin，例如 `http://localhost:5173`，staging 一日生命周期。若测试备份，另建私有备份测试桶和独立凭据/加密密钥。
2. **网页会话使用的 X 账号**：建议专用测试账号，确认能正常登录/查看作者。在本机私有环境文件中填写 X_WEB_BEARER_TOKEN、AUTH_TOKEN、CSRF_TOKEN、当前 UserMedia query ID/features；昵称头像辅助同步还需 UserByScreenName query ID。这些参数来自本人已登录会话，可能过期；不将 Cookie/令牌粘贴进聊天、文档或 Git。
3. **官方 X API**：如需验证官方通道，准备对应应用 Bearer、核对当前开发者控制台访问/费用能力，确认小额可接受消耗和明确日/月请求上限；若不启用官方通道，将对应日/月请求预算保持为 0 即可。
4. **2–3 位已授权测试作者**、首次同步不回溯或最近 24 小时的选择，以及少量自制 PNG/JPEG/WebP/ZIP 样本。先分别测两通道，再测重复抓取、失败水位、恢复和完整制作流程；初期只手动抓取，不开启定时器。
5. **网络方式**：确认运行 API/worker 的 Node 进程能访问 X/R2；浏览器能访问不等于服务端出站已可用。代理参数如需支持，先核对当前实现和实际连接方式，不把浏览器插件等同于进程代理。

本地联调无需正式域名、服务器登录或生产备份政策。进入 Linux 生产形态和正式部署前，再准备同主域 app/api、Cloudflare DNS/Origin CA、服务器访问、业务/备份正式 Bucket 及经过确认的备份/对象恢复政策。

参考：[Caddy 可信代理](https://caddyserver.com/docs/caddyfile/options#servers)、[Cloudflare IP 清单](https://www.cloudflare.com/ips/)、[Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)、[R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)、[PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)。
