// 打包组装（工单 14）：为主进程与 preload 产物、ui 静态产物、playwright-core
// 组装一个自包含的 electron-builder projectDir（.dist-vendor）。
//
// 为什么组装独立目录而不是直接以 desktop 包为 projectDir：
// 1. 主进程是 esbuild 单文件（仅 external electron 与 playwright-core，见 scripts/build.mjs），
//    运行时不需要 node_modules 里的业务依赖；独立目录的 package.json 无 dependencies，
//    electron-builder 不会做任何依赖收集（pnpm workspace 的 workspace:* 收集不可控且拖入冗余体积）。
// 2. extraResources 的 from 相对 projectDir，全部落在 vendor 目录内可读可控。
//
// 运行：pnpm --filter @codexlike/desktop run dist（先全仓 pnpm build，再 predist 组装 + electron-builder）
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const VENDOR_DIR = resolve(PKG_DIR, '.dist-vendor');

/** 入参必须是存在的路径，否则中文报错退出（提示先跑全仓构建） */
function requirePath(path, label) {
  if (!existsSync(path)) {
    console.error(`[dist] 缺少 ${label}：${path}`);
    console.error('[dist] 请先在仓库根目录执行 pnpm build（agent-core/desktop/ui 三包构建）');
    process.exit(1);
  }
}

// 1) 构建产物就绪检查
const mainCjs = resolve(PKG_DIR, 'dist', 'main.cjs');
const preloadCjs = resolve(PKG_DIR, 'dist', 'preload.cjs');
const uiDist = resolve(PKG_DIR, '..', 'ui', 'dist', 'index.html');
const playwrightCore = resolve(PKG_DIR, 'node_modules', 'playwright-core');
const iconIco = resolve(PKG_DIR, 'build', 'icon.ico');
for (const [path, label] of [
  [mainCjs, '主进程产物 dist/main.cjs'],
  [preloadCjs, 'preload 产物 dist/preload.cjs'],
  [uiDist, 'ui 产物 ../ui/dist/index.html'],
  [playwrightCore, 'playwright-core（工单 11 external 化的运行时依赖）'],
  [iconIco, '应用图标 build/icon.ico（可用 pnpm run icon 重新生成）'],
]) {
  requirePath(path, label);
}

// 2) 清空并组装 vendor 目录
rmSync(VENDOR_DIR, { recursive: true, force: true });
mkdirSync(resolve(VENDOR_DIR, 'app-dist'), { recursive: true });
cpSync(mainCjs, resolve(VENDOR_DIR, 'app-dist', 'main.cjs'));
cpSync(preloadCjs, resolve(VENDOR_DIR, 'app-dist', 'preload.cjs'));
// ui 静态产物 → resources/ui-dist（main.ts 以 app.isPackaged 分支加载；
// Monaco worker 等以 file:// 直读，放 asar 外避免任何边角问题）
cpSync(resolve(PKG_DIR, '..', 'ui', 'dist'), resolve(VENDOR_DIR, 'ui-dist'), {
  recursive: true,
});
// playwright-core → resources/node_modules/playwright-core：
// Node 模块解析从 app.asar/dist 逐级向上，出 asar 后命中 resources/node_modules；
// 实体拷贝（dereference pnpm 的 symlink），chromium 安装器 spawn cli.js 也要求真实文件
cpSync(playwrightCore, resolve(VENDOR_DIR, 'node_modules', 'playwright-core'), {
  recursive: true,
  dereference: true,
});
cpSync(iconIco, resolve(VENDOR_DIR, 'build', 'icon.ico'));

// 3) 独立 package.json：无 dependencies（依赖已全部 bundle），electron-builder 零收集
const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, 'package.json'), 'utf8'));
writeFileSync(
  resolve(VENDOR_DIR, 'package.json'),
  JSON.stringify(
    {
      name: 'codexlike-app',
      version: pkg.version,
      description: pkg.description,
      author: 'CodexLike',
      main: './app-dist/main.cjs',
      private: true,
    },
    null,
    2,
  ),
);

// 4) electron-builder 配置（源模板随仓库版本化，注入实际 electron 版本后拷入 projectDir）
const electronVersion = JSON.parse(
  readFileSync(resolve(PKG_DIR, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;
const template = readFileSync(resolve(PKG_DIR, 'scripts', 'electron-builder.template.yml'), 'utf8');
writeFileSync(
  resolve(VENDOR_DIR, 'electron-builder.yml'),
  template.replaceAll('__ELECTRON_VERSION__', electronVersion),
);

console.log('[dist] vendor 组装完成：.dist-vendor（app-dist / ui-dist / node_modules/playwright-core）');
