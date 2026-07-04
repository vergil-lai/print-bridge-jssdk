import EventEmitter from 'eventemitter3';
import NodeWebSocket from 'ws';
import type {
  AgentMessage,
  BrowserWebSocketLike,
  PendingRequest,
  PrintBridgeAccepted,
  PrintBridgeBatchOptions,
  PrintBridgeClientOptions,
  PrintBridgeDisconnectEvent,
  PrintBridgeErrorCode,
  PrintBridgeEventHandler,
  PrintBridgeEventMap,
  PrintBridgeHtmlConfiguration,
  PrintBridgeHtmlRenderOptions,
  PrintBridgeHtmlToPdf,
  PrintBridgeJob,
  PrintBridgeJobType,
  PrintBridgePaper,
  PrintBridgePong,
  PrintBridgePrinter,
  PrintBridgePrinterInfo,
  PrintBridgePrintQueueJob,
  PrintBridgePrintOptions,
  WebSocketConstructorLike,
  WebSocketLike,
  WsWebSocketLike,
} from './types';

const DEFAULT_PORT = 17890;
const DEFAULT_IP = '127.0.0.1';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_HEARTBEAT_FAILURE_THRESHOLD = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;
const HTML2PDF_CDN_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.14.0/html2pdf.bundle.min.js';
const VALID_JOB_TYPES = new Set<PrintBridgeJobType>(['pdf', 'image', 'html', 'html-raw']);

type AgentPrintableType = 'pdf' | 'image';

interface AgentPrintableJob {
  jobId: string;
  type: AgentPrintableType;
  fileUrl: string;
  copies?: number;
  paper?: PrintBridgePaper;
}

interface AgentPrintOptions extends AgentPrintableJob {
  requestId: string;
}

interface AgentBatchOptions {
  requestId: string;
  batchId: string;
  jobs: AgentPrintableJob[];
}

type Html2PdfFactory = () => {
  set(options: Record<string, unknown>): {
    from(element: HTMLElement): {
      outputPdf(type: 'datauristring'): Promise<string>;
    };
  };
};

type ResolvedPrintBridgeJob = PrintBridgeJob & {
  jobId: string;
};

let html2pdfLoadPromise: Promise<Html2PdfFactory> | null = null;

/** PrintBridge 客户端抛出的错误，包含稳定的协议错误码。 */
export class PrintBridgeError extends Error {
  readonly code: PrintBridgeErrorCode | string;
  readonly requestId?: string;
  override readonly cause?: unknown;

  /** 创建客户端错误，并保留可选的 request id 供调用方使用。 */
  constructor(
    code: PrintBridgeErrorCode | string,
    message: string,
    options: { requestId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'PrintBridgeError';
    this.code = code;
    this.requestId = options.requestId;
    this.cause = options.cause;
  }
}

/** 用于连接本地 PrintBridge Agent WebSocket API 的浏览器或 Node.js 客户端。 */
export class PrintBridgeClient {
  private readonly options: Required<
    Omit<PrintBridgeClientOptions, 'WebSocket' | 'htmlToPdf' | 'ip'>
  > & {
    WebSocket?: WebSocketConstructorLike;
    htmlToPdf?: PrintBridgeHtmlToPdf;
  };

  private socket: WebSocketLike | null = null;
  private connected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatFailures = 0;
  private readonly emitter = new EventEmitter<PrintBridgeEventMap>();

  private readonly pendingRequests = new Map<string, PendingRequest<unknown>>();

  private readonly pendingPings = new Map<number, PendingRequest<unknown>>();

  /** 使用本地 Agent 默认值创建客户端，测试或应用可覆盖这些默认值。 */
  constructor(options: PrintBridgeClientOptions = {}) {
    this.options = {
      port: options.port ?? DEFAULT_PORT,
      host: options.ip ?? options.host ?? DEFAULT_IP,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatFailureThreshold:
        options.heartbeatFailureThreshold ?? DEFAULT_HEARTBEAT_FAILURE_THRESHOLD,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      autoReconnect: options.autoReconnect ?? false,
      WebSocket: options.WebSocket,
      htmlToPdf: options.htmlToPdf,
    };
  }

  /** 打开 WebSocket 连接，并在连接就绪后启动心跳。 */
  connect(): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }

    const WebSocketImpl = this.getWebSocketConstructor();
    const socket = new WebSocketImpl(`ws://${this.options.host}:${this.options.port}/ws`);
    this.socket = socket;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (isBrowserWebSocket(socket)) {
          socket.onopen = null;
          socket.onerror = null;
          socket.onclose = null;
        }

        socket.close();
        this.socket = null;
        reject(new PrintBridgeError('CONNECTION_TIMEOUT', 'PrintBridge connection timed out.'));
      }, this.options.connectTimeoutMs);

      const handleOpen = () => {
        clearTimeout(timeoutId);
        this.connected = true;
        this.heartbeatFailures = 0;
        this.bindSocket(socket);
        this.startHeartbeat();
        this.emitter.emit('connect');
        resolve();
      };

      const handleError = (event: unknown) => {
        clearTimeout(timeoutId);
        this.socket = null;
        reject(
          new PrintBridgeError('CONNECTION_FAILED', 'PrintBridge connection failed.', {
            cause: event,
          }),
        );
      };

      if (isWsWebSocket(socket)) {
        socket.once('open', handleOpen);
        socket.once('error', handleError);
      } else if (isBrowserWebSocket(socket)) {
        socket.onopen = handleOpen;
        socket.onerror = handleError;
      }
    });
  }

  /** 关闭 socket，并拒绝仍在等待 Agent 响应的请求。 */
  disconnect(): void {
    this.stopHeartbeat();
    this.rejectAllPending(new PrintBridgeError('NOT_CONNECTED', 'PrintBridge is disconnected.'));

    const socket = this.socket;
    this.socket = null;
    this.connected = false;

    if (socket && socket.readyState !== this.getClosedState()) {
      socket.close();
    }
  }

  /** 仅当客户端状态和 socket 状态都为打开时返回 true。 */
  isConnected(): boolean {
    return this.connected && this.socket?.readyState === this.getOpenState();
  }

  /** 发送心跳 ping，并用匹配的 Agent pong 完成请求。 */
  ping(): Promise<PrintBridgePong> {
    this.assertConnected();
    const time = Date.now();

    return this.createPending(this.pendingPings, time, 'Ping timed out.', () => {
      this.socket?.send(
        JSON.stringify({
          type: 'ping',
          time,
        }),
      );
    });
  }

  /** 通过 WebSocket 获取本机 Agent 可见的打印机列表。 */
  async getPrintersList(): Promise<PrintBridgePrinter[]> {
    this.assertConnected();
    const requestId = createUuid();

    return this.createPending(
      this.pendingRequests,
      requestId,
      'Get printers list request timed out.',
      () => {
        this.socket?.send(
          JSON.stringify({
            type: 'get_printers_list',
            request_id: requestId,
          }),
        );
      },
    );
  }

  /** 通过 WebSocket 获取指定打印机的纸张等详情。 */
  async getPrinterInfo(printerName: string): Promise<PrintBridgePrinterInfo> {
    this.assertConnected();
    assertRequired(printerName, 'printerName');
    const requestId = createUuid();

    return this.createPending(
      this.pendingRequests,
      requestId,
      'Get printer info request timed out.',
      () => {
        this.socket?.send(
          JSON.stringify({
            type: 'get_printer_info',
            request_id: requestId,
            printer_name: printerName,
          }),
        );
      },
    );
  }

  /** 通过 WebSocket 获取本机 Agent 当前打印队列。 */
  async getPrintQueue(): Promise<PrintBridgePrintQueueJob[]> {
    this.assertConnected();
    const requestId = createUuid();

    return this.createPending(
      this.pendingRequests,
      requestId,
      'Get print queue request timed out.',
      () => {
        this.socket?.send(
          JSON.stringify({
            type: 'get_print_queue',
            request_id: requestId,
          }),
        );
      },
    );
  }

  /** 通过本地 Agent 投递单个打印任务。 */
  async print(job: PrintBridgePrintOptions): Promise<PrintBridgeAccepted> {
    this.assertConnected();
    validatePrintOptions(job);
    const requestId = job.requestId ?? createUuid();
    const resolvedJob = withJobId(job);
    const printableJob =
      resolvedJob.type === 'pdf' || resolvedJob.type === 'image'
        ? fileJobToAgentJob(resolvedJob)
        : await this.resolveHtmlPrintableJob(resolvedJob);

    return this.createPending(this.pendingRequests, requestId, 'Print request timed out.', () => {
      this.socket?.send(
        JSON.stringify(
          serializePrint({
            requestId,
            ...printableJob,
          }),
        ),
      );
    });
  }

  /** 通过本地 Agent 投递一批打印任务。 */
  async printBatch(batch: PrintBridgeBatchOptions): Promise<PrintBridgeAccepted> {
    this.assertConnected();
    validateBatchOptions(batch);
    const requestId = batch.requestId ?? createUuid();
    const batchId = batch.batchId ?? createUuid();
    const jobs = batch.jobs.map(withJobId);
    const printableJobs = jobs.every(isFileJob)
      ? jobs.map(fileJobToAgentJob)
      : await Promise.all(jobs.map(job => this.resolvePrintableJob(job)));

    return this.createPending(
      this.pendingRequests,
      requestId,
      'Print batch request timed out.',
      () => {
        this.socket?.send(
          JSON.stringify(
            serializeBatch({
              requestId,
              batchId,
              jobs: printableJobs,
            }),
          ),
        );
      },
    );
  }

  /** 注册类型化事件监听器，并返回取消订阅函数。 */
  on<K extends keyof PrintBridgeEventMap>(
    event: K,
    handler: PrintBridgeEventHandler<K>,
  ): () => void {
    this.emitter.on(event, handler);
    return () => {
      this.emitter.removeListener(event, handler);
    };
  }

  /** socket 打开后绑定平台相关的 WebSocket 事件处理器。 */
  private bindSocket(socket: WebSocketLike): void {
    if (isWsWebSocket(socket)) {
      socket.on('message', data => {
        this.handleMessage(data);
      });

      socket.on('error', event => {
        this.emitter.emit(
          'error',
          new PrintBridgeError('CONNECTION_FAILED', 'PrintBridge WebSocket error.', {
            cause: event,
          }),
        );
      });

      socket.on('close', (code, reason) => {
        this.handleDisconnect({
          code,
          reason: reasonToString(reason),
          wasClean: code === 1000,
        });
      });
      return;
    }

    if (isBrowserWebSocket(socket)) {
      socket.onmessage = event => {
        this.handleMessage(event.data);
      };

      socket.onerror = event => {
        this.emitter.emit(
          'error',
          new PrintBridgeError('CONNECTION_FAILED', 'PrintBridge WebSocket error.', {
            cause: event,
          }),
        );
      };

      socket.onclose = event => {
        this.handleDisconnect({
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
      };
    }
  }

  /** 解析 Agent 帧，并分发给对应的协议处理器。 */
  private handleMessage(data: unknown): void {
    let message: AgentMessage;

    try {
      message = JSON.parse(String(data)) as AgentMessage;
    } catch (cause) {
      this.emitter.emit(
        'error',
        new PrintBridgeError('INVALID_MESSAGE', 'Invalid PrintBridge message.', {
          cause,
        }),
      );
      return;
    }

    if (message.type === 'pong') {
      this.handlePong(message);
      return;
    }

    if (message.type === 'job_status') {
      this.handleStatus(message);
      return;
    }

    if (message.type === 'error') {
      this.handleAgentError(message);
      return;
    }

    if (message.type === 'printers_list') {
      this.resolvePendingRequest(
        message.request_id,
        message.printers.map(printer => ({
          name: printer.name,
          isDefault: printer.is_default,
        })),
      );
      return;
    }

    if (message.type === 'printer_info') {
      this.resolvePendingRequest(message.request_id, {
        name: message.printer.name,
        isDefault: message.printer.is_default,
        papers: message.printer.papers.map(paper => ({
          name: paper.name,
          widthMm: paper.width_mm,
          heightMm: paper.height_mm,
        })),
      });
      return;
    }

    if (message.type === 'print_queue') {
      this.resolvePendingRequest(
        message.request_id,
        message.jobs.map(job => ({
          requestId: job.request_id,
          jobId: job.job_id,
          status: job.status,
          message: job.message,
        })),
      );
      return;
    }

    this.emitter.emit(
      'error',
      new PrintBridgeError('INVALID_MESSAGE', 'Unsupported PrintBridge message.'),
    );
  }

  /** 根据返回的 ping 时间戳完成对应的待处理心跳。 */
  private handlePong(message: Extract<AgentMessage, { type: 'pong' }>): void {
    const pending = this.pendingPings.get(message.time);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingPings.delete(message.time);
    this.heartbeatFailures = 0;
    pending.resolve({
      time: message.time,
      agentStatus: message.agent_status,
    });
  }

  /** 发出任务状态事件，并完成初始入队确认。 */
  private handleStatus(message: Extract<AgentMessage, { type: 'job_status' }>): void {
    const event = {
      requestId: message.request_id,
      jobId: message.job_id,
      status: message.status,
      message: message.message,
    };

    this.emitter.emit('status', event);

    if (message.status !== 'queued') {
      return;
    }

    const pending = this.pendingRequests.get(message.request_id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(message.request_id);
    pending.resolve({
      requestId: event.requestId,
      jobId: event.jobId,
      status: 'queued',
      message: event.message,
    });
  }

  /** 把 Agent 错误帧转换为客户端错误，并拒绝匹配的请求。 */
  private handleAgentError(message: Extract<AgentMessage, { type: 'error' }>): void {
    const error = new PrintBridgeError(message.error_code, message.message, {
      requestId: message.request_id,
    });

    this.emitter.emit('error', error);

    if (!message.request_id) {
      return;
    }

    const pending = this.pendingRequests.get(message.request_id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(message.request_id);
    pending.reject(error);
  }

  /** 打开的连接关闭时清理连接状态并通知监听器。 */
  private handleDisconnect(event: PrintBridgeDisconnectEvent): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    this.stopHeartbeat();
    this.rejectAllPending(new PrintBridgeError('NOT_CONNECTED', 'PrintBridge is disconnected.'));

    if (wasConnected) {
      this.emitter.emit('disconnect', event);
    }
  }

  /** 完成非打印类 request_id 响应。 */
  private resolvePendingRequest(requestId: string, value: unknown): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);
    pending.resolve(value);
  }

  /** 启动定时 ping，并在连续心跳失败后关闭 socket。 */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    if (this.options.heartbeatIntervalMs <= 0) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      this.ping().catch(() => {
        this.heartbeatFailures += 1;

        if (this.heartbeatFailures >= this.options.heartbeatFailureThreshold && this.socket) {
          this.socket.close();
        }
      });
    }, this.options.heartbeatIntervalMs);
  }

  /** 停止心跳定时器，不改变 socket 状态。 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 跟踪请求，直到响应到达或请求超时。 */
  private createPending<TKey, TValue>(
    map: Map<TKey, PendingRequest<unknown>>,
    key: TKey,
    timeoutMessage: string,
    send: () => void,
  ): Promise<TValue> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        map.delete(key);
        reject(new PrintBridgeError('CONNECTION_TIMEOUT', timeoutMessage));
      }, this.options.requestTimeoutMs);

      map.set(key, { resolve, reject, timeoutId });
      send();
    });
  }

  /** 断开连接或错误清理时拒绝所有进行中的打印请求和 ping。 */
  private rejectAllPending(error: PrintBridgeError): void {
    for (const [key, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pendingRequests.delete(key);
    }

    for (const [key, pending] of this.pendingPings) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pendingPings.delete(key);
    }
  }

  /** 调用方在没有打开 socket 时发送协议消息则抛出错误。 */
  private assertConnected(): void {
    if (!this.isConnected()) {
      throw new PrintBridgeError('NOT_CONNECTED', 'PrintBridge is not connected.');
    }
  }

  /** 选择注入的、浏览器内置的或 Node.js 的 WebSocket 实现。 */
  private getWebSocketConstructor(): WebSocketConstructorLike {
    const WebSocketImpl =
      this.options.WebSocket ??
      (globalThis as { WebSocket?: WebSocketConstructorLike }).WebSocket ??
      (NodeWebSocket as unknown as WebSocketConstructorLike);

    return WebSocketImpl;
  }

  /** 返回 WebSocket OPEN 常量，缺失时回退到标准数值。 */
  private getOpenState(): number {
    return this.options.WebSocket?.OPEN ?? 1;
  }

  /** 返回 WebSocket CLOSED 常量，缺失时回退到标准数值。 */
  private getClosedState(): number {
    return this.options.WebSocket?.CLOSED ?? 3;
  }

  /** 选择注入的或默认的浏览器 HTML 转 PDF 实现。 */
  private renderHtmlToPdf(html: string, options: PrintBridgeHtmlRenderOptions): Promise<string> {
    const converter = this.options.htmlToPdf ?? defaultHtmlToPdf;
    return converter(html, options);
  }

  /** 把 SDK public job 归一化为 Agent 可直接处理的文件任务。 */
  private async resolvePrintableJob(job: ResolvedPrintBridgeJob): Promise<AgentPrintableJob> {
    if (job.type === 'pdf' || job.type === 'image') {
      return fileJobToAgentJob(job);
    }

    return this.resolveHtmlPrintableJob(job);
  }

  /** 把 HTML 类型任务渲染为 PDF data URL。 */
  private async resolveHtmlPrintableJob(
    job: Extract<ResolvedPrintBridgeJob, { type: 'html' | 'html-raw' }>,
  ): Promise<AgentPrintableJob> {
    const html = job.type === 'html' ? resolvePrintableElement(job.printable).outerHTML : job.html;
    const fileUrl = await this.renderHtmlToPdf(html, htmlRenderOptions(job));

    return {
      jobId: job.jobId,
      type: 'pdf',
      fileUrl,
      copies: job.copies,
      paper: job.paper,
    };
  }
}

/** 判断任务是否已经是 Agent 可直接接收的文件任务。 */
function isFileJob(
  job: ResolvedPrintBridgeJob,
): job is Extract<ResolvedPrintBridgeJob, { type: 'pdf' | 'image' }> {
  return job.type === 'pdf' || job.type === 'image';
}

/** 把 SDK 文件任务转换为 Agent 文件任务。 */
function fileJobToAgentJob(
  job: Extract<ResolvedPrintBridgeJob, { type: 'pdf' | 'image' }>,
): AgentPrintableJob {
  return {
    jobId: job.jobId,
    type: job.type,
    fileUrl: job.fileUrl,
    copies: job.copies,
    paper: job.paper,
  };
}

/** 为缺省 jobId 的任务生成协议所需的 UUID4。 */
function withJobId<T extends PrintBridgeJob>(job: T): T & { jobId: string } {
  return {
    ...job,
    jobId: job.jobId ?? createUuid(),
  };
}

/** 生成 UUID4，优先使用运行环境提供的安全随机源。 */
function createUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

/** 通过排除 Node ws 事件 API 来识别浏览器风格 socket。 */
function isBrowserWebSocket(socket: WebSocketLike): socket is BrowserWebSocketLike {
  return !isWsWebSocket(socket);
}

/** 通过事件注册方法识别 Node ws socket。 */
function isWsWebSocket(socket: WebSocketLike): socket is WsWebSocketLike {
  return (
    'on' in socket &&
    typeof socket.on === 'function' &&
    'once' in socket &&
    typeof socket.once === 'function'
  );
}

/** 规范化来自浏览器字符串、Node buffer 或未知值的关闭原因。 */
function reasonToString(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) {
    return undefined;
  }

  if (typeof reason === 'string') {
    return reason;
  }

  if (reason instanceof Uint8Array) {
    return new TextDecoder().decode(reason);
  }

  return String(reason);
}

/** 把公开的 camelCase 打印选项转换为传输协议载荷。 */
function serializePrint(job: AgentPrintOptions): Record<string, unknown> {
  return {
    type: 'print',
    request_id: job.requestId,
    job_id: job.jobId,
    format: job.type,
    file_url: job.fileUrl,
    ...(job.copies === undefined ? {} : { copies: job.copies }),
    ...(job.paper === undefined ? {} : { paper: serializePaper(job.paper) }),
  };
}

/** 把公开的批量选项转换为传输协议载荷。 */
function serializeBatch(batch: AgentBatchOptions): Record<string, unknown> {
  return {
    type: 'print_batch',
    request_id: batch.requestId,
    batch_id: batch.batchId,
    jobs: batch.jobs.map(job => ({
      job_id: job.jobId,
      format: job.type,
      file_url: job.fileUrl,
      ...(job.copies === undefined ? {} : { copies: job.copies }),
      ...(job.paper === undefined ? {} : { paper: serializePaper(job.paper) }),
    })),
  };
}

/** 把纸张尺寸转换为 Agent 协议字段名。 */
function serializePaper(paper: PrintBridgePaper): Record<string, number> {
  return {
    width_mm: paper.widthMm,
    height_mm: paper.heightMm,
  };
}

/** 发送给 Agent 前校验批量任务级字段。 */
function validateBatchOptions(batch: PrintBridgeBatchOptions): void {
  if (!Array.isArray(batch.jobs) || batch.jobs.length === 0) {
    throw new PrintBridgeError('INVALID_MESSAGE', 'jobs is required.');
  }

  for (const job of batch.jobs) {
    validateJob(job);
  }
}

/** 发送给 Agent 前校验单任务打印选项。 */
function validatePrintOptions(job: PrintBridgePrintOptions): void {
  validateJob(job);
}

/** 校验单任务和批量任务共用的字段。 */
function validateJob(job: PrintBridgeJob): void {
  if (!VALID_JOB_TYPES.has(job.type)) {
    throw new PrintBridgeError('UNSUPPORTED_FORMAT', 'type is unsupported.');
  }

  if (job.type === 'pdf' || job.type === 'image') {
    if (!isPrintableFileUrl(job.fileUrl, job.type)) {
      throw new PrintBridgeError(
        'INVALID_MESSAGE',
        'fileUrl must be an http, https, or PDF data URL.',
      );
    }
  }

  if (job.type === 'html') {
    validateHtmlConfiguration(job);
  }

  if (job.type === 'html-raw') {
    assertRequired(job.html, 'html');
    validateHtmlConfiguration(job);
  }

  if (job.copies !== undefined && (!Number.isInteger(job.copies) || job.copies <= 0)) {
    throw new PrintBridgeError('COPIES_OUT_OF_RANGE', 'copies must be a positive integer.');
  }

  if (job.paper) {
    if (job.paper.widthMm <= 0) {
      throw new PrintBridgeError('PAPER_NOT_CONFIGURED', 'paper.widthMm must be greater than 0.');
    }

    if (job.paper.heightMm <= 0) {
      throw new PrintBridgeError('PAPER_NOT_CONFIGURED', 'paper.heightMm must be greater than 0.');
    }
  }
}

/** 校验 HTML 打印配置中会影响本地渲染的字段。 */
function validateHtmlConfiguration(
  job: PrintBridgeHtmlConfiguration & { paper?: PrintBridgePaper },
): void {
  if (job.maxWidth !== undefined && (!Number.isFinite(job.maxWidth) || job.maxWidth <= 0)) {
    throw new PrintBridgeError('INVALID_MESSAGE', 'maxWidth must be greater than 0.');
  }

  if (job.ignoreElements !== undefined && !Array.isArray(job.ignoreElements)) {
    throw new PrintBridgeError('INVALID_MESSAGE', 'ignoreElements must be an array.');
  }

  if (job.paper) {
    if (job.paper.widthMm <= 0) {
      throw new PrintBridgeError('PAPER_NOT_CONFIGURED', 'paper.widthMm must be greater than 0.');
    }

    if (job.paper.heightMm <= 0) {
      throw new PrintBridgeError('PAPER_NOT_CONFIGURED', 'paper.heightMm must be greater than 0.');
    }
  }
}

/** 要求调用方提供的选项中该字符串字段不能为空。 */
function assertRequired(value: string, field: string): void {
  if (!value || value.trim().length === 0) {
    throw new PrintBridgeError('INVALID_MESSAGE', `${field} is required.`);
  }
}

/** 接受 HTTP(S) URL，或 SDK 生成的 PDF data URL。 */
function isPrintableFileUrl(value: string, type: AgentPrintableType): boolean {
  if (type === 'pdf' && isPdfDataUrl(value)) {
    return true;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 判断字符串是否是 base64 PDF data URL。 */
function isPdfDataUrl(value: string): boolean {
  if (!value.startsWith('data:')) {
    return false;
  }

  const commaIndex = value.indexOf(',');
  if (commaIndex === -1 || commaIndex === value.length - 1) {
    return false;
  }

  const metadata = value.slice(5, commaIndex).split(';');
  const mediaType = metadata.shift();
  return (
    mediaType?.toLowerCase() === 'application/pdf' &&
    metadata.some(part => part.toLowerCase() === 'base64')
  );
}

/** 从 ID 或元素实例解析要打印的 DOM 元素。 */
function resolvePrintableElement(printable: string | HTMLElement): HTMLElement {
  if (typeof printable !== 'string') {
    return printable;
  }

  const documentRef = getDocument();
  const element = documentRef.getElementById(printable);
  if (!element) {
    throw new PrintBridgeError(
      'INVALID_MESSAGE',
      `printable element "${printable}" was not found.`,
    );
  }

  return element;
}

/** 从 HTML 打印任务中提取渲染配置。 */
function htmlRenderOptions(
  job: PrintBridgeHtmlConfiguration & { paper?: PrintBridgePaper },
): PrintBridgeHtmlRenderOptions {
  return {
    ...(job.header === undefined ? {} : { header: job.header }),
    ...(job.headerStyle === undefined ? {} : { headerStyle: job.headerStyle }),
    ...(job.maxWidth === undefined ? {} : { maxWidth: job.maxWidth }),
    ...(job.css === undefined ? {} : { css: job.css }),
    ...(job.style === undefined ? {} : { style: job.style }),
    ...(job.ignoreElements === undefined ? {} : { ignoreElements: job.ignoreElements }),
    ...(job.documentTitle === undefined ? {} : { documentTitle: job.documentTitle }),
    ...(job.html2pdfOptions === undefined ? {} : { html2pdfOptions: job.html2pdfOptions }),
    ...(job.paper === undefined ? {} : { paper: job.paper }),
  };
}

/** 默认浏览器实现：把 HTML 暂挂到页面外，再交给 html2pdf.js 生成 PDF data URL。 */
async function defaultHtmlToPdf(
  html: string,
  options: PrintBridgeHtmlRenderOptions,
): Promise<string> {
  const documentRef = getDocument();
  const container = documentRef.createElement('div');
  const cleanupNodes: Array<HTMLElement | HTMLLinkElement | HTMLStyleElement> = [container];

  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  container.style.backgroundColor = '#fff';
  if (options.maxWidth !== undefined) {
    container.style.width = `${options.maxWidth}px`;
  }

  if (options.header) {
    const header = documentRef.createElement('div');
    header.innerHTML = options.header;
    header.setAttribute('style', options.headerStyle ?? 'font-weight: 300;');
    container.appendChild(header);
  }

  const content = documentRef.createElement('div');
  content.innerHTML = html;
  removeIgnoredElements(content, options.ignoreElements ?? []);
  container.appendChild(content);

  try {
    await appendCss(documentRef, options.css, cleanupNodes);
    appendStyle(documentRef, options.style, cleanupNodes);
    documentRef.body.appendChild(container);

    const html2pdf = await loadHtml2Pdf();
    const output = await html2pdf()
      .set(html2PdfOptions(options))
      .from(container)
      .outputPdf('datauristring');

    if (!isPdfDataUrl(output)) {
      throw new PrintBridgeError('INVALID_MESSAGE', 'html2pdf.js did not return a PDF data URL.');
    }

    return output;
  } finally {
    for (const node of cleanupNodes) {
      node.parentNode?.removeChild(node);
    }
  }
}

/** 获取浏览器 document；Node 环境应通过 htmlToPdf 注入转换器。 */
function getDocument(): Document {
  if (typeof document === 'undefined') {
    throw new PrintBridgeError('INVALID_MESSAGE', 'HTML printing requires a browser document.');
  }

  return document;
}

/** 从暂存内容里移除调用方要求忽略的元素 ID。 */
function removeIgnoredElements(root: HTMLElement, ids: string[]): void {
  for (const id of ids) {
    root.querySelector(`#${cssEscape(id)}`)?.remove();
  }
}

/** 兼容没有 CSS.escape 的运行环境。 */
function cssEscape(value: string): string {
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(value);
  }

  return value.replace(/["\\#.:,[\]>+~*^$|=]/g, '\\$&');
}

/** 把外部 CSS 文件挂到当前文档 head，并等待加载完成。 */
async function appendCss(
  documentRef: Document,
  css: string | string[] | undefined,
  cleanupNodes: Array<HTMLElement | HTMLLinkElement | HTMLStyleElement>,
): Promise<void> {
  if (!css) {
    return;
  }

  const hrefs = Array.isArray(css) ? css : [css];
  await Promise.all(
    hrefs.map(
      href =>
        new Promise<void>((resolve, reject) => {
          const link = documentRef.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          link.onload = () => resolve();
          link.onerror = () =>
            reject(new PrintBridgeError('INVALID_MESSAGE', `Failed to load CSS: ${href}`));
          cleanupNodes.push(link);
          documentRef.head.appendChild(link);
        }),
    ),
  );
}

/** 把调用方传入的内联 CSS 临时挂到当前文档 head。 */
function appendStyle(
  documentRef: Document,
  style: string | undefined,
  cleanupNodes: Array<HTMLElement | HTMLLinkElement | HTMLStyleElement>,
): void {
  if (!style) {
    return;
  }

  const styleElement = documentRef.createElement('style');
  styleElement.textContent = style;
  cleanupNodes.push(styleElement);
  documentRef.head.appendChild(styleElement);
}

/** 生成传给 html2pdf.js 的选项，纸张尺寸默认跟 Agent 打印纸张对齐。 */
function html2PdfOptions(options: PrintBridgeHtmlRenderOptions): Record<string, unknown> {
  const baseOptions: Record<string, unknown> = {
    filename: `${options.documentTitle ?? 'Document'}.pdf`,
    html2canvas: {
      scale: 2,
      useCORS: true,
    },
  };

  if (options.paper) {
    baseOptions.jsPDF = {
      unit: 'mm',
      format: [options.paper.widthMm, options.paper.heightMm],
      orientation: options.paper.widthMm > options.paper.heightMm ? 'landscape' : 'portrait',
    };
  }

  return mergeHtml2PdfOptions(baseOptions, options.html2pdfOptions ?? {});
}

/** 合并 html2pdf.js 选项，并保留默认 html2canvas/jsPDF 设置。 */
function mergeHtml2PdfOptions(
  baseOptions: Record<string, unknown>,
  overrideOptions: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...baseOptions,
    ...overrideOptions,
    html2canvas: {
      ...(isPlainObject(baseOptions.html2canvas) ? baseOptions.html2canvas : {}),
      ...(isPlainObject(overrideOptions.html2canvas) ? overrideOptions.html2canvas : {}),
    },
    jsPDF: {
      ...(isPlainObject(baseOptions.jsPDF) ? baseOptions.jsPDF : {}),
      ...(isPlainObject(overrideOptions.jsPDF) ? overrideOptions.jsPDF : {}),
    },
  };
}

/** 判断未知值是否可作为配置对象展开。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按需读取或加载浏览器侧 HTML 转 PDF 函数。 */
async function loadHtml2Pdf(): Promise<Html2PdfFactory> {
  const existing = getGlobalHtml2Pdf();
  if (existing) {
    return existing;
  }

  html2pdfLoadPromise ??= loadHtml2PdfFromCdn();
  return html2pdfLoadPromise;
}

/** 通过 CDN 加载 html2pdf.js，并返回挂到全局对象上的函数。 */
async function loadHtml2PdfFromCdn(): Promise<Html2PdfFactory> {
  await loadScript(HTML2PDF_CDN_URL);
  const html2pdf = getGlobalHtml2Pdf();
  if (!html2pdf) {
    html2pdfLoadPromise = null;
    throw new PrintBridgeError('INVALID_MESSAGE', 'html2pdf.js is not available.');
  }

  return html2pdf;
}

/** 动态加载浏览器脚本，并在加载失败时转换为 SDK 错误。 */
function loadScript(src: string): Promise<HTMLScriptElement> {
  const documentRef = getDocument();

  return new Promise((resolve, reject) => {
    const script = documentRef.createElement('script');
    script.async = true;
    script.src = src;

    script.onload = () => {
      script.onload = null;
      script.onerror = null;
      resolve(script);
    };
    script.onerror = () => {
      script.onload = null;
      script.onerror = null;
      script.parentNode?.removeChild(script);
      reject(new PrintBridgeError('INVALID_MESSAGE', `Failed to load script: ${src}`));
    };

    documentRef.head.appendChild(script);
  });
}

/** 读取页面上已存在的 html2pdf 全局函数。 */
function getGlobalHtml2Pdf(): Html2PdfFactory | null {
  const html2pdf = (globalThis as typeof globalThis & { html2pdf?: unknown }).html2pdf;
  return typeof html2pdf === 'function' ? (html2pdf as Html2PdfFactory) : null;
}
