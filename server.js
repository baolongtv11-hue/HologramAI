import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DIST = resolve(ROOT, 'dist');
const IS_API_ONLY = process.argv.includes('--api-only');
const PORT = Number(IS_API_ONLY ? (process.env.API_PORT || 8787) : (process.env.PORT || 8080));
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const rateBuckets = new Map();
function rateLimit(req, key, limit, windowMs) {
  const now = Date.now();
  const ip = req.socket.remoteAddress || 'unknown';
  const bucketKey = `${key}:${ip}`;
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(bucketKey, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

async function readRequestBody(req, maxBytes = 4_096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request body quá lớn.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const liveConfig = {
  systemInstruction: {
    parts: [{ text: 'Bạn là trợ lý AI Hologram. Luôn trả lời bằng tiếng Việt tự nhiên, rõ ràng và súc tích. Nghe người dùng liên tục, không yêu cầu họ nhấn nút sau mỗi câu. Khi người dùng yêu cầu tìm hoặc mở video, chỉ xác nhận ngắn gọn rằng bạn đang tìm video phù hợp.' }]
  },
  responseModalities: ['AUDIO'],
  speechConfig: {
    voiceConfig: {
      prebuiltVoiceConfig: { voiceName: 'Aoede' }
    }
  },
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  realtimeInputConfig: {
    automaticActivityDetection: { disabled: false }
  }
};

async function createLiveToken() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'PASTE_YOUR_GEMINI_API_KEY_HERE') {
    const error = new Error('Backend chưa được cấu hình GEMINI_API_KEY trong file .env.');
    error.statusCode = 503;
    throw error;
  }

  // Ephemeral token được tạo ở server; trình duyệt không bao giờ nhận API key gốc.
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: 'v1alpha' }
  });

  const now = Date.now();
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      liveConnectConstraints: {
        model: LIVE_MODEL,
        config: liveConfig
      }
    }
  });

  if (!token?.name) throw new Error('Gemini không trả về ephemeral token hợp lệ.');
  return {
    token: token.name,
    model: LIVE_MODEL,
    expiresInSeconds: 1_800,
    newSessionExpiresInSeconds: 60
  };
}

async function searchYouTube(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    const error = new Error('Chưa cấu hình YOUTUBE_API_KEY trong file .env.');
    error.statusCode = 503;
    throw error;
  }
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.search = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    safeSearch: 'moderate',
    maxResults: '1',
    q: query,
    key: apiKey
  }).toString();

  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || `HTTP ${response.status}`;
    const error = new Error(`YouTube API không chấp nhận yêu cầu (${reason}).`);
    error.statusCode = response.status === 403 ? 502 : response.status;
    throw error;
  }

  const item = data.items?.[0];
  if (!item?.id?.videoId) return null;
  return {
    videoId: item.id.videoId,
    title: item.snippet?.title || 'Video YouTube',
    channelTitle: item.snippet?.channelTitle || ''
  };
}

async function serveStatic(req, res, pathname) {
  if (IS_API_ONLY) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  let requestedPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  requestedPath = normalize(requestedPath).replace(/^([.][.][/\\])+/, '');
  const filePath = resolve(DIST, `.${requestedPath}`);
  if (filePath !== DIST && !filePath.startsWith(DIST + sep)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable'
    });
    res.end(content);
  } catch {
    if (!extname(pathname)) {
      try {
        const html = await readFile(join(DIST, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
        return;
      } catch {
        sendJson(res, 503, { error: 'Chưa build giao diện. Hãy chạy npm run build.' });
        return;
      }
    }
    sendJson(res, 404, { error: 'Không tìm thấy tệp.' });
  }
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      model: LIVE_MODEL,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'PASTE_YOUR_GEMINI_API_KEY_HERE'),
      youtubeConfigured: Boolean(process.env.YOUTUBE_API_KEY)
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/live-token') {
    if (!rateLimit(req, 'live-token', 8, 60_000)) {
      sendJson(res, 429, { error: 'Quá nhiều yêu cầu cấp token. Hãy thử lại sau một phút.' });
      return;
    }
    try {
      await readRequestBody(req);
      sendJson(res, 200, await createLiveToken());
    } catch (error) {
      console.error('[live-token]', error);
      sendJson(res, error.statusCode || 502, { error: error.message || 'Không thể tạo phiên Gemini Live.' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/youtube-search') {
    if (!rateLimit(req, 'youtube-search', 30, 60_000)) {
      sendJson(res, 429, { error: 'Bạn tìm video quá nhanh. Hãy thử lại sau.' });
      return;
    }
    const query = (requestUrl.searchParams.get('q') || '').trim().slice(0, 160);
    if (query.length < 2) {
      sendJson(res, 400, { error: 'Từ khóa tìm video quá ngắn.' });
      return;
    }
    try {
      const result = await searchYouTube(query);
      sendJson(res, 200, { result });
    } catch (error) {
      console.error('[youtube-search]', error);
      sendJson(res, error.statusCode || 502, { error: error.message || 'Không thể tìm video YouTube.' });
    }
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'API route không tồn tại.' });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  await serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hologram API listening on http://localhost:${PORT}`);
  if (!IS_API_ONLY) console.log('Serving production build from ./dist');
});
