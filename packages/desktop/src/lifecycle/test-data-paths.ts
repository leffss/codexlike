import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** E2E 显式选择隔离目录；正常启动不改变 Electron 用户数据路径。 */
export function configureTestDataPaths(
  app: { setPath(name: "userData" | "sessionData", path: string): void },
  env: Record<string, string | undefined>
): void {
  const requested = env.CODEXLIKE_TEST_USER_DATA;
  if (!requested) return;
  if (!isAbsolute(requested)) {
    throw new Error("CODEXLIKE_TEST_USER_DATA 必须是绝对路径");
  }
  const userData = resolve(requested);
  const sessionData = join(userData, "session");
  mkdirSync(sessionData, { recursive: true });
  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
}
