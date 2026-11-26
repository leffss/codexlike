/**
 * 【原型设施，throwaway——prototype/card-shell 分支】整页卡片壳变体配置。
 *
 * 问题：把工作台改成「整页是一张大卡片，中间消息区 + 输入框是上面的一张卡，
 * 右栏弹出时是和中间并排的另一张卡」，有哪几种成立的结构？
 *
 * 四个变体（?variant=A|B|C|D 切换，无参数 = 现状 UI；浮动切换条见
 * components/PrototypeSwitcher.tsx）。差异是结构性的，不是换配色：
 * - A 桌面双卡（2026-11-26 修订）：无标题栏、无最底层大卡；左栏直接落在
 *   窗口桌面上（程序图标 + 品牌并入任务列表头），中列卡首行承载任务标题 +
 *   目录 + 打开目录/右栏/主题/设置，窗口按钮随右栏开合在消息卡首行与右栏
 *   首行之间移动。
 * - B 整窗三卡：标题栏收进大卡顶部；左栏 / 中列 / 右栏三张并排白卡。
 * - C 悬浮消息舱：大圆角中列卡 + 输入区独立悬浮托盘；右栏纵向内缩的浮卡。
 * - D 分格工作台：方角描边分格 + 中列卡内标题条 + 细缝分隔，无阴影。
 *
 * 类名被 Tailwind 扫描依赖字面量，这里的字符串都是静态字面量，勿动态拼接。
 *
 * 运行：`pnpm --filter @codexlike/ui dev`（纯浏览器 vite + dev/browser-stub
 * 样例数据），打开 http://127.0.0.1:5173/?variant=A （无参数 = 现状 UI）。
 * 本机 5173 落在 Windows 排除端口段（Hyper-V/WinNAT），可用 `--port 4300`。
 */

export type CardShellVariant = "A" | "B" | "C" | "D";

export interface CardShellVariantInfo {
  key: CardShellVariant;
  name: string;
}

export const CARD_SHELL_VARIANTS: CardShellVariantInfo[] = [
  { key: "A", name: "桌面双卡" },
  { key: "B", name: "整窗三卡" },
  { key: "C", name: "悬浮消息舱" },
  { key: "D", name: "分格工作台" },
];

export interface CardShellSpec {
  /**
   * 标题栏位置：outside = 大卡外（页面顶）；inside = 收进大卡内部；
   * none = 不渲染标题栏（A 修订版：品牌进任务列表头，任务标题/目录与
   * 操作/窗口按钮进消息卡首行与右栏首行）。
   */
  header: "outside" | "inside" | "none";
  /** AppShell 根：窗口底色 + 外边距（header none 时为整页桌面底色） */
  page: string;
  /** 整页大卡片（header none 时为空串：不渲染最底层卡片） */
  card: string;
  /** WorkspacePage 根（左栏 + 中列 + 右栏） */
  workspace: string;
  /** 左栏附着类（TaskSidebar.frameClassName）：透明 = 融进大卡，否则独立卡 */
  sidebar: string;
  /** 中列卡片（消息流 + 输入区 / 交互面板） */
  center: string;
  /** 中列卡内标题条（任务名 + 运行态），D 专属 */
  centerHeader: boolean;
  /** 输入区 / 交互面板外壳附加类（ComposerRegion.className） */
  composerRegion: string;
  /** 右栏外框类（RailPanel.frameClassName）：纵向内缩等 */
  railFrame: string;
  /** 右栏表面类（RailPanel.surfaceClassName）：圆角 / 描边 / 阴影 */
  railSurface: string;
}

/** 窗口桌面底色 + 外边距（大卡浮在窗口底上）：桌面用 fg 低透明叠加，
 * 浅色 = 浅暖灰、深色 = 比主底亮一档，大卡（canvas）在两种主题下都立得住 */
const PAGE = "flex h-full flex-col bg-fg/5 p-2.5";

/** 整页大卡片通用形：canvas 卡面 + fg 低透明描边（line 太淡，卡缘读不出） */
const BIG_CARD =
  "flex min-h-0 flex-1 flex-col overflow-hidden border border-fg/10 bg-canvas";

/** 中列卡通用形：白卡 + 滚动裁剪；输入区与正文同一张卡 */
const CENTER_CARD =
  "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-line bg-canvas";

/** 左栏融入大卡（覆盖 aside 自带的 bg-canvas；! 保证赢过同名工具类） */
const SIDEBAR_FLUSH = "bg-transparent!";

/** 输入区顶部发丝线（与正文分开，但仍是同一张卡内的隔断） */
const COMPOSER_SEAM = "border-t border-line";

const SPECS: Record<CardShellVariant, CardShellSpec> = {
  A: {
    // A 修订版（2026-11-26 用户定稿方向）：去掉最底层大卡片与标题栏——
    // 左栏直接落在窗口桌面上（品牌与图标并入任务列表头），中列卡首行承载
    // 任务标题 + 目录 + 打开目录/右栏/主题/设置/窗口按钮；右栏打开时窗口
    // 按钮移到右栏首行右侧。页根只留桌面底色与 8px 外边距。
    header: "none",
    // 外缘留白与卡片间距同档（4px）：卡片边框离窗口边只有一线桌面
    page: "flex h-full flex-col bg-fg/5 p-1",
    card: "",
    workspace: "flex h-full gap-2",
    sidebar: SIDEBAR_FLUSH,
    center: `${CENTER_CARD} rounded-xl shadow-floating`,
    centerHeader: false,
    // A 用户定稿（2026-11-26）：输入区与正文同卡、不加顶部分割线
    composerRegion: "",
    railFrame: "",
    railSurface: "rounded-xl border border-line shadow-floating",
  },
  B: {
    header: "inside",
    page: PAGE,
    card: `${BIG_CARD} rounded-2xl shadow-floating`,
    workspace: "flex h-full gap-2 p-2",
    // 三卡并排：左栏自己也是一张白卡（aside 自带 bg-canvas）
    sidebar: "rounded-xl border border-line shadow-floating",
    center: `${CENTER_CARD} rounded-xl shadow-floating`,
    centerHeader: false,
    composerRegion: COMPOSER_SEAM,
    railFrame: "",
    railSurface: "rounded-xl border border-line shadow-floating",
  },
  C: {
    header: "outside",
    page: PAGE,
    card: `${BIG_CARD} rounded-[20px] shadow-floating`,
    workspace: "flex h-full gap-2 p-2",
    sidebar: SIDEBAR_FLUSH,
    // 大圆角「消息舱」+ 更重的悬浮投影；输入区在舱内独立成托盘
    center: `${CENTER_CARD} rounded-[24px] shadow-popover`,
    centerHeader: false,
    composerRegion:
      "mx-3 mt-1 mb-3 rounded-2xl border border-line shadow-floating",
    // 右栏上下内缩：看起来是浮在大卡上的一张卡，而不是贴边的分栏
    railFrame: "py-2",
    railSurface: "rounded-2xl border border-line shadow-popover",
  },
  D: {
    header: "outside",
    page: PAGE,
    card: `${BIG_CARD} rounded-lg`,
    workspace: "flex h-full gap-1.5 p-2",
    // 分格语言：左栏保留一条右发丝线，无卡壳
    sidebar: "border-r border-line bg-transparent!",
    center: `${CENTER_CARD} rounded-lg`,
    centerHeader: true,
    composerRegion: COMPOSER_SEAM,
    railFrame: "",
    railSurface: "rounded-lg border border-line",
  },
};

/** ?variant= → 配置；空 / 未知值 = 现状布局（返回 null） */
export function cardShellSpec(
  variant: string | null | undefined
): CardShellSpec | null {
  if (variant === "A" || variant === "B" || variant === "C" || variant === "D")
    return SPECS[variant];
  return null;
}
