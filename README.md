# print-bridge-sdk

`print-bridge-sdk` 是 PrintBridge 的浏览器端 JSSDK。它让 Web 页面连接用户电脑上的 PrintBridge 本地 Agent，并通过 WebSocket 下发静默打印任务。

它适合这些场景：

- ERP、WMS、OMS、收银系统打印标签、面单、小票或业务报表
- 浏览器页面把远程 PDF、图片、Office 文件交给本机打印机
- 业务系统已经生成好原始打印指令，需要发送给标签机或小票机
- 不希望弹出浏览器打印预览窗口，而是交给本机 Agent 提交系统打印队列

桌面端 Agent 项目见 [`PrintBridge`](https://github.com/vergil-lai/print-bridge)。

## 前置条件

使用 SDK 前，用户电脑上需要已经运行 PrintBridge，并完成基础配置：

1. 选择默认打印机
2. 选择或填写默认纸张
3. 将业务系统 Origin 加入 PrintBridge 网站白名单，例如 `https://example.com`
4. 如果要从局域网其他设备连接，还需要在 PrintBridge IP 白名单中加入对应 IP 或网段

SDK 默认连接：

```text
ws://127.0.0.1:17890/ws
```

SDK 不会自动连接。业务页面应在需要打印前调用 `connect()`，并在页面卸载或不再需要打印时调用 `disconnect()`。

## 安装

```bash
pnpm add print-bridge-sdk
```

也可以使用 npm 或 yarn：

```bash
npm install print-bridge-sdk
```

```bash
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
console.log(pong.agentStatus);

const accepted = await client.print({
  type: "pdf",
  printerName: "Office Printer",
  fileUrl: "https://example.com/label.pdf",
  copies: 1,
  paper: {
    widthMm: 60,
    heightMm: 40,
  },
});

console.log(accepted.requestId, accepted.jobId, accepted.status);
```

`print()` 返回 `queued` 只表示本机 Agent 已接收任务并放入队列。后续下载、打印、提交队列、完成或失败状态，需要通过 `status` 事件监听。

## API 速览

```ts
const client = new PrintBridgeClient({
  ip: "127.0.0.1",
  port: 17890,
  connectTimeoutMs: 3000,
  requestTimeoutMs: 3000,
  heartbeatIntervalMs: 15000,
});

await client.connect();
client.disconnect();
client.isConnected();

await client.ping();
await client.print(job);
await client.printBatch(batch);

const off = client.on("status", (event) => {
  console.log(event.jobId, event.status);
});

off();
```

可监听事件：

- `connect`：WebSocket 已连接
- `disconnect`：连接已关闭
- `status`：打印任务状态更新
- `error`：连接、协议或 Agent 错误

## 连接局域网 Agent

同机打印使用默认 `127.0.0.1`。如果 Web 页面需要连接局域网内另一台电脑上的 PrintBridge，可以把 `ip` 改成那台电脑的局域网地址：

```ts
const client = new PrintBridgeClient({
  ip: "192.168.1.23",
  port: 17890,
});
```

浏览器会在 WebSocket 握手时自动发送 `Origin`。局域网连接失败时，请同时确认：

- 目标电脑 PrintBridge 正在运行
- 目标电脑 PrintBridge 已允许该网页 Origin
- 目标电脑 PrintBridge 已允许当前客户端 IP
- 端口没有被防火墙或系统策略拦截

## 单个打印任务

### 打印远程 PDF：

```ts
await client.print({
  requestId: "REQ-001",
  jobId: "JOB-001",
  type: "pdf",
  printerName: "Office Printer",
  fileUrl: "https://example.com/label.pdf",
  copies: 1,
  paper: {
    widthMm: 60,
    heightMm: 40,
  },
});
```

### 打印图片：

```ts
await client.print({
  type: "image",
  fileUrl: "https://example.com/label.png",
  copies: 2,
});
```

### 打印 Office 文件：

```ts
await client.print({
  type: "docx",
  fileUrl: "https://example.com/report.docx",
  copies: 1,
  paper: {
    widthMm: 210,
    heightMm: 297,
  },
});
```

Office 文件支持 `docx`、`xlsx`、`pptx`。本机 Agent 会先转换为 PDF 再打印；SDK 不解析 Office 文件内容，打印效果以 Agent 转换后的 PDF 为准。

### 打印原始指令 (Raw commands)：

```ts
// TSPL/TSPL2 raw commands
const text = `SIZE 60 mm,40 mm
GAP 2 mm,0
CLS
TEXT 40,40,"3",0,1,1,"PrintBridge"
BARCODE 40,90,"128",80,1,0,2,2,"PB-001"
PRINT 1,1`;

const dataBase64 = btoa(text);

await client.print({
  type: "raw",
  printerName: "TSC TE244",
  dataBase64,
});
```

上面示例使用 TSPL/TSPL2 指令打印一张 60mm x 40mm 标签，内容包含文字 `PrintBridge` 和一个 Code128 条码 `PB-001`。`btoa(text)` 会把这段 ASCII 指令转成 base64，再交给 `dataBase64`。

raw 模式适合业务系统已经生成好 ESC/POS、TSPL、TSPL2、ZPL、EPL、PCL 或 PostScript 指令的场景。SDK 只负责把 raw payload 发给本机 Agent，不生成、解析或校验设备指令。

raw 任务不支持 `fileUrl`、`paper`、`copies`。纸张、间隙、份数、文字、条码、RFID 等标签参数需要由业务系统写入指令内容。

`requestId` 和 `jobId` 可以省略，SDK 会自动生成 UUID v4。`printerName` 可以省略，省略时由本机 Agent 使用默认打印机。文件类任务的 `paper` 可以省略，省略时由本机 Agent 使用默认纸张。

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
      type: "raw",
      printerName: "TSC TE244",
      dataBase64: "XlhB...",
    },
  ],
});
```

批量打印表示一次下发多个 job。本机 Agent 仍会串行执行，避免同一台打印机并发抢占。批量任务可以混合 PDF、image、Office 和 raw。

`requestId`、`batchId` 和每个 job 的 `jobId` 都可以省略，SDK 会自动生成。

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

`client.on()` 会返回取消订阅函数：

```ts
offConnect();
offStatus();
offDisconnect();
offError();
```

`print()` 和 `printBatch()` 的 Promise 只等待本机 Agent 返回 `queued` 或 `error`。后续状态会通过 `status` 事件推送：

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

状态语义：

- `submitted`：任务已提交到系统打印队列，不代表打印机已经真实完成出纸
- `completed`：系统或驱动层面观察到任务结束，也不等同于物理出纸确认
- `unknown`：平台不可追踪、追踪超时，或无法可靠判断后续状态
- `failed`：Agent 下载、转换、校验或系统打印命令失败

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

- `CONNECTION_FAILED`：无法连接 PrintBridge，可能是本地服务未启动、端口不对、Origin 未加入白名单，或 IP 未加入白名单
- `CONNECTION_TIMEOUT`：连接、心跳或请求超时
- `NOT_CONNECTED`：尚未连接就调用了打印方法
- `ORIGIN_NOT_ALLOWED`：浏览器页面 Origin 不在 PrintBridge 白名单中
- `PRINTER_NOT_CONFIGURED`：PrintBridge 未配置默认打印机
- `PAPER_NOT_CONFIGURED`：任务未传纸张，PrintBridge 也没有默认纸张
- `DOWNLOAD_FAILED`：本机 Agent 无法下载文件
- `FILE_TOO_LARGE`：文件或 raw bytes 超过本机 Agent 配置限制
- `FORMAT_MISMATCH`：声明格式与文件内容不匹配
- `OFFICE_CONVERT_FAILED`：本机 Agent 无法把 Office 文件转换为 PDF
- `PRINT_FAILED`：系统打印命令失败

SDK 会在发送前做基础校验：

- `type` 只能是 `pdf`、`image`、`raw`、`docx`、`xlsx`、`pptx`
- `image` 和 Office 文件的 `fileUrl` 必须是 HTTP(S) URL
- `pdf` 的 `fileUrl` 可以是 HTTP(S) URL，或 `data:application/pdf;base64,...`
- Office 文件不接受 data URL
- `raw` 必须提供 `dataBase64`
- `raw` 不接受 `fileUrl`、`copies`、`paper`
- 文件类任务的 `copies` 必须是正整数
- 文件类任务的 `paper.widthMm` 和 `paper.heightMm` 必须大于 0

## 打印机和队列查询

SDK 通过 WebSocket 提供打印机和队列查询：

```ts
await client.getPrintersList();
await client.getPrinterInfo("Office Printer");
await client.getPrintQueue();
```

返回给调用方的字段使用 camelCase，例如 `isDefault`、`widthMm`、`mediaTypes`；底层 Agent 协议字段仍是 snake_case。

## Node.js 和测试环境

浏览器环境会优先使用 `globalThis.WebSocket`。Node.js 环境没有浏览器 WebSocket 时，SDK 会使用依赖中的 `ws`。

测试或特殊运行环境可以注入自定义 WebSocket 构造器：

```ts
const client = new PrintBridgeClient({
  WebSocket: MockWebSocket,
});
```

## 安全边界

PrintBridge 安全模型由本机 Agent 执行。SDK 不能伪造、覆盖或自行校验浏览器 Origin，也不能替业务系统判断用户是否有打印权限。

部署时请至少做到：

- 只把可信业务系统加入 PrintBridge 网站白名单
- 如需局域网访问，只把可信客户端 IP 或网段加入 PrintBridge IP 白名单
- 不要把 PrintBridge 服务端口暴露到不可信网络
- 在业务系统侧控制谁能发起打印、能打印哪些文件、能打印多少份
- 不要把可访问敏感文件的 URL 暴露给不可信页面

## 服务兼容性

当前公开的 PrintBridge WebSocket 主路径支持：

- `ping`
- `get_printers_list`
- `get_printer_info`
- `get_print_queue`
- `print`
- `print_batch`
- `printers_list`
- `printer_info`
- `print_queue`
- `job_status`
- `error`

SDK 输入使用 camelCase，发送给本机 Agent 时会转换为 snake_case。

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
