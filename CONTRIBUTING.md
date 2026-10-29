# 参与 Comiku 共建

欢迎提交可复现的问题、文档修正和有测试的功能修改。提交贡献即表示你有权按项目的 MIT 许可提供该贡献；不要提交他人的私有代码、授权截图、作品、Cookie、密钥或数据库转储。

## 工程结构

| 路径                    | 用途                                        |
| ----------------------- | ------------------------------------------- |
| `apps/web`              | React 页面、共享 UI、Playground 和前端测试  |
| `apps/server`           | NestJS 业务模块、worker、管理脚本和后端测试 |
| `apps/server/prisma`    | 唯一 schema 和完整迁移链                    |
| `packages/api-client`   | 根据 OpenAPI 生成的共享客户端               |
| `docs/api/openapi.json` | 后端离线导出的受版本管理契约                |
| `deploy`                | Linux 镜像、Compose、Caddy 和备份配置模板   |

固定 Node.js 24.22.1 / pnpm 9.1.2。使用根目录 workspace 和唯一锁文件，不全局安装 Nest CLI。版本变更需对齐根配置、`.node-version`、`.nvmrc`、部署镜像和镜像测试断言。

## 修改与验证

业务规则见 [架构说明](docs/architecture.md)，UI 以 [DESIGN.md](DESIGN.md)、语义 token 和 `/playground` 为准。先核对规则，再修改实现；不要在页面复制角色或状态枚举。权限、流程、版本边界和文件授权必须由后端再次校验。

按顺序运行以下命令，避免多个 Prisma generate 同时写入同一目录：

```sh
pnpm runtime:check
pnpm format:check
pnpm lint
pnpm db:validate
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @comiku/server build:ops
pnpm api:check
```

普通测试不访问真实 X/R2 或业务数据库。业务变更增加行为测试；UI 交互检查桌面和窄屏，保留键盘、焦点及滚动恢复。提交信息（Commit Message）只写解决的问题与具体改动；验证记录、部署说明和未覆盖边界放在相应交接文档或 PR 描述中。

### 数据库测试

使用独立、可丢弃的 `_test` 数据库；集成测试会写入/清理 fixture，绝不指向业务库。

```sh
docker compose -f docker-compose.dev.yml --profile test up -d --wait postgres-test
```

在专用终端为 `DATABASE_URL` 和 `TEST_DATABASE_URL` 设置相同的测试连接串（示例配置默认 `127.0.0.1:5433/comiku_test`），并设 `NODE_ENV=test`。然后执行：

```sh
pnpm db:deploy
pnpm db:deploy
pnpm db:status
pnpm db:drift
pnpm test:integration
```

不要把测试连接串写回普通运行用的配置。迁移一经发布不改写、不删除；新 schema 变更创建前向迁移，并验证空库重放、重复部署和无漂移。新环境初始化请通过 `pnpm db:deploy` 依次应用完整的向前迁移链。

### API 与适配器

DTO/控制器变更后执行 `pnpm api:generate`，同时提交 OpenAPI 和共享类型；不手改生成文件，详见 [API 流程](docs/api/README.md)。X、文件存储、LabelPlus 和后台任务通过适配器或模块公开服务协作。外部平台错误不应被误判成空结果或推进抓取水位。真实服务测试必须另行配置独立凭据与可接受预算。

可选识别遵循 [模型 adapter 接口](docs/adapters/image-analysis.md)，默认不加载模型；example 和 BA 实现是公开源码，模型权重、私有配置和真实样本不提交。[采集 adapter 说明](docs/adapters/source-ingestion.md) 记录来源契约与目录；gallery-dl 的 TS、Python 与固定依赖集中在 `apps/server/src/source-ingestion/adapters/gallery-dl/`，默认 Node 镜像保持轻量，可选择 `gallery-runtime` 镜像目标。开发计划、试用记录与私有实验遵循 `AGENTS.md` 的开源边界，不放进公开文档。

### Linux 验证

按 `.github/workflows/ci.yml` 构建 `comiku-server:test`、`comiku-tools:test`、`comiku-backup:test`，执行 `pnpm test:production`。该命令使用随机命名的隔离容器、网络、卷和合成数据，验证迁移、健康、HTTPS、权限及加密恢复，并清理测试创建的资源；不会读取真实 `.env`。

## 版本与发布

版本声明位于根和三个 workspace 的 `package.json` 及 OpenAPI 构造器。更新 API 版本后离线重新生成契约。根配置与各子包声明 `private: true` 仅用于防止意外发布至 npm 公共仓库，不影响源码本身的开源分发。

公开发布前执行全新安装与空库验证，确认无凭据/真实文件、文档链接有效，并在 CHANGELOG 中明确真实服务和部署验证范围。第三方依赖保留其原许可证；发布预编译 bundle 或容器时，需同时处理所包含依赖、原生库和基础镜像的许可证及对应源码要求。
