import { GoogleGenAI, Modality } from '@google/genai';

const LIVE_MODEL_FALLBACK = 'gemini-3.8-live';
const AUDIO_INPUT_RATE = 16_000;
const AUDIO_OUTPUT_RATE = 24_000;
const MIRROR_MODES = ['none', 'vertical', 'horizontal', 'both'];
const STORAGE_KEY_MIRROR = 'hologram_mirror_v2';

const LIVE_CONFIG = {
  systemInstruction: {
    parts: [{ text: 'Bạn là trợ lý AI Hologram. Luôn trả lời bằng tiếng Việt tự nhiên, rõ ràng và súc tích. Nghe người dùng liên tục, không yêu cầu họ nhấn nút sau mỗi câu. Khi người dùng yêu cầu tìm hoặc mở video, chỉ xác nhận ngắn gọn rằng bạn đang tìm video phù hợp.' }]
  },
  responseModalities: [Modality.AUDIO],
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

const byId = (id) => document.getElementById(id);
const dom = {
  stageContent: byId('stage-content'),
  orbContainer: byId('orb-container'),
  orbCanvas: byId('orb-canvas'),
  textContainer: byId('text-container'),
  textHeading: byId('text-heading'),
  textBody: byId('text-body'),
  videoLayer: byId('video-layer'),
  subtitleText: byId('subtitle-text'),
  videoTitle: byId('video-title'),
  stateIndicator: byId('state-indicator'),
  stateLabel: byId('state-label'),
  statusBar: byId('status-bar'),
  btnMic: byId('btn-mic'),
  btnStop: byId('btn-stop'),
  btnMirror: byId('btn-mirror'),
  btnSettings: byId('btn-settings'),
  controlsRight: byId('controls-right'),
  bottomSheet: byId('bottom-sheet'),
  bottomSheetBackdrop: byId('bottom-sheet-backdrop'),
  selectMirror: byId('select-mirror'),
  btnSheetCancel: byId('btn-sheet-cancel'),
  btnSheetSave: byId('btn-sheet-save'),
  sheetError: byId('sheet-error'),
  connectionDetail: byId('connection-detail'),
  orientationOverlay: byId('orientation-overlay'),
  toast: byId('toast'),
  transitionVeil: byId('transition-veil')
};

const state = {
  status: 'idle',
  micActive: false,
  connected: false,
  liveSession: null,
  audioContext: null,
  mediaStream: null,
  mediaSource: null,
  captureNode: null,
  silentGain: null,
  workletReady: null,
  activePlaybackSources: new Set(),
  nextPlaybackTime: 0,
  playbackTurnFinished: false,
  generation: 0,
  manualClose: false,
  mirrorMode: readStoredMirror(),
  isPortrait: false,
  lastInputTranscript: '',
  videoTranscriptTimer: null,
  lastVideoQuery: '',
  videoSearchInProgress: false,
  controlsTimer: null,
  toastTimer: null,
  health: null
};

function readStoredMirror() {
  try {
    const value = localStorage.getItem(STORAGE_KEY_MIRROR);
    return MIRROR_MODES.includes(value) ? value : 'vertical';
  } catch {
    return 'vertical';
  }
}

const UI = {
  showToast(message, duration = 3_500) {
    dom.toast.textContent = String(message || 'Đã xảy ra lỗi.');
    dom.toast.classList.add('show');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => dom.toast.classList.remove('show'), duration);
  },

  setStatus(status, detail = '') {
    state.status = status;
    dom.stateIndicator.className = '';
    dom.stateIndicator.classList.add(status);
    const labels = {
      idle: 'Chờ',
      connecting: 'Đang kết nối',
      listening: 'Đang nghe',
      thinking: 'Đang xử lý',
      speaking: 'Đang nói',
      error: 'Lỗi'
    };
    dom.stateLabel.textContent = detail || labels[status] || 'Chờ';
    OrbEngine.setState(status);
    const progress = {
      idle: 0,
      connecting: 24,
      listening: 38,
      thinking: 68,
      speaking: 100,
      error: 100
    };
    dom.statusBar.style.width = `${progress[status] ?? 0}%`;
  },

  showOrb() {
    dom.orbContainer.classList.remove('hidden');
    dom.textContainer.classList.remove('visible');
  },

  hideOrb() {
    dom.orbContainer.classList.add('hidden');
  },

  showText(heading, body) {
    this.hideOrb();
    dom.textHeading.textContent = heading || '';
    dom.textBody.textContent = body || '';
    const length = (body || '').length;
    dom.textBody.className = 'body';
    if (length < 90) dom.textBody.classList.add('large');
    else if (length > 360) dom.textBody.classList.add('small');
    dom.textContainer.classList.add('visible');
  },

  showVideo(title) {
    dom.videoTitle.textContent = title || '';
    dom.videoLayer.classList.add('active');
    dom.videoLayer.setAttribute('aria-hidden', 'false');
    dom.textContainer.classList.remove('visible');
    dom.subtitleText.classList.add('visible');
  },

  hideVideo() {
    dom.videoLayer.classList.remove('active');
    dom.videoLayer.setAttribute('aria-hidden', 'true');
    dom.subtitleText.classList.remove('visible');
    dom.subtitleText.textContent = '';
    dom.videoTitle.textContent = '';
    VideoEngine.stop();
    if (!state.micActive && state.status === 'idle') this.showOrb();
  },

  setSubtitle(text) {
    dom.subtitleText.textContent = text || '';
    dom.subtitleText.classList.toggle('visible', Boolean(text));
  },

  showSettings() {
    dom.selectMirror.value = state.mirrorMode;
    dom.sheetError.textContent = '';
    dom.bottomSheet.classList.add('active');
    dom.bottomSheetBackdrop.classList.add('active');
    dom.bottomSheet.setAttribute('aria-hidden', 'false');
  },

  hideSettings() {
    dom.bottomSheet.classList.remove('active');
    dom.bottomSheetBackdrop.classList.remove('active');
    dom.bottomSheet.setAttribute('aria-hidden', 'true');
  },

  applyMirror() {
    const transforms = {
      none: 'none',
      vertical: 'scaleX(-1)',
      horizontal: 'scaleY(-1)',
      both: 'scale(-1, -1)'
    };
    dom.stageContent.style.transform = transforms[state.mirrorMode] || 'none';
  },

  setMicButton(active, busy = false) {
    dom.btnMic.classList.toggle('active', active);
    dom.btnMic.setAttribute('aria-pressed', String(active));
    dom.btnMic.setAttribute('aria-label', active ? 'Tắt microphone' : 'Bật microphone');
    dom.btnMic.disabled = busy;
  }
};

const OrbEngine = {
  ctx: null,
  size: 300,
  dpr: 1,
  frameId: 0,
  time: 0,
  visualState: 'idle',
  particles: [],

  init(canvas) {
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.resize();
    window.addEventListener('resize', () => this.resize(), { passive: true });
    this.particles = Array.from({ length: 88 }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: .2 + Math.random() * .42,
      speed: .0008 + Math.random() * .0024,
      size: .7 + Math.random() * 2.3,
      opacity: .12 + Math.random() * .34
    }));
    this.loop();
  },

  resize() {
    const rect = dom.orbCanvas.getBoundingClientRect();
    this.size = Math.max(1, Math.min(rect.width || 300, rect.height || 300));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    dom.orbCanvas.width = Math.round(this.size * this.dpr);
    dom.orbCanvas.height = Math.round(this.size * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  },

  setState(status) { this.visualState = status; },

  loop() {
    this.time += 0.016;
    this.draw();
    this.frameId = requestAnimationFrame(() => this.loop());
  },

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const size = this.size;
    const cx = size / 2;
    const cy = size / 2;
    const t = this.time;
    const baseRadius = size * .35;
    const breathe = 1 + Math.sin(t * 1.5) * .035;
    ctx.clearRect(0, 0, size, size);

    const palettes = {
      idle: ['rgba(16,185,129,.17)', 'rgba(16,185,129,.015)'],
      connecting: ['rgba(217,184,115,.22)', 'rgba(217,184,115,.015)'],
      listening: ['rgba(99,102,241,.23)', 'rgba(99,102,241,.015)'],
      thinking: ['rgba(217,184,115,.22)', 'rgba(217,184,115,.012)'],
      speaking: ['rgba(245,158,11,.23)', 'rgba(245,158,11,.015)'],
      error: ['rgba(244,63,94,.22)', 'rgba(244,63,94,.015)']
    };
    const palette = palettes[this.visualState] || palettes.idle;
    const background = ctx.createRadialGradient(cx - size * .1, cy - size * .1, baseRadius * .15, cx, cy, baseRadius * breathe);
    background.addColorStop(0, palette[0]);
    background.addColorStop(1, palette[1]);
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius * breathe, 0, Math.PI * 2);
    ctx.fillStyle = background;
    ctx.fill();

    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius * .62);
    core.addColorStop(0, `rgba(217,184,115,${.14 + Math.sin(t * 2) * .04})`);
    core.addColorStop(1, 'rgba(217,184,115,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius * .62, 0, Math.PI * 2);
    ctx.fillStyle = core;
    ctx.fill();

    for (let index = 0; index < 3; index += 1) {
      const radius = baseRadius * (.61 + index * .15 + Math.sin(t * .8 + index) * .025);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(217,184,115,${.085 - index * .02})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    for (const particle of this.particles) {
      particle.angle += particle.speed;
      const x = cx + Math.cos(particle.angle) * baseRadius * particle.radius;
      const y = cy + Math.sin(particle.angle) * baseRadius * particle.radius;
      ctx.beginPath();
      ctx.arc(x, y, particle.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(246,231,189,${particle.opacity * (.45 + Math.sin(t + particle.angle) * .45)})`;
      ctx.fill();
    }
  }
};

const AudioEngine = {
  async ensureContext() {
    if (!state.audioContext || state.audioContext.state === 'closed') {
      state.audioContext = new AudioContext({ latencyHint: 'interactive' });
    }
    if (state.audioContext.state !== 'running') await state.audioContext.resume();
    if (!state.workletReady) {
      state.workletReady = state.audioContext.audioWorklet.addModule(
        new URL('./pcm-capture.worklet.js', import.meta.url)
      );
    }
    await state.workletReady;
    return state.audioContext;
  },

  async startCapture(stream, onPcmChunk) {
    const context = await this.ensureContext();
    this.stopCapture();

    const source = context.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(context, 'pcm-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: AUDIO_INPUT_RATE, chunkSize: 2048 }
    });
    const silentGain = context.createGain();
    silentGain.gain.value = 0;

    processor.port.onmessage = (event) => {
      if (!state.micActive || !state.liveSession || !state.connected) return;
      onPcmChunk(event.data);
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);

    state.mediaStream = stream;
    state.mediaSource = source;
    state.captureNode = processor;
    state.silentGain = silentGain;
  },

  stopCapture() {
    if (state.captureNode) {
      state.captureNode.port.onmessage = null;
      try { state.captureNode.disconnect(); } catch { /* already disconnected */ }
      state.captureNode = null;
    }
    if (state.mediaSource) {
      try { state.mediaSource.disconnect(); } catch { /* already disconnected */ }
      state.mediaSource = null;
    }
    if (state.silentGain) {
      try { state.silentGain.disconnect(); } catch { /* already disconnected */ }
      state.silentGain = null;
    }
    if (state.mediaStream) {
      for (const track of state.mediaStream.getTracks()) track.stop();
      state.mediaStream = null;
    }
  },

  async playPcmBase64(base64) {
    const context = await this.ensureContext();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (!sampleCount) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buffer = context.createBuffer(1, sampleCount, AUDIO_OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32768;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + .025, state.nextPlaybackTime || 0);
    source.start(startAt);
    state.nextPlaybackTime = startAt + buffer.duration;
    state.activePlaybackSources.add(source);
    source.onended = () => {
      state.activePlaybackSources.delete(source);
      try { source.disconnect(); } catch { /* already disconnected */ }
      if (state.playbackTurnFinished && state.activePlaybackSources.size === 0) {
        AppController.onPlaybackFinished();
      }
    };
  },

  stopPlayback() {
    for (const source of state.activePlaybackSources) {
      try { source.stop(); } catch { /* source may not have started */ }
      try { source.disconnect(); } catch { /* already disconnected */ }
    }
    state.activePlaybackSources.clear();
    state.nextPlaybackTime = 0;
    state.playbackTurnFinished = false;
  },

  isPlaying() { return state.activePlaybackSources.size > 0; }
};

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + blockSize, bytes.length)));
  }
  return btoa(binary);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Yêu cầu thất bại (HTTP ${response.status}).`);
  return data;
}

const VideoEngine = {
  player: null,
  apiReady: null,

  async search(query) {
    const result = await fetchJson(`/api/youtube-search?q=${encodeURIComponent(query)}`, { method: 'GET', headers: {} });
    return result.result;
  },

  async ensureApi() {
    if (window.YT?.Player) return;
    if (this.apiReady) return this.apiReady;

    this.apiReady = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Không tải được YouTube Player API.')), 15_000);
      const previousCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previousCallback === 'function') previousCallback();
        window.clearTimeout(timeout);
        resolve();
      };

      const existing = document.querySelector('script[data-youtube-iframe-api]');
      if (!existing) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.dataset.youtubeIframeApi = 'true';
        script.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error('Trình duyệt không tải được YouTube Player API.'));
        };
        document.head.append(script);
      }
    });

    return this.apiReady;
  },

  async play(video) {
    if (!video?.videoId) throw new Error('Video không hợp lệ.');
    await this.ensureApi();
    UI.showVideo(video.title);

    if (this.player) {
      this.player.loadVideoById({ videoId: video.videoId });
      return;
    }

    this.player = new window.YT.Player('yt-player', {
      width: '100%',
      height: '100%',
      videoId: video.videoId,
      playerVars: {
        autoplay: 1,
        playsinline: 1,
        controls: 1,
        rel: 0,
        origin: window.location.origin
      },
      events: {
        onReady: (event) => event.target.playVideo(),
        onStateChange: (event) => {
          if (event.data === window.YT.PlayerState.ENDED) UI.hideVideo();
        },
        onAutoplayBlocked: () => UI.showToast('Trình duyệt đã chặn tự phát. Hãy nhấn nút phát trên video.'),
        onError: (event) => {
          const reason = event.data === 101 || event.data === 150
            ? 'Video này không cho phép phát nhúng. Hãy chọn video khác.'
            : `YouTube không thể phát video (mã ${event.data}).`;
          UI.showToast(reason);
          UI.hideVideo();
        }
      }
    });
  },

  stop() {
    if (this.player?.stopVideo) {
      try { this.player.stopVideo(); } catch { /* player has already closed */ }
    }
  }
};

function extractVideoQuery(transcript) {
  const text = String(transcript || '').replace(/[.,!?;:]+$/g, '').trim();
  if (!text) return null;

  const patterns = [
    /(?:cho tôi|cho mình|hãy|vui lòng)?\s*(?:mở|phát|tìm|xem)\s+(?:cho tôi\s+)?(?:một\s+)?video\s*(?:về|nói về|liên quan đến)?\s+(.+)$/i,
    /^video\s+(?:về|nói về|liên quan đến)\s+(.+)$/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const query = match[1].replace(/^(?:chủ đề|nội dung)\s+/i, '').trim();
      if (query.length >= 2) return query;
    }
  }
  return null;
}

const AppController = {
  async init() {
    OrbEngine.init(dom.orbCanvas);
    UI.setStatus('idle');
    UI.applyMirror();
    UI.setMicButton(false);
    this.bindEvents();
    await this.checkBackend();
    this.checkOrientation();
    window.addEventListener('resize', () => this.checkOrientation(), { passive: true });
    window.addEventListener('orientationchange', () => window.setTimeout(() => this.checkOrientation(), 150), { passive: true });
    window.addEventListener('pagehide', () => this.shutdown({ closeSession: true, keepVideo: false }), { once: true });
  },

  async checkBackend() {
    try {
      state.health = await fetchJson('/api/health', { headers: {} });
      const status = state.health.geminiConfigured
        ? `Model ${state.health.model} · khóa API nằm trên máy chủ`
        : 'Chưa cấu hình GEMINI_API_KEY trong .env';
      dom.connectionDetail.textContent = status;
      if (!state.health.geminiConfigured) UI.showToast('Backend chưa có Gemini API Key. Hãy cấu hình file .env rồi khởi động lại.');
    } catch (error) {
      dom.connectionDetail.textContent = 'Không kết nối được backend. Kiểm tra server và cổng chạy.';
      UI.showToast(error.message || 'Không kết nối được backend.');
    }
  },

  bindEvents() {
    dom.btnMic.addEventListener('click', () => this.toggleMicrophone());
    dom.btnStop.addEventListener('click', () => this.emergencyStop());
    dom.btnMirror.addEventListener('click', () => this.cycleMirror());
    dom.btnSettings.addEventListener('click', () => UI.showSettings());
    dom.btnSheetCancel.addEventListener('click', () => UI.hideSettings());
    dom.btnSheetSave.addEventListener('click', () => this.saveSettings());
    dom.bottomSheetBackdrop.addEventListener('click', () => UI.hideSettings());

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.emergencyStop();
      if (event.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) {
        event.preventDefault();
        this.toggleMicrophone();
      }
    });

    const showControls = () => {
      dom.controlsRight.classList.remove('hidden');
      window.clearTimeout(state.controlsTimer);
      state.controlsTimer = window.setTimeout(() => {
        if (!state.micActive && !dom.bottomSheet.classList.contains('active')) dom.controlsRight.classList.add('hidden');
      }, 5_000);
    };
    document.addEventListener('pointerdown', showControls, { passive: true });
    document.addEventListener('mousemove', showControls, { passive: true });
    showControls();
  },

  checkOrientation() {
    const portrait = window.matchMedia('(orientation: portrait)').matches;
    state.isPortrait = portrait;
    dom.orientationOverlay.classList.toggle('active', portrait);
    if (portrait && state.micActive) this.disableMicrophone(false);
  },

  async toggleMicrophone() {
    if (state.micActive) {
      this.disableMicrophone(true);
      return;
    }
    await this.enableMicrophone();
  },

  async enableMicrophone() {
    if (state.isPortrait) {
      UI.showToast('Hãy xoay màn hình ngang trước khi bật microphone.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      UI.setStatus('error');
      UI.showToast('Trình duyệt này thiếu hỗ trợ microphone hoặc AudioWorklet. Hãy dùng Chrome/Edge/Safari mới và HTTPS.');
      return;
    }

    const hasReusableSession = Boolean(state.liveSession && state.connected);
    const generation = hasReusableSession ? state.generation : ++state.generation;
    let pendingStream = null;
    let contextReady = null;
    dom.btnMic.disabled = true;
    UI.setStatus('connecting');

    try {
      // Resume AudioContext ngay trong chuỗi thao tác nhấn nút để tránh autoplay policy.
      contextReady = AudioEngine.ensureContext();
      // getUserMedia được gọi trực tiếp từ thao tác nhấn nút để trình duyệt cho phép xin quyền.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      pendingStream = stream;
      if (generation !== state.generation) {
        stream.getTracks().forEach((track) => track.stop());
        pendingStream = null;
        return;
      }

      await contextReady;
      if (state.audioContext?.state !== 'running') await state.audioContext?.resume();
      if (!state.liveSession || !state.connected) {
        state.manualClose = false;
        const tokenData = await fetchJson('/api/live-token', { method: 'POST', body: '{}' });
        if (generation !== state.generation) {
          stream.getTracks().forEach((track) => track.stop());
          pendingStream = null;
          return;
        }

        const ai = new GoogleGenAI({
          apiKey: tokenData.token,
          httpOptions: { apiVersion: 'v1alpha' }
        });

        const config = structuredClone(LIVE_CONFIG);
        const session = await ai.live.connect({
          model: tokenData.model || LIVE_MODEL_FALLBACK,
          config,
          callbacks: {
            onopen: () => {
              if (generation === state.generation) UI.setStatus('connecting', 'Đã mở kết nối');
            },
            onmessage: (message) => {
              if (generation === state.generation) void this.handleLiveMessage(message);
            },
            onerror: (event) => {
              if (generation !== state.generation) return;
              console.error('Gemini Live error:', event?.message || event);
              UI.showToast(event?.message || 'Kết nối Gemini Live gặp lỗi.');
            },
            onclose: (event) => {
              if (generation !== state.generation || state.manualClose) return;
              console.warn('Gemini Live closed:', event?.code, event?.reason);
              state.connected = false;
              state.liveSession = null;
              this.disableMicrophone(false);
              UI.setStatus('error');
              UI.showToast(event?.reason || `Gemini Live đã đóng kết nối (${event?.code ?? 'không rõ mã'}).`);
            }
          }
        });

        if (generation !== state.generation) {
          session.close();
          stream.getTracks().forEach((track) => track.stop());
          pendingStream = null;
          return;
        }
        state.liveSession = session;
        state.connected = true;
      }

      await AudioEngine.startCapture(stream, (pcmBuffer) => {
        const session = state.liveSession;
        if (!session || !state.connected || !state.micActive) return;
        try {
          session.sendRealtimeInput({
            audio: {
              data: arrayBufferToBase64(pcmBuffer),
              mimeType: `audio/pcm;rate=${AUDIO_INPUT_RATE}`
            }
          });
        } catch (error) {
          console.error('Send audio failed:', error);
          UI.showToast('Không gửi được âm thanh tới Gemini Live.');
        }
      });

      pendingStream = null; // AudioEngine now owns and stops this stream.
      if (generation !== state.generation) {
        AudioEngine.stopCapture();
        return;
      }
      state.micActive = true;
      state.manualClose = false;
      UI.setMicButton(true);
      UI.setStatus('listening');
      UI.showOrb();
      try {
        if (screen.orientation?.lock) await screen.orientation.lock('landscape');
      } catch { /* device/browser may not permit orientation lock */ }
      UI.showToast('Hologram đang lắng nghe. Bạn có thể nói tự nhiên và ngắt lời AI bất cứ lúc nào.');
    } catch (error) {
      console.error('Microphone / Gemini startup failed:', error);
      AudioEngine.stopCapture();
      if (pendingStream) pendingStream.getTracks().forEach((track) => track.stop());
      state.micActive = false;
      UI.setMicButton(false);
      UI.setStatus('error');
      UI.showToast(this.humanizeError(error));
    } finally {
      dom.btnMic.disabled = false;
    }
  },

  humanizeError(error) {
    const message = String(error?.message || error || 'Lỗi không xác định.');
    if (/Permission denied|NotAllowedError|denied/i.test(message)) return 'Bạn chưa cấp quyền microphone. Hãy cho phép microphone trong trình duyệt rồi thử lại.';
    if (/NotFoundError|Requested device not found/i.test(message)) return 'Không tìm thấy microphone trên thiết bị.';
    if (/secure context|navigator\.mediaDevices/i.test(message)) return 'Microphone cần HTTPS hoặc localhost. Không mở trực tiếp bằng file://.';
    if (/API key|API_KEY|unauthorized|401|403/i.test(message)) return 'Gemini từ chối xác thực. Kiểm tra API key, quyền API và hạn mức trong Google AI Studio.';
    if (/model|not found|404/i.test(message)) return `Model Live không khả dụng với dự án/key hiện tại. Model đang cấu hình: ${state.health?.model || LIVE_MODEL_FALLBACK}.`;
    return message;
  },

  disableMicrophone(showMessage = true) {
    state.micActive = false;
    AudioEngine.stopCapture();
    UI.setMicButton(false);
    if (state.status !== 'error' && state.status !== 'speaking') UI.setStatus('idle');
    if (showMessage) UI.showToast('Đã tắt microphone. Phiên Gemini vẫn được giữ để có thể bật lại.');
  },

  async handleLiveMessage(message) {
    const serverContent = message?.serverContent;

    if (serverContent?.interrupted) {
      AudioEngine.stopPlayback();
      state.playbackTurnFinished = false;
      if (state.micActive) UI.setStatus('listening');
    }

    const inputTranscript = message?.inputTranscription?.text ?? serverContent?.inputTranscription?.text;
    if (inputTranscript) this.handleInputTranscript(inputTranscript);

    const outputTranscript = message?.outputTranscription?.text ?? serverContent?.outputTranscription?.text;
    if (outputTranscript) {
      if (dom.videoLayer.classList.contains('active')) {
        UI.setSubtitle(outputTranscript);
      } else {
        UI.showText('Hologram', outputTranscript);
      }
      UI.setStatus('speaking');
    }

    const parts = serverContent?.modelTurn?.parts || [];
    for (const part of parts) {
      if (part?.inlineData?.data) {
        UI.setStatus('speaking');
        try {
          await AudioEngine.playPcmBase64(part.inlineData.data);
        } catch (error) {
          console.error('Audio playback failed:', error);
          UI.showToast('Gemini đã trả âm thanh nhưng trình duyệt không phát được.');
        }
      }
      if (part?.text) {
        if (dom.videoLayer.classList.contains('active')) UI.setSubtitle(part.text);
        else UI.showText('Hologram', part.text);
      }
    }

    if (serverContent?.turnComplete || serverContent?.generationComplete) {
      state.playbackTurnFinished = true;
      if (!AudioEngine.isPlaying()) this.onPlaybackFinished();
    }
  },

  handleInputTranscript(transcript) {
    const incoming = String(transcript).trim();
    if (!incoming) return;

    const previous = state.lastInputTranscript;
    if (!previous) state.lastVideoQuery = '';
    if (incoming === previous || previous.startsWith(incoming)) return;
    state.lastInputTranscript = incoming.startsWith(previous) ? incoming : `${previous} ${incoming}`.trim();
    const transcriptText = state.lastInputTranscript;
    if (state.status !== 'speaking') UI.setStatus('thinking');
    if (!dom.videoLayer.classList.contains('active') && state.status !== 'speaking') {
      UI.showText('Bạn đang nói', transcriptText);
    }

    window.clearTimeout(state.videoTranscriptTimer);
    state.videoTranscriptTimer = window.setTimeout(() => {
      const query = extractVideoQuery(state.lastInputTranscript);
      if (query && query !== state.lastVideoQuery && !state.videoSearchInProgress) {
        void this.searchAndPlayVideo(query);
      }
      // The next user utterance starts a fresh transcript after the debounce window.
      state.lastInputTranscript = '';
    }, 850);
  },

  async searchAndPlayVideo(query) {
    state.lastVideoQuery = query;
    state.videoSearchInProgress = true;
    UI.setSubtitle('Đang tìm video phù hợp…');
    UI.showToast(`Đang tìm video: ${query}`, 2_000);
    try {
      const video = await VideoEngine.search(query);
      if (!video) {
        UI.showToast('Không tìm thấy video có thể phát nhúng.');
        UI.setSubtitle('Không tìm thấy video phù hợp.');
        return;
      }
      await VideoEngine.play(video);
      UI.setSubtitle('Video đang phát');
    } catch (error) {
      console.error('Video search/play failed:', error);
      UI.showToast(error.message || 'Không thể tìm hoặc phát video.');
      UI.setSubtitle('Không thể phát video này.');
    } finally {
      state.videoSearchInProgress = false;
    }
  },

  onPlaybackFinished() {
    state.playbackTurnFinished = false;
    if (state.micActive) UI.setStatus('listening');
    else if (state.status !== 'error') UI.setStatus('idle');
  },

  async emergencyStop() {
    await this.shutdown({ closeSession: true, keepVideo: false });
    state.lastInputTranscript = '';
    state.lastVideoQuery = '';
    UI.hideVideo();
    UI.showOrb();
    UI.setStatus('idle');
    UI.showToast('Đã dừng toàn bộ hoạt động.');
  },

  async shutdown({ closeSession = true, keepVideo = true } = {}) {
    state.generation += 1;
    state.manualClose = true;
    state.micActive = false;
    AudioEngine.stopCapture();
    AudioEngine.stopPlayback();
    UI.setMicButton(false);
    if (closeSession && state.liveSession) {
      try { state.liveSession.close(); } catch { /* already closed */ }
      state.liveSession = null;
      state.connected = false;
    }
    if (!keepVideo) VideoEngine.stop();
    if (state.videoTranscriptTimer) window.clearTimeout(state.videoTranscriptTimer);
  },

  cycleMirror() {
    const index = MIRROR_MODES.indexOf(state.mirrorMode);
    state.mirrorMode = MIRROR_MODES[(index + 1) % MIRROR_MODES.length];
    this.saveMirrorMode();
    UI.applyMirror();
    UI.showToast(`Lật gương: ${state.mirrorMode}`);
  },

  saveSettings() {
    const selected = dom.selectMirror.value;
    if (!MIRROR_MODES.includes(selected)) {
      dom.sheetError.textContent = 'Chế độ lật gương không hợp lệ.';
      return;
    }
    state.mirrorMode = selected;
    this.saveMirrorMode();
    UI.applyMirror();
    UI.hideSettings();
    UI.showToast('Đã lưu cài đặt.');
  },

  saveMirrorMode() {
    try { localStorage.setItem(STORAGE_KEY_MIRROR, state.mirrorMode); } catch { /* storage can be disabled */ }
  }
};

window.addEventListener('error', (event) => {
  console.error('Unhandled application error:', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

void AppController.init();
