import type { Server } from "node:http";

/**
 * WHATWG fetch bad port 列表（undici 与 Chromium 一致拒绝访问，报
 * "fetch failed, cause: bad port"）。本机 TCP 动态端口范围若覆盖其中端口
 * （6666/10080 等），listen(0) 会偶发分配到：单个用例命中概率低，并行
 * 全量下每个用例都要起 mock，累计必撞——撞上就换端口重听。
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

/** mock server 以 listen(0) 起在安全端口：分配到 bad port 就关闭重听。 */
export async function listenMock(server: Server): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("未监听端口"));
          return;
        }
        resolve(address.port);
      });
    });
    if (!BAD_PORTS.has(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
