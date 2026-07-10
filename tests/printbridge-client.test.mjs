import { EventEmitter } from 'node:events';
import { expect, test } from 'vitest';
import { PrintBridgeClient, PrintBridgeError } from '../dist/index.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class MockWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this.closeCalls = 0;
    MockWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closeCalls += 1;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: 'closed', wasClean: true });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  fail(message = 'socket failed') {
    this.onerror?.(new Error(message));
  }
}

MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;

class MockWsWebSocket extends EventEmitter {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWsWebSocket.CONNECTING;
    this.sent = [];
    MockWsWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = MockWsWebSocket.CLOSED;
    this.emit('close', 1000, Buffer.from('closed'));
  }

  open() {
    this.readyState = MockWsWebSocket.OPEN;
    this.emit('open');
  }

  message(payload) {
    this.emit('message', JSON.stringify(payload));
  }
}

function createClient(options = {}) {
  MockWebSocket.instances = [];
  return new PrintBridgeClient({
    WebSocket: MockWebSocket,
    heartbeatIntervalMs: 0,
    ...options,
  });
}

async function connectClient(options) {
  const client = createClient(options);
  const connecting = client.connect();
  const socket = MockWebSocket.instances[0];
  socket.open();
  await connecting;
  return { client, socket };
}

test('connects to configured agent ip', async () => {
  const { socket } = await connectClient({
    ip: '192.168.1.50',
  });

  expect(socket.url).toBe('ws://192.168.1.50:17890/ws');
});

test('serializes print jobs from camelCase to snake_case', async () => {
  const { client, socket } = await connectClient();

  const accepted = client.print({
    requestId: 'REQ-001',
    jobId: 'JOB-001',
    type: 'pdf',
    fileUrl: 'https://test.com/label.pdf',
    copies: 1,
    paper: {
      widthMm: 60,
      heightMm: 40,
    },
  });

  expect(socket.sent.at(-1)).toEqual({
    type: 'print',
    request_id: 'REQ-001',
    job_id: 'JOB-001',
    format: 'pdf',
    file_url: 'https://test.com/label.pdf',
    copies: 1,
    paper: {
      width_mm: 60,
      height_mm: 40,
    },
  });

  socket.message({
    type: 'job_status',
    request_id: 'REQ-001',
    job_id: 'JOB-001',
    status: 'queued',
    message: 'queued',
  });

  await expect(accepted).resolves.toEqual({
    requestId: 'REQ-001',
    jobId: 'JOB-001',
    status: 'queued',
    message: 'queued',
  });
});

test('serializes raw print jobs with dataBase64 and printerName', async () => {
  const { client, socket } = await connectClient();

  const accepted = client.print({
    requestId: 'REQ-RAW-001',
    jobId: 'JOB-RAW-001',
    type: 'raw',
    printerName: 'Zebra ZD421',
    dataBase64: 'XlhB',
  });

  expect(socket.sent.at(-1)).toEqual({
    type: 'print',
    request_id: 'REQ-RAW-001',
    job_id: 'JOB-RAW-001',
    format: 'raw',
    printer_name: 'Zebra ZD421',
    data_base64: 'XlhB',
  });

  socket.message({
    type: 'job_status',
    request_id: 'REQ-RAW-001',
    job_id: 'JOB-RAW-001',
    status: 'queued',
  });

  await expect(accepted).resolves.toMatchObject({
    requestId: 'REQ-RAW-001',
    jobId: 'JOB-RAW-001',
    status: 'queued',
  });
});

test('serializes office print jobs as file jobs', async () => {
  const { client, socket } = await connectClient();

  const accepted = client.print({
    requestId: 'REQ-DOCX-001',
    jobId: 'JOB-DOCX-001',
    type: 'docx',
    fileUrl: 'https://test.com/report.docx',
    copies: 1,
    paper: {
      widthMm: 210,
      heightMm: 297,
    },
  });

  expect(socket.sent.at(-1)).toEqual({
    type: 'print',
    request_id: 'REQ-DOCX-001',
    job_id: 'JOB-DOCX-001',
    format: 'docx',
    file_url: 'https://test.com/report.docx',
    copies: 1,
    paper: {
      width_mm: 210,
      height_mm: 297,
    },
  });

  socket.message({
    type: 'job_status',
    request_id: 'REQ-DOCX-001',
    job_id: 'JOB-DOCX-001',
    status: 'queued',
  });

  await expect(accepted).resolves.toMatchObject({
    requestId: 'REQ-DOCX-001',
    jobId: 'JOB-DOCX-001',
    status: 'queued',
  });
});

test('serializes office batch jobs', async () => {
  const { client, socket } = await connectClient();

  const pending = client.printBatch({
    requestId: 'REQ-OFFICE-BATCH',
    batchId: 'BATCH-OFFICE-001',
    jobs: [
      {
        jobId: 'XLSX-001',
        type: 'xlsx',
        fileUrl: 'https://test.com/report.xlsx',
      },
      {
        jobId: 'PPTX-001',
        type: 'pptx',
        fileUrl: 'https://test.com/slides.pptx',
      },
    ],
  });

  expect(socket.sent.at(-1)).toEqual({
    type: 'print_batch',
    request_id: 'REQ-OFFICE-BATCH',
    batch_id: 'BATCH-OFFICE-001',
    jobs: [
      {
        job_id: 'XLSX-001',
        format: 'xlsx',
        file_url: 'https://test.com/report.xlsx',
      },
      {
        job_id: 'PPTX-001',
        format: 'pptx',
        file_url: 'https://test.com/slides.pptx',
      },
    ],
  });

  socket.message({
    type: 'job_status',
    request_id: 'REQ-OFFICE-BATCH',
    job_id: 'XLSX-001',
    status: 'queued',
  });

  await expect(pending).resolves.toMatchObject({
    requestId: 'REQ-OFFICE-BATCH',
    jobId: 'XLSX-001',
    status: 'queued',
  });
});

test('rejects office data urls before sending', async () => {
  const { client, socket } = await connectClient();

  await expect(
    client.print({
      type: 'xlsx',
      fileUrl: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,AAAA',
    }),
  ).rejects.toMatchObject({
    code: 'INVALID_MESSAGE',
  });

  expect(socket.sent).toHaveLength(0);
});

test('serializes printerName for pdf jobs', async () => {
  const { client, socket } = await connectClient();

  const accepted = client.print({
    requestId: 'REQ-PDF-PRINTER',
    jobId: 'JOB-PDF-PRINTER',
    type: 'pdf',
    printerName: 'Office Printer',
    fileUrl: 'https://test.com/label.pdf',
  });

  expect(socket.sent.at(-1)).toMatchObject({
    printer_name: 'Office Printer',
  });

  socket.message({
    type: 'job_status',
    request_id: 'REQ-PDF-PRINTER',
    job_id: 'JOB-PDF-PRINTER',
    status: 'queued',
  });

  await expect(accepted).resolves.toMatchObject({ status: 'queued' });
});

test('rejects raw jobs with fileUrl paper or copies', async () => {
  const { client, socket } = await connectClient();

  await expect(
    client.print({
      type: 'raw',
      dataBase64: 'XlhB',
      fileUrl: 'https://test.com/raw.bin',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });

  await expect(
    client.print({
      type: 'raw',
      dataBase64: 'XlhB',
      copies: 2,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });

  await expect(
    client.print({
      type: 'raw',
      dataBase64: 'XlhB',
      paper: { widthMm: 60, heightMm: 40 },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });

  expect(socket.sent).toHaveLength(0);
});

test('generates requestId and jobId for print jobs when omitted', async () => {
  const { client, socket } = await connectClient();

  const accepted = client.print({
    type: 'pdf',
    fileUrl: 'https://test.com/label.pdf',
  });

  const sent = socket.sent.at(-1);
  expect(sent.request_id).toMatch(UUID_V4_REGEX);
  expect(sent.job_id).toMatch(UUID_V4_REGEX);

  socket.message({
    type: 'job_status',
    request_id: sent.request_id,
    job_id: sent.job_id,
    status: 'queued',
  });

  await expect(accepted).resolves.toMatchObject({
    requestId: sent.request_id,
    jobId: sent.job_id,
    status: 'queued',
  });
});

test('accepts pdf data URLs as print fileUrl', async () => {
  const { client, socket } = await connectClient();
  const fileUrl = 'data:application/pdf;base64,JVBERi0xLjcKJSVFT0Y=';

  const accepted = client.print({
    requestId: 'REQ-DATA-001',
    jobId: 'JOB-DATA-001',
    type: 'pdf',
    fileUrl,
  });

  expect(socket.sent.at(-1)).toMatchObject({
    type: 'print',
    request_id: 'REQ-DATA-001',
    job_id: 'JOB-DATA-001',
    format: 'pdf',
    file_url: fileUrl,
  });

  socket.message({
    type: 'job_status',
    request_id: 'REQ-DATA-001',
    job_id: 'JOB-DATA-001',
    status: 'queued',
  });

  await expect(accepted).resolves.toMatchObject({
    requestId: 'REQ-DATA-001',
    jobId: 'JOB-DATA-001',
    status: 'queued',
  });
});

test('serializes HTML print jobs for Agent rendering', async () => {
  const { client, socket } = await connectClient();

  const accepted = client.print({
    requestId: 'REQ-HTML-001',
    jobId: 'JOB-HTML-001',
    type: 'html',
    fileUrl: 'https://test.com/label.html',
    waitMs: 1500,
    copies: 1,
    paper: { widthMm: 210, heightMm: 297 },
  });

  expect(socket.sent.at(-1)).toEqual({
    type: 'print',
    request_id: 'REQ-HTML-001',
    job_id: 'JOB-HTML-001',
    format: 'html',
    file_url: 'https://test.com/label.html',
    wait_ms: 1500,
    copies: 1,
    paper: { width_mm: 210, height_mm: 297 },
  });

  socket.message({
    type: 'job_status',
    request_id: 'REQ-HTML-001',
    job_id: 'JOB-HTML-001',
    status: 'queued',
  });

  await expect(accepted).resolves.toMatchObject({ status: 'queued' });
});

test('serializes raw HTML print jobs for Agent rendering', async () => {
  const { client, socket } = await connectClient();

  const accepted = client.print({
    requestId: 'REQ-RAW-HTML-001',
    jobId: 'JOB-RAW-HTML-001',
    type: 'raw-html',
    html: '<main>Label</main>',
    waitMs: 1000,
  });

  expect(socket.sent.at(-1)).toEqual({
    type: 'print',
    request_id: 'REQ-RAW-HTML-001',
    job_id: 'JOB-RAW-HTML-001',
    format: 'raw-html',
    html: '<main>Label</main>',
    wait_ms: 1000,
  });

  socket.message({
    type: 'job_status',
    request_id: 'REQ-RAW-HTML-001',
    job_id: 'JOB-RAW-HTML-001',
    status: 'queued',
  });

  await expect(accepted).resolves.toMatchObject({ status: 'queued' });
});

test('serializes HTML jobs in batches for Agent rendering', async () => {
  const { client, socket } = await connectClient();

  const accepted = client.printBatch({
    requestId: 'REQ-HTML-BATCH-001',
    batchId: 'BATCH-HTML-001',
    jobs: [
      {
        jobId: 'JOB-HTML-BATCH-001',
        type: 'html',
        fileUrl: 'https://test.com/label.html',
        waitMs: 0,
      },
      {
        jobId: 'JOB-RAW-HTML-BATCH-001',
        type: 'raw-html',
        html: '<main>Batch label</main>',
        waitMs: 30000,
      },
    ],
  });

  expect(socket.sent.at(-1)).toEqual({
    type: 'print_batch',
    request_id: 'REQ-HTML-BATCH-001',
    batch_id: 'BATCH-HTML-001',
    jobs: [
      {
        job_id: 'JOB-HTML-BATCH-001',
        format: 'html',
        file_url: 'https://test.com/label.html',
        wait_ms: 0,
      },
      {
        job_id: 'JOB-RAW-HTML-BATCH-001',
        format: 'raw-html',
        html: '<main>Batch label</main>',
        wait_ms: 30000,
      },
    ],
  });

  socket.message({
    type: 'job_status',
    request_id: 'REQ-HTML-BATCH-001',
    job_id: 'JOB-HTML-BATCH-001',
    status: 'queued',
  });

  await expect(accepted).resolves.toMatchObject({ status: 'queued' });
});

test('rejects invalid HTML job field combinations and waitMs values', async () => {
  const { client, socket } = await connectClient();

  for (const job of [
    { type: 'html', fileUrl: 'https://test.com/label.html', html: '<main>Label</main>' },
    { type: 'raw-html', html: '<main>Label</main>', fileUrl: 'https://test.com/label.html' },
    { type: 'raw-html', html: ' ' },
    { type: 'html', fileUrl: 'https://test.com/label.html', waitMs: -1 },
    { type: 'html', fileUrl: 'https://test.com/label.html', waitMs: 30001 },
  ]) {
    await expect(client.print(job)).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
  }

  expect(socket.sent).toHaveLength(0);
});

test('rejects HTML jobs with non-HTTP(S) fileUrl', async () => {
  const { client, socket } = await connectClient();

  await expect(
    client.print({
      type: 'html',
      fileUrl: 'data:text/html,<main>Label</main>',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });

  expect(socket.sent).toHaveLength(0);
});

test('rejects HTML jobs with a non-integer waitMs', async () => {
  const { client, socket } = await connectClient();

  await expect(
    client.print({
      type: 'raw-html',
      html: '<main>Label</main>',
      waitMs: 1000.5,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });

  expect(socket.sent).toHaveLength(0);
});

test('emits status events for job_status messages', async () => {
  const { client, socket } = await connectClient();
  const statuses = [];
  client.on('status', event => statuses.push(event));

  socket.message({
    type: 'job_status',
    request_id: 'REQ-002',
    job_id: 'JOB-002',
    status: 'printing',
    message: 'printing',
  });

  expect(statuses).toEqual([
    {
      requestId: 'REQ-002',
      jobId: 'JOB-002',
      status: 'printing',
      message: 'printing',
    },
  ]);
});

test('rejects pending print when Agent returns an error', async () => {
  const { client, socket } = await connectClient();

  const pending = client.print({
    requestId: 'REQ-003',
    jobId: 'JOB-003',
    type: 'image',
    fileUrl: 'https://test.com/label.png',
  });

  socket.message({
    type: 'error',
    request_id: 'REQ-003',
    error_code: 'PRINTER_NOT_CONFIGURED',
    message: 'Default printer is not configured.',
  });

  const error = await pending.catch(error => error);

  expect(error).toBeInstanceOf(PrintBridgeError);
  expect(error).toMatchObject({
    code: 'PRINTER_NOT_CONFIGURED',
    requestId: 'REQ-003',
    message: 'Default printer is not configured.',
  });
});

test('validates print input before sending', async () => {
  const { client, socket } = await connectClient();

  await expect(
    client.print({
      jobId: 'JOB-004',
      type: 'gif',
      fileUrl: 'ftp://test.com/label.gif',
      copies: 0,
      paper: {
        widthMm: 0,
        heightMm: -1,
      },
    }),
  ).rejects.toThrow(/type is unsupported/);

  expect(socket.sent).toHaveLength(0);
});

test('times out connect when WebSocket does not open', async () => {
  const client = createClient({ connectTimeoutMs: 5 });

  const error = await client.connect().catch(error => error);

  expect(error).toBeInstanceOf(PrintBridgeError);
  expect(error).toMatchObject({
    code: 'CONNECTION_TIMEOUT',
  });

  expect(client.isConnected()).toBe(false);
});

test('serializes batch jobs', async () => {
  const { client, socket } = await connectClient();

  const pending = client.printBatch({
    requestId: 'REQ-005',
    batchId: 'BATCH-001',
    jobs: [
      {
        jobId: 'A-001',
        type: 'image',
        fileUrl: 'https://test.com/a.png',
        copies: 10,
      },
      {
        jobId: 'B-001',
        type: 'image',
        fileUrl: 'https://test.com/b.jpg',
        copies: 20,
      },
    ],
  });

  expect(socket.sent.at(-1)).toEqual({
    type: 'print_batch',
    request_id: 'REQ-005',
    batch_id: 'BATCH-001',
    jobs: [
      {
        job_id: 'A-001',
        format: 'image',
        file_url: 'https://test.com/a.png',
        copies: 10,
      },
      {
        job_id: 'B-001',
        format: 'image',
        file_url: 'https://test.com/b.jpg',
        copies: 20,
      },
    ],
  });

  socket.message({
    type: 'job_status',
    request_id: 'REQ-005',
    job_id: 'A-001',
    status: 'queued',
    message: 'queued',
  });

  await expect(pending).resolves.toEqual({
    requestId: 'REQ-005',
    jobId: 'A-001',
    status: 'queued',
    message: 'queued',
  });
});

test('generates requestId and batchId for batch jobs when omitted', async () => {
  const { client, socket } = await connectClient();

  const pending = client.printBatch({
    jobs: [
      {
        jobId: 'A-Generated-Batch',
        type: 'image',
        fileUrl: 'https://test.com/a.png',
      },
    ],
  });

  const sent = socket.sent.at(-1);
  expect(sent.request_id).toMatch(UUID_V4_REGEX);
  expect(sent.batch_id).toMatch(UUID_V4_REGEX);
  expect(sent.jobs[0].job_id).toBe('A-Generated-Batch');

  socket.message({
    type: 'job_status',
    request_id: sent.request_id,
    job_id: sent.jobs[0].job_id,
    status: 'queued',
  });

  await expect(pending).resolves.toMatchObject({
    requestId: sent.request_id,
    jobId: sent.jobs[0].job_id,
    status: 'queued',
  });
});

test('resolves ping with pong message', async () => {
  const { client, socket } = await connectClient();

  const pending = client.ping();
  const sent = socket.sent.at(-1);
  expect(sent.type).toBe('ping');
  expect(typeof sent.time).toBe('number');

  socket.message({
    type: 'pong',
    time: sent.time,
    agent_status: 'ready',
  });

  await expect(pending).resolves.toEqual({
    time: sent.time,
    agentStatus: 'ready',
  });
});

test('gets printers list over WebSocket', async () => {
  const { client, socket } = await connectClient();

  const pending = client.getPrintersList();
  const sent = socket.sent.at(-1);
  expect(sent.type).toBe('get_printers_list');
  expect(sent.request_id).toMatch(UUID_V4_REGEX);

  socket.message({
    type: 'printers_list',
    request_id: sent.request_id,
    printers: [
      {
        name: 'Zebra ZD421',
        is_default: true,
        dpi: 203,
        port: 'usb://Zebra/ZD421',
        is_local: true,
        is_network: false,
        is_virtual: false,
      },
    ],
  });

  await expect(pending).resolves.toEqual([
    {
      name: 'Zebra ZD421',
      isDefault: true,
      dpi: 203,
      port: 'usb://Zebra/ZD421',
      isLocal: true,
      isNetwork: false,
      isVirtual: false,
    },
  ]);
});

test('gets printer info over WebSocket', async () => {
  const { client, socket } = await connectClient();

  const pending = client.getPrinterInfo('Zebra ZD421');
  const sent = socket.sent.at(-1);
  expect(sent).toMatchObject({
    type: 'get_printer_info',
    printer_name: 'Zebra ZD421',
  });
  expect(sent.request_id).toMatch(UUID_V4_REGEX);

  socket.message({
    type: 'printer_info',
    request_id: sent.request_id,
    printer: {
      name: 'Zebra ZD421',
      is_default: true,
      dpi: 203,
      port: 'usb://Zebra/ZD421',
      is_local: true,
      is_network: false,
      is_virtual: false,
      papers: [
        {
          id: 'label_60x40',
          name: '60x40',
          width_mm: 60,
          height_mm: 40,
        },
      ],
      trays: [
        {
          id: 'tray-1',
          name: 'Tray 1',
        },
      ],
      media_types: [
        {
          id: 'thermal-label',
          name: 'Thermal Label',
        },
      ],
    },
  });

  await expect(pending).resolves.toEqual({
    name: 'Zebra ZD421',
    isDefault: true,
    dpi: 203,
    port: 'usb://Zebra/ZD421',
    isLocal: true,
    isNetwork: false,
    isVirtual: false,
    papers: [
      {
        id: 'label_60x40',
        name: '60x40',
        widthMm: 60,
        heightMm: 40,
      },
    ],
    trays: [
      {
        id: 'tray-1',
        name: 'Tray 1',
      },
    ],
    mediaTypes: [
      {
        id: 'thermal-label',
        name: 'Thermal Label',
      },
    ],
  });
});

test('gets print queue over WebSocket', async () => {
  const { client, socket } = await connectClient();

  const pending = client.getPrintQueue();
  const sent = socket.sent.at(-1);
  expect(sent.type).toBe('get_print_queue');
  expect(sent.request_id).toMatch(UUID_V4_REGEX);

  socket.message({
    type: 'print_queue',
    request_id: sent.request_id,
    jobs: [
      {
        request_id: 'REQ-QUEUE-001',
        job_id: 'JOB-QUEUE-001',
        status: 'printing',
        message: 'printing',
      },
    ],
  });

  await expect(pending).resolves.toEqual([
    {
      requestId: 'REQ-QUEUE-001',
      jobId: 'JOB-QUEUE-001',
      status: 'printing',
      message: 'printing',
    },
  ]);
});

test('supports ws-style event API', async () => {
  MockWsWebSocket.instances = [];
  const client = new PrintBridgeClient({
    WebSocket: MockWsWebSocket,
    heartbeatIntervalMs: 0,
  });

  const connecting = client.connect();
  const socket = MockWsWebSocket.instances[0];
  socket.open();
  await connecting;

  const statuses = [];
  client.on('status', event => statuses.push(event));

  socket.message({
    type: 'job_status',
    request_id: 'REQ-006',
    job_id: 'JOB-006',
    status: 'submitted',
    message: 'submitted to system print queue',
  });

  expect(statuses).toEqual([
    {
      requestId: 'REQ-006',
      jobId: 'JOB-006',
      status: 'submitted',
      message: 'submitted to system print queue',
    },
  ]);
});

test('emits completed status events', async () => {
  const { client, socket } = await connectClient();
  const events = [];
  client.on('status', event => events.push(event));

  socket.message({
    type: 'job_status',
    request_id: 'REQ-001',
    job_id: 'JOB-001',
    status: 'completed',
    message: 'system queue completed',
  });

  expect(events.at(-1)).toEqual({
    requestId: 'REQ-001',
    jobId: 'JOB-001',
    status: 'completed',
    message: 'system queue completed',
  });
});

test('emits unknown status events', async () => {
  const { client, socket } = await connectClient();
  const events = [];
  client.on('status', event => events.push(event));

  socket.message({
    type: 'job_status',
    request_id: 'REQ-001',
    job_id: 'JOB-001',
    status: 'unknown',
    message: 'platform did not expose a job id',
  });

  expect(events.at(-1)).toEqual({
    requestId: 'REQ-001',
    jobId: 'JOB-001',
    status: 'unknown',
    message: 'platform did not expose a job id',
  });
});
