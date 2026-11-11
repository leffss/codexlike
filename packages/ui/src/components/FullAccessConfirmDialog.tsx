/**
 * 切换到「完全访问」审批模式前的风险确认对话框（ADR 0004）。
 * 完全访问 = 全自动执行 + 放开工作区文件边界（可不受限读写本地任意文件、联网），
 * 误操作不可逆范围最大，因此 UI 层在 selectApprovalMode 前拦截确认；
 * 取消则不发起 IPC，选择器自然回显原档位。
 */
export function FullAccessConfirmDialog(props: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-testid="full-access-confirm-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70"
    >
      <div className="w-[28rem] rounded-lg border border-amber-600/50 bg-slate-900 p-5 shadow-xl">
        <h3 className="text-base font-medium text-amber-300">
          切换到完全访问？
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          完全访问（full-access）下，Agent 将：
        </p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-400">
          <li>自动执行全部操作，不再逐条询问（含危险命令）；</li>
          <li>
            可不受限地读写本机任意位置的文件——
            <span className="text-amber-300">工作区边界保护将失效</span>；
          </li>
          <li>可自由访问互联网。</li>
        </ul>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          仅在你完全信任当前任务时使用；随时可切回「帮我批准」恢复边界。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="full-access-confirm-cancel"
            className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500"
            onClick={props.onCancel}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="full-access-confirm-ok"
            className="rounded bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-500"
            onClick={props.onConfirm}
          >
            我已了解风险，切换
          </button>
        </div>
      </div>
    </div>
  );
}
