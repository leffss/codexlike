// 票 03 滚动跟随纯函数单测（spec 接缝二）：状态机裁决、输入意图识别、
// 竞争对账（用户上滚与同帧内容更新）、阅读位置恢复计算。
// 全部以纯输入重放，不依赖真实 DOM 时序（GLOSSARY「跟随」）。
import { describe, expect, it } from "vitest";

import {
  anchorDecisionAfterContentChange,
  backToLatestVisible,
  BOTTOM_SNAP_EPSILON_PX,
  distanceFromBottom,
  followModeAfterScroll,
  isBottomWithinEpsilon,
  keyVerticalIntent,
  readingSpotOnLeave,
  restoreReadingPlan,
  touchVerticalIntent,
  wheelVerticalIntent,
  type FollowMode,
  type ScrollGeometry,
} from "../src/lib/scroll-follow";

describe("贴底几何判定", () => {
  it("距底 ≤48px 视为贴底（epsilon 覆盖亚像素与末行 padding）", () => {
    const tall = { scrollTop: 952, scrollHeight: 1100, clientHeight: 100 };
    expect(distanceFromBottom(tall)).toBe(48);
    expect(isBottomWithinEpsilon(tall)).toBe(true);
    expect(isBottomWithinEpsilon({ ...tall, scrollTop: 951 })).toBe(false);
    expect(isBottomWithinEpsilon({ ...tall, scrollTop: 0 })).toBe(false);
  });

  it("内容不足一屏（无溢出）恒为贴底", () => {
    expect(
      isBottomWithinEpsilon({
        scrollTop: 0,
        scrollHeight: 80,
        clientHeight: 100,
      })
    ).toBe(true);
  });

  it("epsilon 可显式覆盖（默认导出 48）", () => {
    expect(BOTTOM_SNAP_EPSILON_PX).toBe(48);
    expect(
      isBottomWithinEpsilon(
        { scrollTop: 940, scrollHeight: 1100, clientHeight: 100 },
        60
      )
    ).toBe(true);
  });
});

describe("输入意图识别（朝向：up=远离底部 / down=靠近底部）", () => {
  it("滚轮：deltaY<0 上翻、>0 下翻、0（横向）无纵向意图", () => {
    expect(wheelVerticalIntent(-120)).toBe("up");
    expect(wheelVerticalIntent(96)).toBe("down");
    expect(wheelVerticalIntent(0)).toBe("neutral");
  });

  it("触摸：手指下拖（坐标增大）翻向更早内容、上拖翻向最新", () => {
    expect(touchVerticalIntent(500, 640)).toBe("up");
    expect(touchVerticalIntent(500, 360)).toBe("down");
    expect(touchVerticalIntent(500, 500)).toBe("neutral");
  });

  it("方向键：ArrowUp/PageUp/Home/Shift+Space 朝上，ArrowDown/PageDown/End/Space 朝下", () => {
    expect(keyVerticalIntent({ key: "ArrowUp" })).toBe("up");
    expect(keyVerticalIntent({ key: "PageUp" })).toBe("up");
    expect(keyVerticalIntent({ key: "Home" })).toBe("up");
    expect(keyVerticalIntent({ key: " ", shiftKey: true })).toBe("up");
    expect(keyVerticalIntent({ key: "ArrowDown" })).toBe("down");
    expect(keyVerticalIntent({ key: "PageDown" })).toBe("down");
    expect(keyVerticalIntent({ key: "End" })).toBe("down");
    expect(keyVerticalIntent({ key: " " })).toBe("down");
  });

  it("输入控件内的按键不算滚动意图；其余键无纵向意图", () => {
    expect(keyVerticalIntent({ key: "ArrowUp", editable: true })).toBe(
      "neutral"
    );
    expect(
      keyVerticalIntent({ key: " ", shiftKey: true, editable: true })
    ).toBe("neutral");
    expect(keyVerticalIntent({ key: "a" })).toBe("neutral");
  });
});

const tall: ScrollGeometry = {
  scrollTop: 952,
  scrollHeight: 1100,
  clientHeight: 100,
};
const farAbove: ScrollGeometry = { ...tall, scrollTop: 120 };

describe("状态机裁决 followModeAfterScroll", () => {
  it("程序化贴底与布局测高产生的滚动不动状态机", () => {
    for (const cause of ["scripted", "reflow"] as const) {
      expect(
        followModeAfterScroll({
          mode: "following",
          cause,
          geometry: farAbove,
        })
      ).toBe("following");
      expect(
        followModeAfterScroll({
          mode: "detached",
          cause,
          geometry: tall,
        })
      ).toBe("detached");
    }
  });

  it("用户上翻（有向上意图）立即脱离跟随", () => {
    expect(
      followModeAfterScroll({
        mode: "following",
        cause: "user-input",
        intent: "up",
        geometry: { ...tall, scrollTop: 700 },
      })
    ).toBe("detached");
  });

  it("用户拖滚动条等无登记意图的滚动按落点裁决", () => {
    expect(
      followModeAfterScroll({
        mode: "following",
        cause: "user-input",
        geometry: farAbove,
      })
    ).toBe("detached");
    expect(
      followModeAfterScroll({
        mode: "detached",
        cause: "user-input",
        geometry: tall,
      })
    ).toBe("following");
    expect(
      followModeAfterScroll({
        mode: "detached",
        cause: "user-input",
        geometry: farAbove,
      })
    ).toBe("detached");
  });

  it("用户下翻滚到底附近恢复跟随，未到底保持现状", () => {
    expect(
      followModeAfterScroll({
        mode: "detached",
        cause: "user-input",
        intent: "down",
        geometry: tall,
      })
    ).toBe("following");
    expect(
      followModeAfterScroll({
        mode: "detached",
        cause: "user-input",
        intent: "down",
        geometry: farAbove,
      })
    ).toBe("detached");
  });
});

describe("竞争对账：用户上滚与同帧内容更新", () => {
  it("用户 wheel 上翻与流式内容 commit 同帧：贴底回弹落点不吞掉上翻", () => {
    // 序列重放：following → wheel 上翻登记 up → 内容 commit 把 scrollTop
    // 拽回底部 → 滞后一帧的 scroll 事件到达（落点贴底 + 意图 up）
    const afterRebound = followModeAfterScroll({
      mode: "following",
      cause: "user-input",
      intent: "up",
      geometry: tall, // 落点被拽回底部
    });
    expect(afterRebound).toBe("detached");
  });

  it("无用户输入时布局回退不算上滚：保持跟随", () => {
    expect(
      followModeAfterScroll({
        mode: "following",
        cause: "user-input",
        intent: "neutral",
        geometry: farAbove,
      })
    ).toBe("detached");
    expect(
      followModeAfterScroll({
        mode: "following",
        cause: "reflow",
        geometry: farAbove,
      })
    ).toBe("following");
  });
});

describe("内容变化后的锚定动作", () => {
  it("跟随中贴底（snap），脱离时保持（hold，绝不拉回）", () => {
    expect(anchorDecisionAfterContentChange("following")).toBe("snap");
    expect(anchorDecisionAfterContentChange("detached")).toBe("hold");
  });
});

describe("「回到最新」入口可见性", () => {
  it("可见 = 脱离跟随且有消息", () => {
    expect(backToLatestVisible("detached", 3)).toBe(true);
    expect(backToLatestVisible("detached", 0)).toBe(false);
    expect(backToLatestVisible("following", 3)).toBe(false);
  });
});

describe("阅读位置记忆与恢复计算", () => {
  it("离开时记忆包含「是否贴底」：跟随态记贴底", () => {
    expect(readingSpotOnLeave({ mode: "following", geometry: tall })).toEqual({
      scrollTop: 952,
      atBottom: true,
    });
    expect(
      readingSpotOnLeave({ mode: "detached", geometry: farAbove })
    ).toEqual({ scrollTop: 120, atBottom: false });
  });

  it("无记忆定位当前最新并跟随（新会话）", () => {
    expect(restoreReadingPlan({ saved: null, geometry: tall })).toEqual({
      mode: "following",
      scrollTop: 1000,
    });
  });

  it("贴底记忆恢复到当前最新并跟随，旧的像素位置作废", () => {
    expect(
      restoreReadingPlan({
        saved: { scrollTop: 300, atBottom: true },
        geometry: { ...tall, scrollHeight: 2400 },
      })
    ).toEqual({ mode: "following", scrollTop: 2300 });
  });

  it("非贴底记忆恢复像素位置，并按当前高度夹紧", () => {
    expect(
      restoreReadingPlan({
        saved: { scrollTop: 260, atBottom: false },
        geometry: tall,
      })
    ).toEqual({ mode: "detached", scrollTop: 260 });
    // 保存后内容变矮：夹紧到当前最大值，恰好贴底 → 恢复跟随
    expect(
      restoreReadingPlan({
        saved: { scrollTop: 900, atBottom: false },
        geometry: { scrollTop: 0, scrollHeight: 820, clientHeight: 100 },
      })
    ).toEqual({ mode: "following", scrollTop: 720 });
  });

  it("旧记忆（无贴底标记）恢复点在当前底部附近时按贴底恢复跟随", () => {
    expect(
      restoreReadingPlan({
        saved: { scrollTop: 990 }, // 旧数据只有 scrollTop
        geometry: tall,
      })
    ).toEqual({ mode: "following", scrollTop: 990 });
    expect(
      restoreReadingPlan({ saved: { scrollTop: 120 }, geometry: tall })
    ).toEqual({ mode: "detached", scrollTop: 120 });
  });

  it("无溢出（内容不足一屏）恢复即跟随", () => {
    expect(
      restoreReadingPlan({
        saved: { scrollTop: 500, atBottom: false },
        geometry: { scrollTop: 0, scrollHeight: 80, clientHeight: 100 },
      })
    ).toEqual({ mode: "following", scrollTop: 0 });
  });
});

describe("端到端状态序列重放（纯输入，不依赖 DOM 时序）", () => {
  it("跟随 → 上翻脱离 → 内容更新不夺滚动权 → 滚回底部恢复", () => {
    let mode: FollowMode = "following";
    // 流式输出贴底
    expect(anchorDecisionAfterContentChange(mode)).toBe("snap");
    // 用户 wheel 上翻（远离底部落点）
    mode = followModeAfterScroll({
      mode,
      cause: "user-input",
      intent: "up",
      geometry: farAbove,
    });
    expect(mode).toBe("detached");
    // 脱离期间新内容到达：hold，且布局 scroll（reflow）不改状态
    expect(anchorDecisionAfterContentChange(mode)).toBe("hold");
    mode = followModeAfterScroll({
      mode,
      cause: "reflow",
      geometry: { ...farAbove, scrollHeight: 1300 },
    });
    expect(mode).toBe("detached");
    // 用户滚回底部附近：恢复跟随
    mode = followModeAfterScroll({
      mode,
      cause: "user-input",
      intent: "down",
      geometry: { ...tall, scrollTop: 1180, scrollHeight: 1300 },
    });
    expect(mode).toBe("following");
    expect(backToLatestVisible(mode, 5)).toBe(false);
  });
});
