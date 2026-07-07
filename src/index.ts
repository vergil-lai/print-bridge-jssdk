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
const VALID_JOB_TYPES = new Set<PrintBridgeJobType>(['pdf', 'image', 'raw']);

type AgentPrintableType = 'pdf' | 'image' | 'raw';

interface AgentPrintableJob {
  jobId: string;
  type: AgentPrintableType;
  printerName?: string;
  fileUrl?: string;
  dataBase64?: string;
  copies?: number;
  paper?: PrintBridgePaper;
}

function mapPrinter(printer: {
  name: string;
  is_default?: boolean;
  dpi?: number | null;
  port?: string | null;
  is_local?: boolean | null;
  is_network?: boolean | null;
  is_virtual?: boolean | null;
}): PrintBridgePrinter {
  const mapped: PrintBridgePrinter = {
    name: printer.name,
    isDefault: printer.is_default,
  };

  if ('dpi' in printer) mapped.dpi = printer.dpi;
  if ('port' in printer) mapped.port = printer.port;
  if ('is_local' in printer) mapped.isLocal = printer.is_local;
  if ('is_network' in printer) mapped.isNetwork = printer.is_network;
  if ('is_virtual' in printer) mapped.isVirtual = printer.is_virtual;

  return mapped;
}

interface AgentPrintOptions extends AgentPrintableJob {
  requestId: string;
}

interface AgentBatchOptions {
  requestId: string;
  batchId: string;
  jobs: AgentPrintableJob[];
}

type ResolvedPrintBridgeJob = PrintBridgeJob & {
  jobId: string;
};

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
  private readonly options: Required<Omit<PrintBridgeClientOptions, 'WebSocket' | 'ip'>> & {
    WebSocket?: WebSocketConstructorLike;
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
    const printableJob = jobToAgentJob(withJobId(job));

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
    const printableJobs = batch.jobs.map(job => jobToAgentJob(withJobId(job)));

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
      this.resolvePendingRequest(message.request_id, message.printers.map(mapPrinter));
      return;
    }

    if (message.type === 'printer_info') {
      this.resolvePendingRequest(message.request_id, {
        ...mapPrinter(message.printer),
        papers: message.printer.papers.map(paper => ({
          id: paper.id,
          name: paper.name,
          widthMm: paper.width_mm,
          heightMm: paper.height_mm,
        })),
        trays: message.printer.trays ?? [],
        mediaTypes: message.printer.media_types ?? [],
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
}

/** 把 SDK 任务转换为 Agent 协议任务。 */
function jobToAgentJob(job: ResolvedPrintBridgeJob): AgentPrintableJob {
  if (job.type === 'raw') {
    return {
      jobId: job.jobId,
      type: job.type,
      printerName: job.printerName,
      dataBase64: job.dataBase64,
    };
  }

  return {
    jobId: job.jobId,
    type: job.type,
    printerName: job.printerName,
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
    ...(job.printerName === undefined ? {} : { printer_name: job.printerName }),
    ...(job.fileUrl === undefined ? {} : { file_url: job.fileUrl }),
    ...(job.dataBase64 === undefined ? {} : { data_base64: job.dataBase64 }),
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
      ...(job.printerName === undefined ? {} : { printer_name: job.printerName }),
      ...(job.fileUrl === undefined ? {} : { file_url: job.fileUrl }),
      ...(job.dataBase64 === undefined ? {} : { data_base64: job.dataBase64 }),
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

  if (job.type === 'raw') {
    if (!job.dataBase64 || job.dataBase64.trim().length === 0) {
      throw new PrintBridgeError('INVALID_MESSAGE', 'dataBase64 is required.');
    }

    if ('fileUrl' in job && job.fileUrl !== undefined) {
      throw new PrintBridgeError('INVALID_MESSAGE', 'raw jobs do not accept fileUrl.');
    }

    if ('copies' in job && job.copies !== undefined) {
      throw new PrintBridgeError('INVALID_MESSAGE', 'raw jobs do not accept copies.');
    }

    if ('paper' in job && job.paper !== undefined) {
      throw new PrintBridgeError('INVALID_MESSAGE', 'raw jobs do not accept paper.');
    }

    return;
  }

  if (job.type === 'pdf' || job.type === 'image') {
    if (!isPrintableFileUrl(job.fileUrl, job.type)) {
      throw new PrintBridgeError(
        'INVALID_MESSAGE',
        'fileUrl must be an http, https, or PDF data URL.',
      );
    }
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

  return isHttpUrl(value);
}

/** 判断字符串是否是 HTTP(S) URL。 */
function isHttpUrl(value: string): boolean {
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
