/**
 * 折叠箭头（消息区统一视觉基准 = 交互问答行的原生 details 标记）：
 * border 实心三角 6×8px、颜色随行文字（currentColor）、负 margin 抵消
 * flex gap-2 后文字起点距内容左缘 12.4px（原生实测 12.55px）；展开态
 * 旋转 90° 朝下（同原生 disclosure-open）。尺寸固定不随行字号缩放——
 * 各行字号不一（text-xs / text-sm 混排），原生标记随 em 缩放反而互不相同。
 */
export function DisclosureArrow(props: {
  /** 受控开合态；缺省（非受控 <details>）由 className 的 group-open 驱动 */
  open?: boolean;
  /** 追加类（非受控 <details> 用 group-open:rotate-90 让 CSS 驱动开合态） */
  className?: string;
}) {
  return (
    <span
      className={`shrink-0 mr-[-2px] h-0 w-0 border-r-0 border-y-[4px] border-y-transparent border-l-[6px] border-l-[currentColor] ${props.open ? "rotate-90" : ""} ${props.className ?? ""}`}
    />
  );
}
