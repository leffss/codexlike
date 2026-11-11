/** 浏览器安全的技能名称约束：小写字母/数字、单连字符、最长 64 字符。
 * 产品约定至少含一个字母，避免显式 $引用 与金额歧义；发现与发送共用。
 */
export function isSkillName(name: string): boolean {
  return (
    name.length <= 64 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) &&
    /[a-z]/.test(name)
  );
}
