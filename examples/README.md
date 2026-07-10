# PrintBridge JSSDK Examples

这里放的是 SDK 的最小可用示例。示例使用 GitHub raw URL 指向本目录提交的 A4 样例文件，方便验证本机 Agent 能否从远程 URL 下载并打印。

## 样例文件

- PDF: `https://raw.githubusercontent.com/vergil-lai/print-bridge-jssdk/main/examples/assets/printbridge-a4-sample.pdf`
- JPG: `https://raw.githubusercontent.com/vergil-lai/print-bridge-jssdk/main/examples/assets/printbridge-a4-sample.jpg`
- HTML: `https://raw.githubusercontent.com/vergil-lai/print-bridge-jssdk/main/examples/assets/printbridge-a4-sample.html`

这些文件都是 A4 尺寸，用来测试远程 PDF、图片和 HTML 打印链路。

## 浏览器示例

先构建 SDK：

```bash
pnpm build
```

然后从仓库根目录启动一个静态服务，例如：

```bash
npx serve .
```

打开：

```text
http://localhost:3000/examples/browser-basic.html
```

这个页面包含单个 PDF、单个 JPG、批量打印、HTML URL 打印和 raw HTML 打印示例。

HTML URL 和 raw HTML 都会原样发送给本机 Agent，由 Agent 下载或渲染 HTML、转换后再打印；SDK 不会在浏览器中转换 HTML，也不会加载 `html2pdf.js`。

如果本机 Agent 配置了 Origin 白名单，需要把这个页面的 Origin 加进去，例如 `http://localhost:3000`。

## Node.js 示例

先构建 SDK：

```bash
pnpm build
```

运行：

```bash
node examples/node-print-git-url.mjs
```

默认会连接 `ws://127.0.0.1:17890/ws`，并依次提交 GitHub raw URL 上的 PDF 和 JPG 打印任务。
