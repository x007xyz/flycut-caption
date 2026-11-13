// Reference FlyCut Provider Protocol v1 HTTP server implementing TTS capabilities.
// Usage: node scripts/examples/tts-provider-server.mjs --port 9053 [--token your-key]
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SAMPLE_RATE = 24000;

function synthesizeSineWav(text, speed = 1, baseFreq = 330) {
  const duration = Math.max(0.25, Math.min(8, (text.length * 0.08) / Math.max(0.25, speed)));
  const samples = Math.round(duration * SAMPLE_RATE);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const env = Math.min(1, i / 400, (samples - i) / 400);
    const sample = Math.sin((2 * Math.PI * baseFreq * i) / SAMPLE_RATE) * 0.25 * env;
    buf.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return { buf, duration };
}

const MODELS = [
  {
    id: 'kokoro-demo',
    name: 'Kokoro Reference (Demo)',
    role: 'tts',
    description: '示例固定音色 TTS（不支持声音克隆）',
    languages: ['zh', 'en'],
    status: 'ready',
    tts: {
      voices: [
        { id: 'zf_xiaobei', name: '晓北 (ZH)', languages: ['zh'], gender: 'female' },
        { id: 'af_heart', name: 'Heart (EN)', languages: ['en'], gender: 'female' },
      ],
      voiceCloning: false,
      durationControl: true,
      streaming: false,
      outputFormats: ['wav'],
    },
    options: {
      pitch: { type: 'number', label: '音高偏移', default: 0, min: -6, max: 6, step: 1 },
    },
  },
  {
    id: 'cosyvoice-demo',
    name: 'CosyVoice Clone Reference (Demo)',
    role: 'tts',
    description: '示例授权声音克隆 TTS',
    languages: ['zh', 'en'],
    status: 'ready',
    tts: {
      voices: [{ id: 'default_zh', name: '默认中文音色', languages: ['zh'] }],
      voiceCloning: true,
      cloningTerms: '参考音频仅用于本次合成测试，请求结束后即从内存释放。',
      maxReferenceSeconds: 15,
      durationControl: true,
      streaming: false,
      outputFormats: ['wav'],
    },
  },
];

export function startExampleTtsServer({ port = 0, host = '127.0.0.1', token } = {}) {
  const jobs = new Map();
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    if (token && req.headers.authorization !== 'Bearer ' + token) {
      return json(res, 401, { error: 'Unauthorized: invalid or missing API key' });
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return json(res, 200, {
        protocol: 'flycut-provider',
        version: 1,
        name: 'FlyCut TTS Reference Server',
        capabilities: ['tts'],
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, { models: MODELS });
    }
    if (req.method === 'POST' && url.pathname === '/v1/tts/jobs') {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] ?? '';

      let params;
      let cloned = false;
      if (contentType.startsWith('audio/wav')) {
        try {
          params = JSON.parse(String(req.headers['x-flycut-tts-request'] ?? '{}'));
        } catch {
          return json(res, 400, { error: 'Invalid X-Flycut-TTS-Request header JSON' });
        }
        cloned = true;
      } else {
        try {
          params = JSON.parse(body.toString('utf8'));
        } catch {
          return json(res, 400, { error: 'Invalid JSON request body' });
        }
      }

      const model = MODELS.find(m => m.id === params.model);
      if (!model) return json(res, 404, { error: 'Unknown TTS model: ' + params.model });
      if (!params.text || typeof params.text !== 'string' || !params.text.trim()) {
        return json(res, 400, { error: 'Missing required text field' });
      }
      if (cloned) {
        if (!model.tts.voiceCloning) {
          return json(res, 400, { error: 'Model ' + model.id + ' does not support voice cloning' });
        }
        if (!params.authorization?.confirmed || !params.authorization?.statement) {
          return json(res, 403, { error: 'Voice cloning requires confirmed speaker authorization' });
        }
        if (body.byteLength < 44 || body.subarray(0, 4).toString('ascii') !== 'RIFF') {
          return json(res, 400, { error: 'Reference audio must be a valid WAV file' });
        }
      }

      const id = randomUUID();
      const pitchOffset = Number(params.options?.pitch ?? 0) * 18;
      const { buf, duration } = synthesizeSineWav(params.text, Number(params.speed ?? 1), (cloned ? 440 : 330) + pitchOffset);
      jobs.set(id, {
        id,
        status: 'complete',
        audio: buf,
        result: {
          audioUrl: '/v1/jobs/' + id + '/audio',
          mimeType: 'audio/wav',
          format: 'wav',
          durationSeconds: Number(duration.toFixed(3)),
          sampleRate: SAMPLE_RATE,
        },
      });
      return json(res, 202, { id });
    }

    const jobMatch = /^\/v1\/jobs\/([^/]+)(\/audio|\/cancel)?$/.exec(url.pathname);
    if (jobMatch) {
      const job = jobs.get(decodeURIComponent(jobMatch[1]));
      if (!job) return json(res, 404, { error: 'Job not found' });
      if (req.method === 'GET' && !jobMatch[2]) {
        return json(res, 200, { id: job.id, status: job.status, progress: 100, result: job.result });
      }
      if (req.method === 'GET' && jobMatch[2] === '/audio') {
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': job.audio.byteLength });
        res.end(job.audio);
        return;
      }
      if (req.method === 'POST' && jobMatch[2] === '/cancel') {
        job.status = 'cancelled';
        return json(res, 200, { id: job.id, status: 'cancelled' });
      }
    }

    return json(res, 404, { error: 'Not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        url: 'http://' + host + ':' + addr.port,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const idx = args.indexOf('--' + name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const port = Number(flag('port') ?? 9053);
  const token = flag('token');
  const started = await startExampleTtsServer({ port, token });
  console.log('FlyCut TTS Reference Server listening on ' + started.url + (token ? ' (Bearer auth enabled)' : ''));
}
