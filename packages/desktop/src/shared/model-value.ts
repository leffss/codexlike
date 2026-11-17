/**
 * IPC 边界的 model 参数归一（票 02，ADR 0024 二元组；review 修复 2 收敛）：
 * 渲染层传来的 model 容缺省形态（null / undefined / 空串）统一归一为
 * null——null = 未显式选模型，解析时回退 Profile 列表第一项
 * （agent-core resolveModelOf）；非空字符串（具体模型名）原样通过。
 * 子代理设置保存与任务 send/compact 的 IPC 边界共用同一口径。
 */
export function normalizeModelInput(
  model: string | null | undefined
): string | null {
  return model === null || model === undefined || model === "" ? null : model;
}
