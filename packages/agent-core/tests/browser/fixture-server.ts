/**
 * 本地 HTML fixture 服务（spec Testing Decisions：浏览器工具在本地 fixture 上验证行为，
 * 不依赖外网）。起一个随机端口的 http 服务，提供表单/长文/写 Cookie 三个页面。
 */
import { createServer, type Server } from 'node:http';

export interface FixtureServer {
  /** 服务根地址（如 http://127.0.0.1:34567） */
  origin: string;
  close(): Promise<void>;
}

/** 表单页：输入框 + 提交按钮；点击后把输入值渲染进结果区（真实 JS 交互） */
const FORM_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>测试表单页</title></head>
<body>
  <h1>搜索表单</h1>
  <input id="query" name="query" placeholder="输入关键词">
  <button id="submit" type="button"
    onclick="document.getElementById('result').textContent = '已提交：' + document.getElementById('query').value">
    提交
  </button>
  <p id="result">未提交</p>
</body>
</html>`;

/** 长文页：正文远超截断上限（browser_read 用；1200 段约 5 万字符） */
function articleHtml(): string {
  const paragraph = '这是一段用于验证正文提取与截断行为的填充文本，包含中英文 mix 内容 sample text。';
  const body = Array.from({ length: 1200 }, (_, index) => `<p>${index} ${paragraph}</p>`).join('\n');
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>长文测试页</title></head>
<body>
  <nav>导航 甲 乙 丙</nav>
  <main id="content">
    <h1>长文测试页标题</h1>
    ${body}
  </main>
</body>
</html>`;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (url === '/form') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(FORM_HTML);
      return;
    }
    if (url === '/article') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(articleHtml());
      return;
    }
    if (url === '/set-cookie') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'fixture_sid=abc123; path=/',
      });
      response.end('<!doctype html><html><body>cookie 已写入</body></html>');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture 服务启动失败：未获得监听地址');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
