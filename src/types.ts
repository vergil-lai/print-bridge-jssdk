import type { PrintBridgeError } from './index';

/** SDK 对调用方暴露的打印内容类型。 */
export type PrintBridgeJobType = 'pdf' | 'image';

/** 任务流经本地打印队列时发出的生命周期状态。 */
export type PrintBridgeJobStatus =
  | 'queued'
  | 'downloading'
  | 'printing'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'cancelled';

/** 暴露给 SDK 调用方的稳定协议和客户端错误码。 */
export type PrintBridgeErrorCode =
  | 'ORIGIN_NOT_ALLOWED'
  | 'INVALID_MESSAGE'
  | 'PRINTER_NOT_CONFIGURED'
  | 'PRINTER_NOT_FOUND'
  | 'PAPER_NOT_CONFIGURED'
  | 'PAPER_NOT_FOUND'
  | 'DOWNLOAD_FAILED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'FORMAT_MISMATCH'
  | 'PRINT_FAILED'
  | 'JOB_DUPLICATED'
  | 'BATCH_DUPLICATED'
  | 'BATCH_TOO_LARGE'
  | 'COPIES_OUT_OF_RANGE'
  | 'SERVICE_PORT_IN_USE'
  | 'INTERNAL_ERROR'
  | 'CONNECTION_FAILED'
  | 'CONNECTION_TIMEOUT'
  | 'NOT_CONNECTED';

/** 以毫米表示的纸张尺寸。 */
export interface PrintBridgePaper {
  widthMm: number;
  heightMm: number;
}

/** 单任务和批量请求共用的基础字段。 */
export interface PrintBridgeJobBase {
  jobId?: string;
  copies?: number;
  paper?: PrintBridgePaper;
}

/** 打印 PDF 文件或 SDK 生成的 PDF data URL。 */
export interface PrintBridgePdfJob extends PrintBridgeJobBase {
  type: 'pdf';
  fileUrl: string;
}

/** 打印图片文件，Agent 会按文件内容识别 PNG/JPEG。 */
export interface PrintBridgeImageJob extends PrintBridgeJobBase {
  type: 'image';
  fileUrl: string;
}

/** 单任务和批量请求共用的打印任务载荷。 */
export type PrintBridgeJob = PrintBridgePdfJob | PrintBridgeImageJob;

/** 投递单个打印任务的选项。 */
export type PrintBridgePrintOptions = PrintBridgeJob & {
  requestId?: string;
};

/** 在一个请求下投递多个打印任务的选项。 */
export interface PrintBridgeBatchOptions {
  requestId?: string;
  batchId?: string;
  jobs: PrintBridgeJob[];
}

/** 心跳 ping 返回的响应。 */
export interface PrintBridgePong {
  time: number;
  agentStatus: string;
}

/** Agent 已接收任务进入队列的初始确认。 */
export interface PrintBridgeAccepted {
  requestId: string;
  jobId: string;
  status: 'queued';
  message?: string;
}

/** Agent 返回的本机打印机摘要。 */
export interface PrintBridgePrinter {
  name: string;
  isDefault?: boolean;
}

/** Agent 返回的打印机纸张信息。 */
export interface PrintBridgePrinterPaper extends PrintBridgePaper {
  name?: string;
}

/** 单台打印机的详细信息。 */
export interface PrintBridgePrinterInfo extends PrintBridgePrinter {
  papers: PrintBridgePrinterPaper[];
}

/** 本机 Agent 打印队列中的任务摘要。 */
export interface PrintBridgePrintQueueJob {
  requestId: string;
  jobId: string;
  status: PrintBridgeJobStatus;
  message?: string;
}

/** 任务被接收后 Agent 推送的状态更新。 */
export interface PrintBridgeStatusEvent {
  requestId: string;
  jobId: string;
  status: PrintBridgeJobStatus;
  message?: string;
}

/** 浏览器和 Node.js socket 的规范化断开连接信息。 */
export interface PrintBridgeDisconnectEvent {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

/** 客户端实现使用的最小 socket 结构。 */
export interface WebSocketLike {
  readyState: number;
  /** 向本地 Agent 发送文本帧。 */
  send(data: string): void;
  /** 关闭 socket 连接。 */
  close(): void;
}

/** 带可赋值事件回调的浏览器 WebSocket 结构。 */
export interface BrowserWebSocketLike extends WebSocketLike {
  onopen: ((event?: unknown) => void) | null;
  onclose: ((event: PrintBridgeDisconnectEvent | CloseEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** 带事件监听方法的 Node ws socket 结构。 */
export interface WsWebSocketLike extends WebSocketLike {
  /** 订阅可重复触发的 socket 事件。 */
  on(event: 'open', listener: () => void): unknown;
  /** 订阅可重复触发的 socket 事件。 */
  on(event: 'message', listener: (data: unknown) => void): unknown;
  /** 订阅可重复触发的 socket 事件。 */
  on(event: 'close', listener: (code?: number, reason?: unknown) => void): unknown;
  /** 订阅可重复触发的 socket 事件。 */
  on(event: 'error', listener: (error: unknown) => void): unknown;
  /** 订阅一次 socket 事件，触发后移除监听器。 */
  once(event: 'open', listener: () => void): unknown;
  /** 订阅一次 socket 事件，触发后移除监听器。 */
  once(event: 'error', listener: (error: unknown) => void): unknown;
}

/** 注入浏览器、Node 或测试 WebSocket 实现时使用的构造接口。 */
export interface WebSocketConstructorLike {
  readonly CONNECTING?: number;
  readonly OPEN?: number;
  readonly CLOSING?: number;
  readonly CLOSED?: number;
  new (url: string): WebSocketLike;
}

/** 连接本地 PrintBridge Agent 的客户端选项。 */
export interface PrintBridgeClientOptions {
  port?: number;
  ip?: string;
  /** @deprecated Use ip instead. */
  host?: string;
  heartbeatIntervalMs?: number;
  heartbeatFailureThreshold?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  autoReconnect?: boolean;
  WebSocket?: WebSocketConstructorLike;
}

/** PrintBridgeClient 发出的类型化事件载荷。 */
export type PrintBridgeEventMap = {
  connect: [];
  disconnect: [event: PrintBridgeDisconnectEvent];
  status: [event: PrintBridgeStatusEvent];
  error: [error: PrintBridgeError];
};

/** 与所选事件载荷元组匹配的事件处理器类型。 */
export type PrintBridgeEventHandler<K extends keyof PrintBridgeEventMap> = (
  ...args: PrintBridgeEventMap[K]
) => void;

/** 本地 Agent 通过 WebSocket 发送的原始消息结构。 */
export type AgentMessage =
  | {
      type: 'pong';
      time: number;
      agent_status: string;
    }
  | {
      type: 'job_status';
      request_id: string;
      job_id: string;
      status: PrintBridgeJobStatus;
      message?: string;
    }
  | {
      type: 'error';
      request_id?: string;
      error_code: PrintBridgeErrorCode | string;
      message: string;
    }
  | {
      type: 'printers_list';
      request_id: string;
      printers: AgentPrinter[];
    }
  | {
      type: 'printer_info';
      request_id: string;
      printer: AgentPrinterInfo;
    }
  | {
      type: 'print_queue';
      request_id: string;
      jobs: AgentPrintQueueJob[];
    };

/** Agent 返回的原始打印机字段。 */
export interface AgentPrinter {
  name: string;
  is_default?: boolean;
}

/** Agent 返回的原始纸张字段。 */
export interface AgentPrinterPaper {
  name?: string;
  width_mm: number;
  height_mm: number;
}

/** Agent 返回的原始打印机详情字段。 */
export interface AgentPrinterInfo extends AgentPrinter {
  papers: AgentPrinterPaper[];
}

/** Agent 返回的原始打印队列任务字段。 */
export interface AgentPrintQueueJob {
  request_id: string;
  job_id: string;
  status: PrintBridgeJobStatus;
  message?: string;
}

/** 用于超时和响应匹配的内部待处理请求记录。 */
export interface PendingRequest<T> {
  /** 用匹配的 Agent 响应完成请求。 */
  resolve(value: T): void;
  /** Agent 返回错误或请求超时时拒绝请求。 */
  reject(reason: unknown): void;
  timeoutId: ReturnType<typeof setTimeout>;
}
