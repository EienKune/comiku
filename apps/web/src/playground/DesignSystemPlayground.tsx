import { Avatar } from "../components/Avatar";
import { useEffect, useRef, useState } from "react";
import { OptionalSection } from "../components/OptionalSection";
import { PlatformLinks } from "../components/PlatformLinks";
import {
  AlertCircle,
  Archive,
  ArrowRight,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  CloudOff,
  Code2,
  Component,
  FileImage,
  GalleryVerticalEnd,
  Inbox,
  Languages,
  LayoutDashboard,
  Menu,
  MessageCircleMore,
  MoreHorizontal,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shapes,
  Sparkles,
  SwatchBook,
  Type,
  Users,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  SearchField,
  SelectField,
  Surface,
  TextField,
} from "../components/ui";
import { MarkerDemo } from "./MarkerDemo";
import { WorkViewsDemo } from "./WorkViewsDemo";
import { ImageLightboxDemo } from "./ImageLightboxDemo";
import { ReviewModeDemo } from "./ReviewModeDemo";
import { ThemePreview } from "./ThemePreview";
import { InteractionLab } from "./InteractionLab";
import "./playground.css";

const sections = [
  { id: "theme", label: "换肤试验", icon: Palette },
  { id: "foundation", label: "设计基础", icon: SwatchBook },
  { id: "interaction", label: "交互手感", icon: Sparkles },
  { id: "components", label: "基础组件", icon: Component },
  { id: "patterns", label: "业务模式", icon: LayoutDashboard },
  { id: "workspace", label: "翻译工作台", icon: Languages },
  { id: "states", label: "反馈状态", icon: Bell },
];

const colorTokens = [
  { name: "Brand", value: "随主题派生", className: "brand" },
  { name: "Pink", value: "#FF6699", className: "pink" },
  { name: "Blue", value: "#5599FF", className: "blue" },
  { name: "Violet", value: "#A78BFA", className: "violet" },
  { name: "Amber", value: "#F6BA4C", className: "amber" },
  { name: "Danger", value: "#F26B83", className: "danger" },
];

function PlaygroundSection({
  id,
  eyebrow,
  title,
  description,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="playground-section" id={id}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
        </div>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span>C</span>
      <Sparkles size={10} />
    </span>
  );
}

function SkeletonCard() {
  return (
    <div className="skeleton-card" aria-label="内容加载中">
      <div className="skeleton skeleton--square" />
      <div className="skeleton-card__body">
        <div className="skeleton skeleton--line-lg" />
        <div className="skeleton skeleton--line-md" />
        <div className="skeleton skeleton--line-sm" />
      </div>
    </div>
  );
}

export function DesignSystemPlayground() {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [activeSection, setActiveSection] = useState("theme");
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  );
  const [activeTab, setActiveTab] = useState("candidate");
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialogOpen || !dialog) return;
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();
    return () => {
      dialog.close();
      trigger?.focus();
    };
  }, [dialogOpen]);
  const [toastVisible, setToastVisible] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([
    "post-a",
  ]);

  function goToSection(id: string) {
    setActiveSection(id);
    setMobileNavOpen(false);
    document.getElementById(id)?.scrollIntoView({
      behavior:
        reduceMotion ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
    });
  }

  function toggleCandidate(id: string) {
    setSelectedCandidates((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }

  function showToast() {
    setToastVisible(true);
    window.setTimeout(() => setToastVisible(false), 2600);
  }

  return (
    <div
      className="playground-shell"
      data-density={density}
      data-motion={reduceMotion ? "reduced" : "standard"}
    >
      <aside className={`playground-sidebar ${mobileNavOpen ? "is-open" : ""}`}>
        <div className="sidebar-brand">
          <BrandMark />
          <div>
            <strong>Comiku</strong>
            <span>UI Lab</span>
          </div>
          <IconButton
            className="sidebar-close"
            label="关闭导航"
            onClick={() => setMobileNavOpen(false)}
          >
            <X size={18} />
          </IconButton>
        </div>

        <div className="sidebar-meta">
          <Badge tone="brand" dot>
            Design v1.1 · 预览
          </Badge>
          <p>面向汉化协作流程的设计系统试验场。</p>
        </div>

        <nav className="sidebar-nav" aria-label="Playground 章节">
          <span className="sidebar-nav__label">PLAYGROUND</span>
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={activeSection === id ? "is-active" : ""}
              aria-current={activeSection === id ? "location" : undefined}
              onClick={() => goToSection(id)}
            >
              <Icon size={17} />
              <span>{label}</span>
              {activeSection === id && <ChevronRight size={15} />}
            </button>
          ))}
        </nav>

        <div className="sidebar-principle">
          <Shapes size={18} />
          <div>
            <strong>Token first</strong>
            <span>共享语义变量统一组件外观。</span>
          </div>
        </div>

        <div className="sidebar-profile">
          <span className="avatar avatar--mint">星</span>
          <div>
            <strong>星野</strong>
            <span>设计预览账号</span>
          </div>
          <MoreHorizontal size={18} />
        </div>
      </aside>

      {mobileNavOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <main className="playground-main">
        <header className="mobile-topbar">
          <button
            className="mobile-brand"
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu size={19} />
            <BrandMark />
            <strong>Comiku UI Lab</strong>
          </button>
          <Badge tone="brand">1.1 预览</Badge>
        </header>

        <div className="playground-content">
          <ThemePreview />
          <section className="hero">
            <div className="hero__copy">
              <Badge tone="brand" dot>
                DESIGN SYSTEM PLAYGROUND
              </Badge>
              <h1>
                一起创作，
                <span>轻快一点。</span>
              </h1>
              <p>
                从明亮柔彩到克制黑白，还有指尖下恰好的回应。
                从颜色到交互，一起打磨属于 Comiku 的协作界面。
              </p>
              <div className="hero__actions">
                <Button
                  size="lg"
                  leadingIcon={<Palette size={18} />}
                  onClick={() => goToSection("interaction")}
                >
                  体验交互手感
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  leadingIcon={<BookOpen size={18} />}
                  onClick={() => goToSection("foundation")}
                >
                  浏览新色板
                </Button>
              </div>
            </div>

            <div className="hero__visual" aria-hidden="true">
              <div className="hero-orbit hero-orbit--one" />
              <div className="hero-orbit hero-orbit--two" />
              <div className="hero-card hero-card--status">
                <span className="hero-card__icon hero-card__icon--mint">
                  <CheckCircle2 size={20} />
                </span>
                <div>
                  <small>今日进度</small>
                  <strong>8 个作品已完成</strong>
                </div>
              </div>
              <div className="hero-card hero-card--people">
                <div className="avatar-stack">
                  <span className="avatar avatar--pink">M</span>
                  <span className="avatar avatar--blue">海</span>
                  <span className="avatar avatar--violet">K</span>
                </div>
                <div>
                  <small>正在协作</small>
                  <strong>12 位成员在线</strong>
                </div>
              </div>
              <div className="hero-work-card">
                <span className="hero-work-card__cover">
                  <span />
                  <span />
                </span>
                <div className="hero-work-card__content">
                  <Badge tone="warning">校对中</Badge>
                  <strong>放学后的秘密计划</strong>
                  <span>4 pages · 12 条翻译</span>
                  <div className="hero-work-card__progress">
                    <span style={{ width: "68%" }} />
                  </div>
                </div>
              </div>
              <span className="hero-spark hero-spark--one">✦</span>
              <span className="hero-spark hero-spark--two">✧</span>
            </div>
          </section>

          <div className="playground-toolbar">
            {selectedCandidates.length ? (
              <div className="playground-toolbar__selection">
                <strong>已选择 {selectedCandidates.length} 项</strong>
                <span>候选批量入库</span>
                <Button size="sm" onClick={showToast}>
                  确认入库
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedCandidates([])}
                >
                  清除选择
                </Button>
              </div>
            ) : (
              <div>
                <span>预览密度</span>
                <div className="segmented" role="group" aria-label="界面密度">
                  <button
                    className={density === "comfortable" ? "is-active" : ""}
                    onClick={() => setDensity("comfortable")}
                  >
                    舒适
                  </button>
                  <button
                    className={density === "compact" ? "is-active" : ""}
                    onClick={() => setDensity("compact")}
                  >
                    紧凑
                  </button>
                </div>
              </div>
            )}
            <button
              type="button"
              className="motion-toggle"
              aria-pressed={reduceMotion}
              onClick={() => setReduceMotion(!reduceMotion)}
            >
              <Sparkles size={15} />
              {reduceMotion ? "减少动态：已开启" : "减少动态：未开启"}
            </button>
            <p>v1.1 待确认 · 业务数据为演示</p>
          </div>

          <PlaygroundSection
            id="foundation"
            eyebrow="01 · FOUNDATION"
            title="设计基础"
            description="品牌色随主题派生，状态色独立保留；白色内容面与深色文字保持清晰层级。"
          >
            <div className="foundation-grid">
              <Surface className="token-panel token-panel--colors">
                <div className="panel-heading">
                  <div>
                    <Palette size={18} />
                    <h3>语义色彩</h3>
                  </div>
                  <span>图形用亮色 · 文字用深色</span>
                </div>
                <div className="color-grid">
                  {colorTokens.map((token) => (
                    <div className="color-token" key={token.name}>
                      <span
                        className={`color-token__swatch color-token__swatch--${token.className}`}
                      />
                      <strong>{token.name}</strong>
                      <code>{token.value}</code>
                    </div>
                  ))}
                </div>
              </Surface>

              <Surface className="token-panel">
                <div className="panel-heading">
                  <div>
                    <Type size={18} />
                    <h3>字体层级</h3>
                  </div>
                  <span>System sans</span>
                </div>
                <div className="type-scale">
                  <div className="type-scale__display">
                    <span>Display / 56</span>
                    <strong>协作，也可以很轻松。</strong>
                  </div>
                  <div className="type-scale__title">
                    <span>Title / 24</span>
                    <strong>待处理的翻译任务</strong>
                  </div>
                  <div className="type-scale__body">
                    <span>Body / 15</span>
                    <p>通过稳定层级区分标题、业务数据和辅助说明。</p>
                  </div>
                </div>
              </Surface>

              <Surface className="token-panel token-panel--shape">
                <div className="panel-heading">
                  <div>
                    <Shapes size={18} />
                    <h3>形状与层级</h3>
                  </div>
                  <span>4px grid</span>
                </div>
                <div className="shape-row">
                  <div className="shape-demo shape-demo--sm">10</div>
                  <div className="shape-demo shape-demo--md">14</div>
                  <div className="shape-demo shape-demo--lg">18</div>
                  <div className="shape-demo shape-demo--xl">24</div>
                  <div className="shape-demo shape-demo--pill">Pill</div>
                </div>
                <div className="elevation-row">
                  <span className="elevation elevation--flat">Flat</span>
                  <span className="elevation elevation--raised">Raised</span>
                  <span className="elevation elevation--floating">
                    Floating
                  </span>
                </div>
              </Surface>
            </div>
          </PlaygroundSection>

          <PlaygroundSection
            id="interaction"
            eyebrow="02 · FEEL THE DIFFERENCE"
            title="交互手感"
            description="把鼠标移上去、按一下，或用 Tab 走一遍。明亮与灵动，也需要看得清、用得稳。"
          >
            <InteractionLab />
          </PlaygroundSection>

          <PlaygroundSection
            id="components"
            eyebrow="03 · COMPONENTS"
            title="基础组件"
            description="组件保留足够圆润度与呼吸感，但尺寸和状态遵循工作型应用的效率要求。"
          >
            <div className="component-grid">
              <Surface className="component-panel component-panel--wide">
                <div className="panel-heading">
                  <div>
                    <Component size={18} />
                    <h3>操作按钮</h3>
                  </div>
                  <span>Pill · 600 · 3 sizes</span>
                </div>
                <div className="button-showcase">
                  <Button leadingIcon={<Plus size={17} />}>新增作品</Button>
                  <Button variant="secondary">保存草稿</Button>
                  <Button variant="ghost">取消</Button>
                  <Button variant="danger">舍弃候选</Button>
                  <Button loading>处理中</Button>
                  <Button disabled>不可用</Button>
                </div>
                <div className="button-showcase button-showcase--sizes">
                  <Button size="sm">小按钮</Button>
                  <Button size="md">标准按钮</Button>
                  <Button size="lg">重要操作</Button>
                  <IconButton label="搜索">
                    <Search size={17} />
                  </IconButton>
                  <IconButton label="设置">
                    <Settings2 size={17} />
                  </IconButton>
                </div>
              </Surface>

              <Surface className="component-panel">
                <div className="panel-heading">
                  <div>
                    <Code2 size={18} />
                    <h3>输入与选择</h3>
                  </div>
                  <span>Focus / Error / Hint</span>
                </div>
                <div className="field-grid">
                  <SearchField
                    label="搜索作品"
                    placeholder="标题、作者或成员"
                  />
                  <SelectField
                    label="工作状态"
                    defaultValue="proofreading"
                    hint="自定义弹层统一圆角、分组、选中、悬停与键盘焦点"
                  >
                    <option value="all">全部状态</option>
                    <optgroup label="进行中">
                      <option value="translation">翻译中</option>
                      <option value="proofreading">校对中</option>
                      <option value="typesetting">嵌字中</option>
                    </optgroup>
                    <option value="published">已发布</option>
                    <option value="archived" disabled>
                      已归档（不可选）
                    </option>
                  </SelectField>
                  <TextField
                    label="署名"
                    defaultValue="星野"
                    hint="仅对当前作品生效"
                  />
                  <SelectField
                    label="不可用选择"
                    defaultValue="locked"
                    disabled
                  >
                    <option value="locked">等待上游完成</option>
                  </SelectField>
                  <TextField
                    label="临时昵称"
                    error="昵称与现有成员重复"
                    defaultValue="Miku"
                  />
                </div>
              </Surface>

              <Surface className="component-panel">
                <div className="panel-heading">
                  <div>
                    <Shapes size={18} />
                    <h3>标签与切换</h3>
                  </div>
                  <span>Semantic status</span>
                </div>
                <div className="badge-showcase">
                  <Badge dot>未开始</Badge>
                  <Badge tone="translation" dot>
                    翻译中
                  </Badge>
                  <Badge tone="warning" dot>
                    待校对
                  </Badge>
                  <Badge tone="violet" dot>
                    嵌字中
                  </Badge>
                  <Badge tone="success" dot>
                    已完成
                  </Badge>
                  <Badge tone="info" dot>
                    待审核
                  </Badge>
                  <Badge tone="danger" dot>
                    需修改
                  </Badge>
                </div>
                <div className="tabs" role="tablist" aria-label="作品列表分类">
                  {[
                    ["candidate", "候选", 12],
                    ["working", "进行中", 7],
                    ["done", "已完成", 28],
                  ].map(([id, label, count]) => (
                    <button
                      key={id}
                      role="tab"
                      id={`preview-tab-${id}`}
                      aria-controls="preview-tab-panel"
                      tabIndex={activeTab === id ? 0 : -1}
                      aria-selected={activeTab === id}
                      className={activeTab === id ? "is-active" : ""}
                      onClick={() => setActiveTab(String(id))}
                      onKeyDown={(event) => {
                        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
                        if (!keys.includes(event.key)) return;
                        event.preventDefault();
                        const tabs = Array.from(
                          event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                            '[role="tab"]',
                          ),
                        );
                        const index = tabs.indexOf(event.currentTarget);
                        const next =
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? tabs.length - 1
                              : (index +
                                  (event.key === "ArrowRight" ? 1 : -1) +
                                  tabs.length) %
                                tabs.length;
                        tabs[next].focus();
                        tabs[next].click();
                      }}
                    >
                      {label}
                      <span>{count}</span>
                    </button>
                  ))}
                </div>
                <p
                  className="preview-tab-panel"
                  role="tabpanel"
                  id="preview-tab-panel"
                  aria-labelledby={`preview-tab-${activeTab}`}
                  tabIndex={0}
                >
                  {activeTab === "candidate"
                    ? "候选预览：12 组示例内容等待筛选。"
                    : activeTab === "working"
                      ? "进行中预览：7 个示例作品正在协作。"
                      : "已完成预览：28 个示例作品完成展示。"}
                </p>
                <div className="inline-actions">
                  <Button
                    variant="secondary"
                    onClick={() => setDialogOpen(true)}
                  >
                    打开确认对话框
                  </Button>
                  <Button variant="ghost" onClick={showToast}>
                    显示轻提示
                  </Button>
                </div>
              </Surface>
            </div>
          </PlaygroundSection>

          <PlaygroundSection
            id="patterns"
            eyebrow="04 · WORKFLOW PATTERNS"
            title="业务模式"
            description="在真实数据密度中检验设计语言：卡片负责快速扫描，明确的状态、署名和下一动作始终可见。"
          >
            <Surface className="pattern-block">
              <h3>成员头像</h3>
              <div className="playground-row">
                <Avatar name="未来" size="sm" />
                <Avatar name="未来" />
                <Avatar name="未来" size="lg" />
              </div>
              <p>私有头像读取失败时显示昵称首字，不替代作品署名。</p>
              <WorkViewsDemo />
              <ImageLightboxDemo />
              <h3>作者平台主页</h3>
              <p>
                已关联账号可直接打开，未关联显示禁用；每个平台只关联一个账号，图标直接跳转。
              </p>
              <PlatformLinks
                accounts={[
                  { platform: "x", handle: "comiku_demo", externalUserId: "1" },
                  { platform: "pixiv", handle: null, externalUserId: "123456" },
                ]}
              />
              <PlatformLinks accounts={[]} />
              <PlatformLinks
                accounts={[
                  { platform: "x", handle: "comiku_one", externalUserId: "2" },
                ]}
              />
              <h3>平台身份表单</h3>
              <div className="playground-row">
                <TextField
                  label="X @账号"
                  placeholder="@comiku_demo"
                  hint="同步资料后获取稳定用户 ID，不把 @名称当作 ID。"
                />
                <TextField
                  label="Pixiv 用户 ID"
                  placeholder="123456"
                  hint="主页 /users/123456 中的数字，不是登录账号名。"
                  inputMode="numeric"
                />
              </div>
            </Surface>
            <div className="pattern-block">
              <div className="subsection-heading">
                <div>
                  <Inbox size={19} />
                  <h3>个人待办与推荐接取</h3>
                </div>
                <span>可立即开始优先 · 提前认领在后</span>
              </div>
              <div className="work-grid">
                <Surface as="article" className="work-card">
                  <div className="work-card__cover work-card__cover--mint">
                    <FileImage size={22} />
                  </div>
                  <div className="work-card__body">
                    <Badge tone="translation">我的待办 · 翻译</Badge>
                    <h4>和猫咪度过的星期日</h4>
                    <p>#1 · 4 页 · 多人协作</p>
                    <div className="workspace-personal-actions">
                      <Button size="sm" variant="secondary" onClick={showToast}>
                        进入翻译工作区
                      </Button>
                      <small>分工已完成，待阶段提交</small>
                    </div>
                  </div>
                </Surface>
                <Surface as="article" className="work-card">
                  <div className="work-card__cover work-card__cover--amber">
                    <MessageCircleMore size={22} />
                  </div>
                  <div className="work-card__body">
                    <Badge tone="warning">推荐接取 · 可立即开始</Badge>
                    <h4>秘密基地作战会议</h4>
                    <p>#2 · 2 页 · 翻译已提交</p>
                    <div className="workspace-personal-actions">
                      <Button size="sm" variant="secondary" onClick={showToast}>
                        接取校对
                      </Button>
                      <Button size="sm" variant="secondary" onClick={showToast}>
                        接取嵌字 · 上游未完成
                      </Button>
                    </div>
                  </div>
                </Surface>
                <Surface as="article" className="work-card">
                  <div className="work-card__cover work-card__cover--violet">
                    <Archive size={22} />
                  </div>
                  <div className="work-card__body">
                    <Badge tone="neutral">推荐接取 · 提前认领</Badge>
                    <h4>雨天与透明伞</h4>
                    <p>#3 · 6 页 · 上游未完成</p>
                    <div className="workspace-personal-actions">
                      <Button size="sm" variant="secondary" onClick={showToast}>
                        接取嵌字 · 上游未完成
                      </Button>
                    </div>
                  </div>
                </Surface>
              </div>
            </div>
            <Surface className="pattern-block">
              <h3>嵌字交接队列</h3>
              <p>取得交接包会开始嵌字；请允许浏览器多文件下载。</p>
              <div className="workspace-batch-item">
                <strong>#1 · 4 张</strong>
                <Badge tone="success">已交付浏览器下载</Badge>
                <Button size="sm" variant="ghost" onClick={showToast}>
                  重新预览此项
                </Button>
              </div>
              <div className="workspace-batch-item">
                <strong>#2 · 2 张</strong>
                <Badge tone="warning">清单已过期</Badge>
                <Button size="sm" variant="secondary" onClick={showToast}>
                  重新预览确认
                </Button>
              </div>
            </Surface>
            <Surface className="pattern-block">
              <h3>成图匹配与确认</h3>
              <p>#139 · 3 张 · 两份 ZIP 合并为一个新版本</p>
              <p className="account-error">
                同页原图与成图不能重复选入，请先移除重复项。
              </p>
              <div className="workspace-upload-checks">
                <label>
                  <input type="checkbox" defaultChecked />
                  明确合并为一个版本
                </label>
                <label>
                  <input type="checkbox" />
                  已预览核对所选图片为成图
                </label>
              </div>
              <div className="workspace-batch-item">
                <Badge tone="success">已上传并提交嵌字 · 待发布</Badge>
                <Button size="sm" variant="secondary" onClick={showToast}>
                  检查提交条件
                </Button>
                <Button size="sm" onClick={showToast}>
                  确认上传并提交嵌字
                </Button>
              </div>
            </Surface>
            <div className="pattern-block">
              <div className="subsection-heading">
                <div>
                  <Inbox size={19} />
                  <h3>候选内容批量入库</h3>
                </div>
                <div className="subsection-actions">
                  <span>选择后在顶部工具栏处理</span>
                </div>
              </div>
              <div className="candidate-grid">
                <button
                  className={`candidate-card ${selectedCandidates.includes("post-a") ? "is-selected" : ""}`}
                  aria-pressed={selectedCandidates.includes("post-a")}
                  onClick={() => toggleCandidate("post-a")}
                >
                  <span className="candidate-card__check">
                    {selectedCandidates.includes("post-a") && (
                      <Check size={14} />
                    )}
                  </span>
                  <div className="candidate-card__art candidate-card__art--pink">
                    <span className="abstract-face" />
                    <span className="abstract-spark">✦</span>
                    <Badge tone="neutral">2 图</Badge>
                  </div>
                  <div className="candidate-card__body">
                    <div className="candidate-card__author">
                      <span className="avatar avatar--pink">も</span>
                      <div>
                        <strong>mori_works</strong>
                        <span>@mori_works · 18 分钟前</span>
                      </div>
                    </div>
                    <p>放学后的小故事。今天也辛苦了！</p>
                    <div className="candidate-card__meta">
                      <Badge tone="brand">原创 Post</Badge>
                      <span>1280 × 1920</span>
                    </div>
                  </div>
                </button>

                <button
                  className={`candidate-card ${selectedCandidates.includes("post-b") ? "is-selected" : ""}`}
                  aria-pressed={selectedCandidates.includes("post-b")}
                  onClick={() => toggleCandidate("post-b")}
                >
                  <span className="candidate-card__check">
                    {selectedCandidates.includes("post-b") && (
                      <Check size={14} />
                    )}
                  </span>
                  <div className="candidate-card__art candidate-card__art--blue">
                    <span className="abstract-window" />
                    <span className="abstract-moon">◐</span>
                    <Badge tone="neutral">4 图</Badge>
                  </div>
                  <div className="candidate-card__body">
                    <div className="candidate-card__author">
                      <span className="avatar avatar--blue">青</span>
                      <div>
                        <strong>aoi_note</strong>
                        <span>@aoi_note · 2 小时前</span>
                      </div>
                    </div>
                    <p>新刊里的四格漫画，完整版请见图片。</p>
                    <div className="candidate-card__meta">
                      <Badge tone="info">回复含图</Badge>
                      <span>2048 × 2048</span>
                    </div>
                  </div>
                </button>

                <button
                  className={`candidate-card ${selectedCandidates.includes("post-c") ? "is-selected" : ""}`}
                  aria-pressed={selectedCandidates.includes("post-c")}
                  onClick={() => toggleCandidate("post-c")}
                >
                  <span className="candidate-card__check">
                    {selectedCandidates.includes("post-c") && (
                      <Check size={14} />
                    )}
                  </span>
                  <div className="candidate-card__art candidate-card__art--violet">
                    <span className="abstract-rings" />
                    <span className="abstract-star">☆</span>
                    <Badge tone="neutral">1 图</Badge>
                  </div>
                  <div className="candidate-card__body">
                    <div className="candidate-card__author">
                      <span className="avatar avatar--violet">K</span>
                      <div>
                        <strong>kotoha_art</strong>
                        <span>@kotoha_art · 昨天</span>
                      </div>
                    </div>
                    <p>新的角色设定公开，引用中的附图也请一起看。</p>
                    <div className="candidate-card__meta">
                      <Badge tone="violet">引用含图</Badge>
                      <span>1600 × 1200</span>
                    </div>
                  </div>
                </button>
              </div>
            </div>

            <div className="pattern-block">
              <div className="subsection-heading">
                <div>
                  <GalleryVerticalEnd size={19} />
                  <h3>作品进度总览</h3>
                </div>
                <Button variant="ghost" size="sm">
                  查看全部 <ArrowRight size={15} />
                </Button>
              </div>
              <div className="work-grid">
                <Surface as="article" className="work-card">
                  <div className="work-card__cover work-card__cover--mint">
                    <span>01</span>
                    <FileImage size={22} />
                  </div>
                  <div className="work-card__body">
                    <div className="work-card__topline">
                      <Badge tone="translation" dot>
                        翻译中
                      </Badge>
                      <IconButton label="更多操作" size="sm">
                        <MoreHorizontal size={15} />
                      </IconButton>
                    </div>
                    <h4>和猫咪度过的星期日</h4>
                    <p>作者：mori_works · 4 页</p>
                    <div className="progress-meta">
                      <span>翻译进度</span>
                      <strong>9 / 14</strong>
                    </div>
                    <div className="progress-track">
                      <span style={{ width: "64%" }} />
                    </div>
                    <div className="work-card__people">
                      <div className="avatar-stack">
                        <span className="avatar avatar--mint">星</span>
                        <span className="avatar avatar--blue">海</span>
                      </div>
                      <span>星野、海盐正在协作</span>
                    </div>
                  </div>
                </Surface>

                <Surface as="article" className="work-card">
                  <div className="work-card__cover work-card__cover--amber">
                    <span>02</span>
                    <MessageCircleMore size={22} />
                  </div>
                  <div className="work-card__body">
                    <div className="work-card__topline">
                      <Badge tone="warning" dot>
                        待校对
                      </Badge>
                      <IconButton label="更多操作" size="sm">
                        <MoreHorizontal size={15} />
                      </IconButton>
                    </div>
                    <h4>秘密基地作战会议</h4>
                    <p>作者：aoi_note · 2 页</p>
                    <div className="work-card__callout">
                      <Clock3 size={15} />
                      <span>翻译已于 14:32 提交</span>
                    </div>
                    <div className="work-card__people">
                      <div className="avatar-stack">
                        <span className="avatar avatar--pink">M</span>
                      </div>
                      <span>Mikan 完成了翻译</span>
                    </div>
                  </div>
                </Surface>

                <Surface as="article" className="work-card">
                  <div className="work-card__cover work-card__cover--violet">
                    <span>03</span>
                    <Archive size={22} />
                  </div>
                  <div className="work-card__body">
                    <div className="work-card__topline">
                      <Badge tone="violet" dot>
                        嵌字中
                      </Badge>
                      <IconButton label="更多操作" size="sm">
                        <MoreHorizontal size={15} />
                      </IconButton>
                    </div>
                    <h4>雨天与透明伞</h4>
                    <p>作者：kotoha_art · 6 页</p>
                    <div className="work-card__versions">
                      <span>
                        <FileImage size={14} /> 成图 v2
                      </span>
                      <span>
                        <Users size={14} /> 3 位工作人员
                      </span>
                    </div>
                    <div className="work-card__people">
                      <div className="avatar-stack">
                        <span className="avatar avatar--violet">K</span>
                        <span className="avatar avatar--mint">纸</span>
                      </div>
                      <span>Kumo 2 分钟前上传</span>
                    </div>
                  </div>
                </Surface>
              </div>
            </div>
          </PlaygroundSection>

          <PlaygroundSection
            id="workspace"
            eyebrow="05 · TRANSLATION WORKSPACE"
            title="翻译标记工作台"
            description="画面与译文列表共享选中状态；标号由稳定顺序派生。可体验框内/框外标点、移动标点、移动画布、Alt＋滚轮缩放、连续标点 Ctrl＋Z、删除和录入；默认移动画布，自动保存仅模拟反馈。"
          >
            <Surface className="workspace-shell">
              <div className="workspace-intro">
                <div>
                  <Badge tone="brand">可交互原型</Badge>
                  <h3>自动标号与轻量编辑</h3>
                </div>
                <p>
                  先选择工具，再在画面中添加或移动标点、平移画布；也可以编辑右侧当前译文。
                </p>
              </div>
              <MarkerDemo />
            </Surface>
          </PlaygroundSection>

          <PlaygroundSection
            id="states"
            eyebrow="06 · SYSTEM FEEDBACK"
            title="反馈与空状态"
            description="反馈信息说明发生了什么以及下一步可以做什么；不依赖颜色作为唯一判断依据。"
          >
            <ReviewModeDemo />
            <div className="state-grid">
              <Surface className="state-card">
                <div className="panel-heading">
                  <div>
                    <Inbox size={18} />
                    <h3>空状态</h3>
                  </div>
                </div>
                <EmptyState
                  icon={<GalleryVerticalEnd size={25} />}
                  title="这里还没有候选内容"
                  description="添加已授权作者后，系统会定时检查带图片的新内容。"
                  action={
                    <Button size="sm" variant="secondary">
                      添加作者
                    </Button>
                  }
                />
              </Surface>

              <Surface className="state-card">
                <div className="panel-heading">
                  <div>
                    <RefreshCw size={18} />
                    <h3>加载状态</h3>
                  </div>
                </div>
                <div className="skeleton-stack">
                  <SkeletonCard />
                  <SkeletonCard />
                  <SkeletonCard />
                </div>
              </Surface>

              <Surface className="state-card">
                <div className="panel-heading">
                  <div>
                    <AlertCircle size={18} />
                    <h3>异常与恢复</h3>
                  </div>
                </div>
                <div className="feedback-stack">
                  <OptionalSection label="作品正文（可选）">
                    <label className="ui-field">
                      <span className="ui-field__label">作品正文</span>
                      <div className="ui-field__control">
                        <textarea placeholder="不填写时，标题下一行直接显示作者" />
                      </div>
                    </label>
                  </OptionalSection>
                  <OptionalSection label="查看备注" hasContent defaultOpen>
                    <label className="ui-field">
                      <span className="ui-field__label">备注</span>
                      <div className="ui-field__control">
                        <textarea defaultValue="已有备注默认展开，仍可手动收起。" />
                      </div>
                    </label>
                  </OptionalSection>
                  <div className="feedback feedback--success">
                    <CheckCircle2 size={19} />
                    <div>
                      <strong>更改已保存</strong>
                      <span>云端版本更新于刚刚</span>
                    </div>
                  </div>
                  <div className="feedback feedback--warning">
                    <CloudOff size={19} />
                    <div>
                      <strong>当前处于离线状态</strong>
                      <span>内容已安全保存在本地，联网后自动同步。</span>
                    </div>
                  </div>
                  <div className="feedback feedback--danger">
                    <AlertCircle size={19} />
                    <div>
                      <strong>成图上传失败</strong>
                      <span>网络连接已中断，请检查后重试。</span>
                    </div>
                    <Button size="sm" variant="danger">
                      重试
                    </Button>
                  </div>
                </div>
              </Surface>
            </div>
          </PlaygroundSection>

          <footer className="playground-footer">
            <div>
              <BrandMark />
              <strong>Comiku Design System</strong>
            </div>
            <p>UI v1.1 · 视觉修订预览 · 等你体验确认</p>
          </footer>
        </div>
      </main>

      {dialogOpen && (
        <dialog
          ref={dialogRef}
          className="dialog"
          aria-labelledby="dialog-title"
          onCancel={() => setDialogOpen(false)}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            );
            const first = buttons[0];
            const last = buttons.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}
        >
          <div className="dialog__icon">
            <Users size={23} />
          </div>
          <div className="dialog__copy">
            <Badge tone="info">多人协作提示</Badge>
            <h3 id="dialog-title">海盐正在编辑这个作品</h3>
            <p>
              你可以只查看最新内容，或加入协作。加入后双方会看到彼此的保存状态和当前页面。
            </p>
          </div>
          <div className="dialog__people">
            <span className="avatar avatar--blue">海</span>
            <div>
              <strong>海盐</strong>
              <span>正在编辑第 2 页 · 1 分钟前</span>
            </div>
          </div>
          <div className="dialog__actions">
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              仅查看
            </Button>
            <Button onClick={() => setDialogOpen(false)}>加入协作</Button>
          </div>
        </dialog>
      )}

      <div
        className={`toast ${toastVisible ? "is-visible" : ""}`}
        role="status"
        aria-live="polite"
        aria-hidden={!toastVisible}
        inert={!toastVisible}
      >
        <span>
          <Check size={16} />
        </span>
        <div>
          <strong>轻提示样例</strong>
          <small>此处仅演示反馈样式，没有写入剪贴板。</small>
        </div>
        <IconButton
          label="关闭提示"
          size="sm"
          onClick={() => setToastVisible(false)}
        >
          <X size={14} />
        </IconButton>
      </div>
    </div>
  );
}
