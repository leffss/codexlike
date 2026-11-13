/**
 * 启动现场上报（票03）：低频事件不防抖，即时落盘；失败只 console.error，
 * 不阻塞界面（现场是尽力保存的增强信息，重开回退链兜底）。
 * App.tsx 顶层视图与 WorkspacePage.tsx 工作台目标上报共用此形状。
 */
export function reportLaunchState(
  save: Promise<unknown>,
  failMessage: string
): void {
  save.catch((error) => {
    console.error(`${failMessage}：${String(error)}`);
  });
}
