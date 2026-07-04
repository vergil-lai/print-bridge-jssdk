import { PrintBridgeClient } from '../dist/index.js';

const pdfUrl =
  'https://raw.githubusercontent.com/vergil-lai/print-bridge-jssdk/main/examples/assets/printbridge-a4-sample.pdf';
const jpgUrl =
  'https://raw.githubusercontent.com/vergil-lai/print-bridge-jssdk/main/examples/assets/printbridge-a4-sample.jpg';

const client = new PrintBridgeClient({
  ip: '127.0.0.1',
  port: 17890,
});

client.on('status', event => {
  console.log('status', event);
});

client.on('error', error => {
  console.error('agent error', {
    code: error.code,
    message: error.message,
    requestId: error.requestId,
  });
});

try {
  await client.connect();
  console.log('connected');

  const pdfAccepted = await client.print({
    requestId: 'NODE-EXAMPLE-PDF-001',
    jobId: 'NODE-EXAMPLE-PDF-JOB-001',
    type: 'pdf',
    fileUrl: pdfUrl,
    copies: 1,
    paper: {
      widthMm: 210,
      heightMm: 297,
    },
  });
  console.log('pdf queued', pdfAccepted);

  const jpgAccepted = await client.print({
    requestId: 'NODE-EXAMPLE-JPG-001',
    jobId: 'NODE-EXAMPLE-JPG-JOB-001',
    type: 'image',
    fileUrl: jpgUrl,
    copies: 1,
    paper: {
      widthMm: 210,
      heightMm: 297,
    },
  });
  console.log('jpg queued', jpgAccepted);
} finally {
  client.disconnect();
}
