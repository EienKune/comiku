# 主题包维护

Comiku 的外观由通用主题核心、默认包和可选主题包组成。默认装配提供八种基础预设及九套 BA 主题，新增的“黑白夜间”、“青绿夜间”和“普拉娜夜间”手动选择生效，原有预设保留名称、ID、色值和组件交互。

## 装配位置

`packages/theme-catalog/src/installed.mjs` 是前后端共用的装配清单。保留 `defaultThemePack`；需要移除 BA 外观时，移除 BA 元信息的 import 及数组条目。API、worker 和 Web 采用同一份清单，修改后统一重新构建部署。

`@comiku/theme-catalog` 只包含纯元信息和目录校验。API 用其预设 ID 校验设置并生成 OpenAPI；前端据此生成选择菜单。Web 构建插件仅引用已注册包的实现，移出清单的包不进入应用构建。

## 包的结构

- 元信息放在共享包中，包括包 ID、预设 ID、名称、品牌色、样式 ID 和是否提供预览样式。
- 浏览器实现在 `apps/web/src/themes/packs/<包 ID>/index.ts` 导出 `themePack`，提供样式定义、token 及可选的按钮对比度颜色信息。
- 正式组件所需 CSS 由包入口导入，按 `data-theme-style` 限定作用范围。默认包继续复用基础 token 和组件样式。
- Playground 专用装饰放在包内的 `preview.css`，随 Playground 路由按需加载。业务页面共用的按钮、卡片和标题规则留在运行样式中。
- 包专属测试与实现放在同一目录，包移除后通用主题核心和其他包仍可构建。

新增包时注册元信息，创建同名浏览器实现，保持预设与样式定义对应。核心负责变量应用、旧变量清理、预览恢复和存储兼容；页面继续复用原有组件。修改注册清单后运行 `pnpm api:generate` 同步允许值，再执行类型检查、测试和构建。

## 最小自定义示例

以下 `team` 包沿用基础组件，只调整品牌色与一项共享圆角，可作为新主题的起点。

创建 `packages/theme-catalog/src/team.mjs`：

```js
export const teamThemePack = {
  id: "team",
  preview: false,
  presets: [
    { id: "team-blue", name: "团队蓝", brand: "#5599ff", style: "team" },
  ],
};
```

创建 `apps/web/src/themes/packs/team/index.ts`：

```ts
import type { ThemePack } from "../../registry";

export const themePack: ThemePack = {
  id: "team",
  definitions: [{ style: "team", tokens: { "--radius-md": "12px" } }],
};
```

在 `packages/theme-catalog/src/installed.mjs` 导入并加入清单；此例保留基础包，以团队主题替换 BA 包：

```js
import { defaultThemePack } from "./default.mjs";
import { teamThemePack } from "./team.mjs";

export const installedThemePacks = [defaultThemePack, teamThemePack];
```

重新生成契约、检查并构建后，站点设置、个人外观和 Playground 会出现“团队蓝”。增加同风格配色时，可在 `presets` 中添加不同的 ID、名称与品牌色，复用 `style: "team"`。

需要形状或材质覆盖时，从包入口导入 `runtime.css`，使用 `:root[data-theme-style="team"]` 限定规则；仅用于 Playground 的装饰放入 `preview.css`，同时将元信息的 `preview` 设为 `true`。自定义主按钮配色时，运行样式负责绘制，`actionColors` 提供相同的前景与背景用于对比度预览，参照 BA 包实现。

## 已保存选择

站点选择的主题不可用时，展示使用默认青绿；有效的名称、图标和 revision 继续保留。个人选择的主题不可用时暂时跟随站点，站点主题也缺失时使用基础主题。

兼容读取保留数据库和浏览器中的原选择，重新装配对应包后可以恢复；用户主动保存新选择时更新。仅修改名称或图标时，设置 PATCH 省略 `themePresetId`，后端保留原主题；旧客户端完整提交的方式继续支持。已有主题、自定义颜色、旧版浏览器偏好及“跟随站点”继续沿用。主题切换即时生效，主题包装配在代码和构建阶段完成。

## 验证

默认装配检查所有预设、主题间切换、个人与站点选择、Playground 恢复及组件对比度。仅保留默认包时，重新生成 API 契约并检查前后端构建、设置校验和历史选择回退；验证结束后恢复默认装配及对应生成契约。

视觉检查覆盖桌面和窄屏的登录、导航、卡片、编辑器标记、弹窗和 Playground。基础组件结构、业务状态色和作品图片内容保持原有含义。
