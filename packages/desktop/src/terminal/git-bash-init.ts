import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * git-bash 托管初始化文件（2026-11-22 首屏英文噪音修复）：rail 终端面板窄
 * （约 60 列），Git Bash 默认两行 PS1（`user@host MINGW64 全路径` + `$`，
 * /etc/profile.d/git-prompt.sh 无条件设置，env 覆盖不掉）路径一长就折成
 * 两三行——每个会话开头都是几行英文噪音。方案：会话以**非登录交互** spawn
 * 并 `--init-file` 指向本文件（--login 下 init-file 被 bash 忽略，实证），
 * 文件自补 PATH（与 /etc/profile 同序）、兜底 UTF-8 locale、保用户链
 * （~/.bash_profile / ~/.bashrc）、单行紧凑提示符。OSC 0 标题转义必须保留
 * 在 PS1 里——动态标题功能（terminal-title-changed）依赖每次提示符刷新
 * 标题。
 */

export const GIT_BASH_INIT_FILE_CONTENT = `# CodexLike 终端会话 git-bash 初始化（应用生成，勿手改——每次启动覆盖）
# 非 --login：自补 PATH（与 /etc/profile 同序），兜底 locale，保用户链，
# 单行提示符。
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export MSYSTEM=MINGW64
# locale 兜底（2026-11-22「有的项目终端文字叠印」根因轮）：登录态由
# /etc/profile.d/lang.sh 兜底（locale -uU 取 Windows 用户区域），非登录交互
# 没人设 LANG——资源管理器启动的应用没有 LANG，readline 按 C locale 逐字节
# 计宽（CJK 每字 3 字节 vs 终端渲染 2 列），长中文分支名提示符（__git_ps1）
# 宽度错算，命令结束后重绘提示符从错列开始，提示符残片与上一条命令输出
# 叠印成乱码块（分支名/cwd 含中文的项目必现，纯 ASCII 项目不触发）。仅在
# LC_ALL/LC_CTYPE/LANG 全未设置时兜底，用户显式选择不覆盖；C.UTF-8 只修
# 字符集语义，不换消息/排序语言。应用内因果实验：同 CJK 分支仓库仅翻转
# LANG，剥离腿整屏叠印、C.UTF-8 腿完全干净。
test -z "\${LC_ALL:-\${LC_CTYPE:-$LANG}}" && export LANG=C.UTF-8
if test -f ~/.bash_profile; then
	. ~/.bash_profile
elif test -f ~/.bashrc; then
	. ~/.bashrc
fi
# git 补全与 __git_ps1（登录态由 profile.d/git-prompt.sh 挂载，非登录需自挂）
if test -f /mingw64/share/git/completion/git-prompt.sh; then
	. /mingw64/share/git/completion/git-prompt.sh
fi
# 单行提示符：绿色路径末段 + 青色 git 分支 + $；标题转义喂动态标题（末段）
# 注意：PS1 里命令替换必须写裸 $()（\\$ 是「字面 $」），参数展开 \${...} 转义
# 只为绕开本 TS 模板插值，落盘后即正常形态
PS1='\\[\\033]0;\${PWD##*/}\\007\\]\\[\\033[32m\\]\${PWD##*/}\\[\\033[0m\\]\\[\\033[36m\\]$(__git_ps1 " (%s)" 2>/dev/null)\\[\\033[0m\\] $ '
`;

export interface GitBashInitFile {
  /** Windows 形态（落盘实际位置） */
  winPath: string;
  /** MSYS POSIX 形态（spawn 参数用；bash.exe 从 Windows 进程收到时按 MSYS 路径解析） */
  msysPath: string;
}

/**
 * 确保 git-bash 托管 init 文件存在且为当前内容（每次启动覆盖：内容随版本
 * 演进，不依赖旧文件），返回 Windows / MSYS 两种形态的路径。
 */
export function ensureGitBashInitFile(userDataDir: string): GitBashInitFile {
  const dir = join(userDataDir, "terminal");
  mkdirSync(dir, { recursive: true });
  const winPath = join(dir, "git-bash-init.sh");
  writeFileSync(winPath, GIT_BASH_INIT_FILE_CONTENT);
  return { winPath, msysPath: winToMsysPath(winPath) };
}

/**
 * Windows 路径 → MSYS POSIX 形态（`C:\a\b` → `/c/a/b`）。只转换应用自产
 * 路径（盘符开头 + 反斜杠的确定形态，user 主目录内 userData 下），不做
 * 通用路径转换。
 */
export function winToMsysPath(winPath: string): string {
  const drive = winPath[0]?.toLowerCase() ?? "c";
  return `/${drive}${winPath.slice(2).replaceAll("\\", "/")}`;
}
