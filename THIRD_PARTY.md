# 第三方依赖与素材

Comiku 的原创代码、文档和自有示例图采用 MIT；第三方包保留各自许可证。本文件不改变第三方授权，也不表示项目与所引用平台存在关联。

## 依赖

根目录及 workspace 的 `package.json` 说明直接依赖，`pnpm-lock.yaml` 固定实际解析版本。依赖通过包管理器安装，其许可证与声明随对应软件包提供。

主要依赖包括 React、Vite、NestJS、Prisma、AWS SDK、Sharp/libvips、fflate、Lucide、OpenAPI 工具和 PostgreSQL；具体许可证和声明以安装版本中的 LICENSE、NOTICE 和包元数据为准。Sharp 包含原生图像库，Docker 镜像也包含独立授权的系统组件。

若分发前端构建产物、二进制或容器，需要为实际包含的依赖和原生库整理许可证、声明及适用的对应源码；不能仅附项目 MIT 许可证文本替代这些义务。本仓库提供源码，不分发依赖目录或预构建镜像。完整的传递依赖许可证清单需根据实际分发产物另行核对。

## 图标与示例

- 通用界面图标通过 `lucide-react` 依赖提供，保留该包的许可证。
- X、Pixiv 名称及界面中的平台标识用于指明外部账号链接，不属于 Comiku 的品牌授权，也不表示得到平台认可。
- `apps/web/public/samples/demo-work.svg` 是本项目生成的中性几何演示图，PNG 由同目录 SVG 生成；`pnpm demo:image` 可重新生成。测试 fixture 为合成数据。
- 用户上传的漫画、授权截图及其他材料由其权利人授权，不属于软件示例素材，也不因软件 MIT 许可而转为开源素材。
