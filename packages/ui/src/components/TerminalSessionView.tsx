import { useEffect, useRef } from "react";

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { terminalXtermTheme } from "../lib/terminal-theme";

/**
 * 终端交互区（xterm.js + fit addon，ADR 0033 票 04）：详情页主体的
 * 浏览器挂载组件——xterm 交互区是 canvas（真 TTY 保真），挂载后才动态
 * 加载 @xterm/xterm 实例化（模块顶层零 xterm 运行时依赖：SSR 只有容器
 * 壳，terminal-rail-ui 测试测到本容器边界为止；接线行为由 jsdom 用例
 * 换 fake Terminal/FitAddon 驱动，真件行为归 09 票 e2e 的可访问性/文本层）。
 *
 * 字节流纪律（spec 双通道）：`terminals:session-data` 专用通道的实时
 * 字节经 onSessionData 回调直写 term.write——绝不进 React 状态；输入走
 * term.onData → `terminals:write` 原样透传（回车 `\r` 由 xterm onData
 * 自然给出）；resize 用 fit addon 尺寸 → `terminals:resize`。渲染端时序：
 * 先注册 onSessionData 监听再 subscribe（订阅登记在主进程同步完成，登记
 * 后实时转发即开始——监听器晚于订阅会丢登记窗口的字节），subscribe 携
 * buffered 全量回放一次返回（01 票三合一口径），term 就绪前到达的实时
 * 字节先攒后冲（顺序：buffered → 攒冲，不丢不重）。
 *
 * 主题：语义 token（ADR 0006/0028）→ xterm palette 的换算收口在
 * lib/terminal-theme（一处收口），html data-theme 翻转时重读换算。
 */

/** 组件内部状态（挂载现场）：term 实例与退订集合不进 React state */
interface MountState {
  term: Terminal;
  fit: FitAddon;
  /** 实时字节直写的唯一入口（攒冲期先入队，就绪后直写） */
  writeBytes: (data: string) => void;
  dispose: () => void;
}

export default function TerminalSessionView(props: {
  sessionId: string;
  /** 已退出会话：只读回看（禁输入，subscribe 取 buffered 快照回放） */
  exited: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<MountState | null>(null);
  // 本挂载现场是否已就绪（term 实例化完成）：未就绪期间的实时字节入队
  const readyRef = useRef(false);
  /** 攒冲队列：term 就绪前的实时字节（buffered 回放之后按序冲写） */
  const pendingRef = useRef<string[]>([]);
  const exitedRef = useRef(props.exited);

  useEffect(() => {
    exitedRef.current = props.exited;
  }, [props.exited]);

  useEffect(() => {
    const sessionId = props.sessionId;
    const host = hostRef.current;
    if (host === null) return;
    let disposed = false;
    const detach: Array<() => void> = [];

    // 字节流接线（term 未就绪也照收：先攒后冲，不丢登记窗口的实时字节）
    detach.push(
      window.codexlike.terminals.onSessionData((payload) => {
        if (payload.sessionId !== sessionId) return;
        if (readyRef.current && mountRef.current !== null) {
          mountRef.current.writeBytes(payload.data);
          return;
        }
        pendingRef.current.push(payload.data);
      })
    );

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      window.codexlike.terminals.subscribe(sessionId),
    ])
      .then(([{ Terminal: XTerm }, { FitAddon: FitAddonCtor }, subscribed]) => {
        if (disposed) return;
        if (!subscribed.ok) {
          // 会话不存在等拒绝（切任务竞态）：壳容器内直接展示中文 reason
          host.textContent = subscribed.reason;
          return;
        }
        const fit = new FitAddonCtor();
        const term = new XTerm({
          // 已退出会话只读回看（禁输入；running 会话用户键入即授权）
          disableStdin: exitedRef.current,
          // 主题换算一处收口（语义 token → palette），换主题时重读
          theme: terminalXtermTheme(),
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
          fontSize: 12,
          cursorBlink: true,
          scrollback: 5000,
        });
        term.loadAddon(fit);
        term.open(host);
        fit.fit();
        mountRef.current = {
          term,
          fit,
          writeBytes: (data: string) => term.write(data),
          dispose: () => {
            term.dispose();
          },
        };
        // 回放先行（登记时刻为止的缓冲全量），攒冲的实时字节随后按序补
        if (subscribed.buffered !== "") term.write(subscribed.buffered);
        if (pendingRef.current.length > 0) {
          for (const chunk of pendingRef.current) term.write(chunk);
          pendingRef.current = [];
        }
        readyRef.current = true;
        // 键入原样透传（用户敲的含回车 `\r` 由 onData 自然给出）；已退出
        // 会话 disableStdin 后 onData 不再触发，双保险按状态过滤。
        // onData 返回 IDisposable（对象非函数），包装后退订
        const dataDisposable = term.onData((data) => {
          if (exitedRef.current) return;
          void window.codexlike.terminals.write(sessionId, data);
        });
        detach.push(() => dataDisposable.dispose());
        // fit 后尺寸上报（PTY 尺寸对齐容器）；后续由 ResizeObserver 驱动
        reportSize(sessionId, fit);
        const observer = new ResizeObserver(() => {
          if (mountRef.current === null) return;
          fit.fit();
          reportSize(sessionId, mountRef.current.fit);
        });
        observer.observe(host);
        detach.push(() => observer.disconnect());
        // 主题翻转（ADR 0006 light/dark）：重读语义 token 换算 palette
        const themeObserver = new MutationObserver(() => {
          if (mountRef.current === null) return;
          mountRef.current.term.options.theme = terminalXtermTheme();
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        detach.push(() => themeObserver.disconnect());
      })
      .catch(() => {
        if (disposed) return;
        host.textContent = "终端加载失败，请重试";
      });

    return () => {
      disposed = true;
      for (const fn of detach) fn();
      readyRef.current = false;
      pendingRef.current = [];
      mountRef.current = null;
      void window.codexlike.terminals.unsubscribe(sessionId);
    };
    // sessionId 变化即重建（拆页导航切换会话 = 换订阅现场）
  }, [props.sessionId]);

  return (
    <div
      ref={hostRef}
      data-testid="terminal-xterm-host"
      className="min-h-0 flex-1 overflow-hidden bg-canvas p-1"
    />
  );
}

/** fit 尺寸 → terminals:resize（会话不存在/已退出主进程静默忽略，无需防御） */
function reportSize(
  sessionId: string,
  fit: Pick<FitAddon, "proposeDimensions">
) {
  const dimensions = fit.proposeDimensions();
  if (dimensions === undefined) return;
  void window.codexlike.terminals.resize(sessionId, {
    cols: dimensions.cols,
    rows: dimensions.rows,
  });
}
