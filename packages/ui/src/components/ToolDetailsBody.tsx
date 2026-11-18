/** 主/子工具共用的安全文本详情；无任务身份和截图读取副作用，调用方按需挂载。 */
export function ToolDetailsBody(props: {
  arguments: string;
  output: string;
  running?: boolean;
  testIdPrefix: "tool-call" | "subagent-tool";
}) {
  return (
    <>
      <details className="group mb-2" open>
        <summary className="cursor-pointer text-xs text-fg-subtle">
          参数
        </summary>
        <pre
          data-testid={`${props.testIdPrefix}-arguments`}
          className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-code-bg p-2 font-mono text-xs text-code-fg"
        >
          {prettyJson(props.arguments)}
        </pre>
      </details>
      <div className="text-xs text-fg-subtle">输出</div>
      <pre
        data-testid={`${props.testIdPrefix}-output`}
        className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-code-bg p-2 font-mono text-xs text-code-fg"
      >
        {props.output === "" && props.running ? "（执行中…）" : props.output}
      </pre>
    </>
  );
}

function prettyJson(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson), null, 2);
  } catch {
    return argsJson;
  }
}
