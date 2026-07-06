# print-bridge-sdk

`print-bridge-sdk` 是 PrintBridge 的浏览器端 JS SDK。它负责从 Web 页面连接用户电脑上的 PrintBridge 本地服务，并通过 WebSocket 下发静默打印任务。

典型场景：

- ERP、WMS、OMS 等 Web 系统打印标签、面单或小票
- 浏览器页面把远程 PDF、图片或页面 HTML 交给本机打印机
- 业务系统不希望弹出浏览器打印预览窗口

桌面端项目见 [`PrintBridge`](https://github.com/vergil-lai/print-bridge)。

## 安装

```bash
pnpm add print-bridge-sdk
```

也可以使用 npm 或 yarn：

```bash
npm install print-bridge-sdk
yarn add print-bridge-sdk
```

## 快速开始

```ts
import { PrintBridgeClient } from "print-bridge-sdk";

const client = new PrintBridgeClient({
  ip: "127.0.0.1",
  port: 17890,
});

await client.connect();

const pong = await client.ping();
console.log(pong.time);

await client.print({
  type: "pdf",
  fileUrl: "https://example.com/label.pdf",
  copies: 1,
  paper: {
    widthMm: 60,
    heightMm: 40,
  },
});
```

SDK 默认连接：

```text
ws://127.0.0.1:17890/ws
```

SDK 不会自动连接。业务页面应在需要打印前调用 `connect()`，并在页面卸载或不再需要打印时调用 `disconnect()`。

## 连接到局域网服务

同机打印使用默认 `127.0.0.1`。如果 Web 页面需要连接局域网内另一台电脑上的 PrintBridge 服务，可以把 `ip` 改成那台电脑的局域网地址：

```ts
const client = new PrintBridgeClient({
  ip: "192.168.1.23",
  port: 17890,
});
```

浏览器会在 WebSocket 握手时自动发送 `Origin`。如果连接失败，请确认该 Web 页面 Origin 已经加入目标电脑 PrintBridge 的白名单。

## 单个打印任务

打印远程 PDF：

```ts
const accepted = await client.print({
  requestId: "REQ-001",
  jobId: "JOB-001",
  type: "pdf",
  fileUrl: "https://example.com/label.pdf",
  copies: 1,
  paper: {
    widthMm: 60,
    heightMm: 40,
  },
});

console.log(accepted.status);
```

打印图片：

```ts
await client.print({
  type: "image",
  fileUrl: "https://example.com/label.png",
  copies: 2,
});
```

SDK 输入使用 camelCase，发送给本地服务时会转换为 snake_case。`requestId` 和 `jobId` 可以省略，SDK 会自动生成 UUID v4。

`paper` 可以省略。省略时由本地服务使用设置中的默认纸张。

## 批量打印

```ts
await client.printBatch({
  requestId: "REQ-BATCH-001",
  batchId: "BATCH-001",
  jobs: [
    {
      jobId: "A-001",
      type: "pdf",
      fileUrl: "https://example.com/a.pdf",
      copies: 1,
    },
    {
      jobId: "B-001",
      type: "image",
      fileUrl: "https://example.com/b.jpg",
      copies: 1,
    },
  ],
});
```

批量打印表示一次下发多个 job。本地服务仍然会串行执行，避免同一台打印机并发抢占。

`requestId`、`batchId` 和每个 job 的 `jobId` 都可以省略，SDK 会自动生成。

## HTML 打印

HTML 打印会在浏览器侧先下载 HTML URL 或读取页面元素，再转换成 PDF(使用[html2pdf.js](https://github.com/eKoopmans/html2pdf.js)) data URL，最后通过普通 PDF 任务发送给本地服务。

打印远程 HTML 地址：

```ts
await client.print({
  type: "html",
  fileUrl: "https://example.com/label.html",
  paper: {
    widthMm: 60,
    heightMm: 40,
  },
});
```

也兼容打印当前页面元素：

```ts
await client.print({
  type: "html",
  printable: "label-root",
});
```

打印 raw HTML：

```ts
await client.print({
  type: "html-raw",
  html: "<section><h1>Label</h1></section>",
  style: "body { font-family: sans-serif; }",
  maxWidth: 600,
});
```

支持的 HTML 配置包括：

```ts
{
  header?: string
  headerStyle?: string
  maxWidth?: number
  css?: string | string[]
  style?: string
  ignoreElements?: string[]
  documentTitle?: string
  html2pdfOptions?: Record<string, unknown>
}
```

默认实现会优先使用页面上已有的全局 `html2pdf` 函数。如果不存在，SDK 会按需加载：

```text
https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.14.0/html2pdf.bundle.min.js
```

如果你的应用有 CSP、离线部署或自托管要求，可以注入自己的 HTML 转 PDF 实现：

```ts
const client = new PrintBridgeClient({
  htmlToPdf: async (html, options) => {
    return renderHtmlToPdfDataUrl(html, options);
  },
});
```

注入函数必须返回 `data:application/pdf;base64,...`。

## 状态监听

```ts
const offConnect = client.on("connect", () => {
  console.log("PrintBridge connected");
});

const offStatus = client.on("status", (event) => {
  console.log(event.requestId, event.jobId, event.status, event.message);
});

const offDisconnect = client.on("disconnect", (event) => {
  console.warn("PrintBridge disconnected", event.reason);
});

const offError = client.on("error", (error) => {
  console.error(error.code, error.message);
});
```

`client.on()` 会返回取消订阅函数。

`print()` 和 `printBatch()` 的 Promise 只等待本地服务返回 `queued` 或 `error`。后续状态会通过 `status` 事件推送：

```text
queued
downloading
printing
submitted
completed
failed
unknown
cancelled
```

`submitted` 表示任务已提交到系统打印队列，不代表打印机已经真实完成出纸。
`completed` 表示系统或驱动层面观察到任务结束，也不等同于物理出纸确认。
`unknown` 表示平台不可追踪、追踪超时，或无法可靠判断后续状态。

## 错误处理

```ts
import { PrintBridgeClient, PrintBridgeError } from "print-bridge-sdk";

try {
  await client.print({
    type: "pdf",
    fileUrl: "https://example.com/label.pdf",
  });
} catch (error) {
  if (error instanceof PrintBridgeError) {
    console.error(error.code, error.requestId, error.message);
  }
}
```

常见错误包括：

- `CONNECTION_FAILED`：无法连接 PrintBridge，可能是本地服务未启动、端口不对或 Origin 未加入白名单
- `CONNECTION_TIMEOUT`：连接、心跳或请求超时
- `NOT_CONNECTED`：尚未连接就调用了打印方法
- `PRINTER_NOT_CONFIGURED`：PrintBridge 未配置默认打印机
- `PAPER_NOT_CONFIGURED`：任务未传纸张，PrintBridge 也没有默认纸张
- `DOWNLOAD_FAILED`：本地服务无法下载文件
- `FILE_TOO_LARGE`：文件超过本地服务配置限制
- `FORMAT_MISMATCH`：声明格式与文件内容不匹配
- `PRINT_FAILED`：系统打印命令失败

SDK 会在发送前做基础校验：

- `type` 只能是 `pdf`、`image`、`html`、`html-raw`
- `pdf`、`image` 和 HTML URL 打印的 `fileUrl` 必须是 HTTP(S) URL
- `pdf` 额外接受 `data:application/pdf;base64,...`
- `copies` 必须是正整数
- `paper.widthMm` 和 `paper.heightMm` 必须大于 0

## Node.js 和测试环境

浏览器环境会优先使用 `globalThis.WebSocket`。Node.js 环境没有浏览器 WebSocket 时，SDK 会使用依赖中的 `ws`。

测试或特殊运行环境可以注入自定义 WebSocket 构造器：

```ts
const client = new PrintBridgeClient({
  WebSocket: MockWebSocket,
});
```

## 服务兼容性

当前公开的 PrintBridge WebSocket 主路径支持：

- `ping`
- `print`
- `print_batch`
- `job_status`
- `error`

SDK 源码中保留了 `getPrintersList()`、`getPrinterInfo()` 和 `getPrintQueue()` 方法，它们需要桌面端提供对应的 WebSocket 消息支持。使用当前 PrintBridge 时，打印机、纸张、配置和日志查询请以本地 HTTP API 为准。

## 安全边界

PrintBridge 安全模型依赖本地服务的 Origin 白名单。SDK 不能伪造、覆盖或自行校验浏览器 Origin。

如果浏览器连接被拒绝，请到用户本机 PrintBridge 设置中加入业务系统 Origin，例如：

```text
https://example.com
http://localhost:5173
```

业务系统仍然应该自行控制用户权限、可打印文件范围和打印次数。不要把可访问敏感文件的 URL 暴露给不可信页面。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

监听构建：

```bash
pnpm dev
```

## License

[MIT](./LICENSE)
