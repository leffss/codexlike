import { isSkillName } from "../context/skill-name";

const TOKEN_END =
  /[\s,.;:!?，。；：、！？（）【】《》「」『』“”‘’()[\]{}<>"'`]/;

interface SkillReference {
  start: number;
  end: number;
  name: string;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

/** 完整 token 才验证，避免把非法名称的合法前缀误认为另一个技能。 */
function* references(text: string): Generator<SkillReference> {
  let fence: { marker: string; length: number } | null = null;
  let inlineTicks = 0;
  // 缩进代码不能打断普通段落；文档首、空行后或现有代码块后可开始。
  let canStartIndentedCode = true;
  for (let i = 0; i < text.length; i += 1) {
    if (i === 0 || text[i - 1] === "\n") {
      const lineEnd = text.indexOf("\n", i);
      const end = lineEnd === -1 ? text.length : lineEnd;
      const line = text.slice(i, end).replace(/\r$/, "");
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence !== null) {
        if (
          marker?.[1]?.[0] === fence.marker &&
          marker[1].length >= fence.length &&
          marker[2]!.trim() === ""
        ) {
          fence = null;
          canStartIndentedCode = true;
        }
        i = end;
        continue;
      }
      // 四个空格或前三列内的 Tab 均达到四列；代码行不解析反引号。
      if (
        inlineTicks === 0 &&
        canStartIndentedCode &&
        /^(?: {4}| {0,3}\t)/.test(line)
      ) {
        i = end;
        continue;
      }
      canStartIndentedCode = line.trim() === "";
      if (inlineTicks === 0 && marker !== null) {
        fence = { marker: marker[1]![0]!, length: marker[1]!.length };
        i = end;
        continue;
      }
    }
    if (text[i] === "`" && (inlineTicks > 0 || !isEscaped(text, i))) {
      let end = i + 1;
      while (text[end] === "`") end += 1;
      const count = end - i;
      if (inlineTicks === 0) inlineTicks = count;
      else if (inlineTicks === count) inlineTicks = 0;
      i = end - 1;
      continue;
    }
    if (inlineTicks !== 0 || text[i] !== "$" || isEscaped(text, i)) continue;
    if (i > 0 && !/[\s([{（【「『“‘]/.test(text[i - 1]!)) continue;
    let end = i + 1;
    while (end < text.length && !TOKEN_END.test(text[end]!)) end += 1;
    yield { start: i, end, name: text.slice(i + 1, end) };
    i = end - 1;
  }
}

/** 草稿与发送复用相同的代码/转义边界；允许尚未完成的尾部连字符。 */
export function skillReferenceAt(
  text: string,
  caret: number
): { query: string; skillStart: number } | null {
  for (const reference of references(text)) {
    if (caret <= reference.start || caret > reference.end) continue;
    const query = text.slice(reference.start + 1, caret);
    if (
      query.length <= 64 &&
      (query === "" || /^[a-z0-9]+(?:-[a-z0-9]+)*-?$/.test(query))
    ) {
      return { query, skillStart: reference.start };
    }
  }
  return null;
}

/** 显式技能引用按出现顺序去重；未知合法名称保留，由宿主验证。纯数字视作金额。 */
export function extractSkillNames(text: string): string[] {
  const names = new Set<string>();
  for (const reference of references(text)) {
    if (isSkillName(reference.name)) {
      names.add(reference.name);
    }
  }
  return [...names];
}
