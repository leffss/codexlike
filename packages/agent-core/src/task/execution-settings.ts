/**
 * 执行设置的共享常量（ADR 0017，GLOSSARY「执行设置」「工具轮次」）：
 * agent-core 默认值与设置层合法范围的单一来源。纯常量浏览器安全，
 * 从根出口（index.ts）再导出——desktop 存储校验与 ui 表单回退共用，避免数字分叉。
 */

/**
 * 主任务工具轮次上限默认值（防模型失控循环的兜底，非日常约束）。
 * 大功能开发一个回合动辄上百次工具调用，取 200 让正常任务单回合装得下；
 * 真正的天花板是上下文窗口——200 轮往返已接近多数模型上限。撞限可见提示
 * 且可发消息继续，但回合内工具往返不进后续上下文（需靠落盘文件与最终
 * 文本重新定位），故正常任务不应撞到。
 */
export const DEFAULT_MAX_TOOL_ROUNDS = 200;

/**
 * 子代理工具轮次上限默认值（与主任务同值：失控兜底，非日常约束）。
 * 撞限语义与主任务不同：子代理不中断主任务回合，报告末尾附截断标记回流，
 * 主模型据此知道委派未全部完成（不伪造成完成）。与主任务上限相互独立可调
 * （spec user story 3），常量分开定义防语义耦合。
 */
export const DEFAULT_MAX_SUBAGENT_TOOL_ROUNDS = 200;

/**
 * 工具轮次上限的设置层合法范围（主任务与子代理共用同一范围；
 * 设置页/存储校验用，agent-core 不重复校验）
 */
export const TOOL_ROUNDS_MIN = 10;
export const TOOL_ROUNDS_MAX = 1000;

/**
 * /compact 保留的最近原始对话轮数默认值（工单 08 现状 3 轮，执行设置票 03
 * 起用户可调）。compact 无「进行中」状态：每次执行逐次读取（ADR 0017），
 * 无回合快照语义——下次压缩立即采用新值。
 */
export const DEFAULT_COMPACT_KEEP_ROUNDS = 3;

/**
 * 压缩保留轮数的设置层合法范围（设置页/存储校验用，agent-core 不重复校验）；
 * 下界 1 保证 compact 至少保留一轮现场，上界 10 防保留过大失去压缩意义。
 */
export const COMPACT_KEEP_ROUNDS_MIN = 1;
export const COMPACT_KEEP_ROUNDS_MAX = 10;

/**
 * 上下文告警阈值的默认值，以占上下文窗口的整数百分比存储（现状 0.8 = 80%，
 * 执行设置票 03 起用户可调）。占比与 Provider Profile 的逐模型 contextWindowTokens
 * 叠加：告警线 = 窗口 × 阈值。UI 以百分比呈现，消费点换算为占比。
 */
export const DEFAULT_CONTEXT_WARNING_PERCENT = 80;

/**
 * 上下文告警阈值的设置层合法范围（百分比整数；设置页/存储校验用）：
 * 下界 50 防过早打扰，上界 95 保证告警在耗尽前仍留有处理余地。
 */
export const CONTEXT_WARNING_PERCENT_MIN = 50;
export const CONTEXT_WARNING_PERCENT_MAX = 95;

/**
 * 终端命令超时默认值（秒，执行设置票04）：工具层乘 1000 换算毫秒消费，
 * 存储层与设置页直接用于默认值。此前定义在 tools/terminal.ts，范围又散落
 * desktop store 与 ui 表单两处，执行设置常量收拢后六项设置共用单一来源
 * （code review 修复 3），防数字分叉。
 */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30;
export const DEFAULT_MAX_COMMAND_TIMEOUT_SECONDS = 120;

/**
 * 命令超时的设置层合法范围（秒，spec/ADR 0017）：下界 5 防过短打断正常
 * 命令，上界 600 防单条命令长时间占住回合。
 */
export const COMMAND_TIMEOUT_SECONDS_MIN = 5;
export const COMMAND_TIMEOUT_SECONDS_MAX = 600;

/**
 * 最大命令超时的设置层合法范围（秒）：上界 1800（30 分钟）为长时间
 * 构建/测试留余地的同时封顶；「命令超时 ≤ 最大命令超时」联动由设置层校验。
 */
export const MAX_COMMAND_TIMEOUT_SECONDS_MIN = 10;
export const MAX_COMMAND_TIMEOUT_SECONDS_MAX = 1800;
