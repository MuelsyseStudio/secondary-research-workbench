'use strict';

/**
 * 二级投研 · 音频文件 / 麦克风录音语音转文字引擎
 *
 * 支持多种转写通道（自动按可用优先级选择）：
 * 1. Google Gemini API（若已配置 GEMINI_API_KEY）：直接通过原生多模态 inlineData 转写中文投研语音，对 A 股术语与标的名称识别极准；
 * 2. OpenAI / 自定义 OpenAI 兼容语音接口（/audio/transcriptions）：支持 OpenAI whisper-1 / gpt-4o-mini-transcribe，
 *    或硅基流动 SiliconFlow（FunAudioLLM/SenseVoiceSmall）等 OpenAI 兼容语音转写接口；
 * 3. 本机 whisper CLI（若用户电脑已安装 OpenAI whisper 命令行）。
 *
 * 注：前端同时内置浏览器原生实时语音听写（Web Speech API，免 API Key）与 Windows Win+H 听写辅助，
 *     音频文件/录音转写作为增强与离线/高保真通道无缝互补。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { loadRawConfig } = require('./ai-config.cjs');

const MIME_BY_EXT = {
  '.webm': 'audio/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
};

function decodeAudioBase64(fileName, mimeType, base64Input) {
  let clean = String(base64Input || '').trim();
  let detectedMime = mimeType || '';
  const dataUrlMatch = clean.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    if (!detectedMime) detectedMime = dataUrlMatch[1];
    clean = dataUrlMatch[2];
  }
  const buffer = Buffer.from(clean, 'base64');
  if (!buffer || buffer.length < 100) {
    throw new Error('音频数据为空或过短，请重新录制或选择有效音频文件。');
  }
  if (buffer.length > 25 * 1024 * 1024) {
    throw new Error('音频文件超过 25MB 上限，请分段或压缩后上传。');
  }
  const rawExt = path.extname(fileName || '').toLowerCase();
  const ext = Object.prototype.hasOwnProperty.call(MIME_BY_EXT, rawExt) ? rawExt : '.webm';
  const finalMime = (detectedMime || MIME_BY_EXT[ext] || 'audio/webm').split(';')[0].trim();
  return { buffer, ext, mimeType: finalMime };
}

/**
 * 通道 1：Gemini 原生多模态音频转写
 */
async function transcribeWithGemini(geminiCfg, { buffer, mimeType }) {
  const model = /flash/i.test(geminiCfg.model) ? geminiCfg.model : 'gemini-2.5-flash';
  const url = `${geminiCfg.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: '请将这段中文二级市场投研语音逐字准确转写为带标点符号的清晰中文文本。自动纠正同音金融/A股术语（如涨停、连板、换手率、毛利率、光模块、探针卡、估值分位、证伪、筹码等），去除无意义口头禅（嗯、啊、那个），不要遗漏核心观点或添加未说出的内容，只输出纯转写文本。',
          },
          {
            inlineData: {
              mimeType,
              data: buffer.toString('base64'),
            },
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.1 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': geminiCfg.apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawErr = data?.error?.message || JSON.stringify(data).slice(0, 180);
    throw new Error(`Gemini 语音转写失败 (HTTP ${res.status}): ${String(rawErr).replaceAll(geminiCfg.apiKey, '***')}`);
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim() || '';
  if (!text) throw new Error('Gemini 语音转写返回为空。');
  return { text, engine: `Gemini (${model})` };
}

/**
 * 通道 2：OpenAI / SiliconFlow / 自定义 OpenAI 兼容 /audio/transcriptions
 */
async function transcribeWithOpenAiCompat(label, apiCfg, { buffer, fileName, mimeType }, modelOverride) {
  const baseUrl = (apiCfg.baseUrl || '').replace(/\/+$/, '');
  const url = `${baseUrl}/audio/transcriptions`;
  const isSiliconFlow = /siliconflow/i.test(baseUrl);
  const model = modelOverride || (isSiliconFlow ? 'FunAudioLLM/SenseVoiceSmall' : 'whisper-1');

  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeType });
  formData.append('file', blob, fileName || 'voice.webm');
  formData.append('model', model);
  if (!isSiliconFlow) {
    formData.append('language', 'zh');
    formData.append('prompt', '二级市场投研、A股复盘、方法论、行业认知、光模块、半导体、探针卡、涨停、换手率、毛利率、估值、证伪。');
  }

  const headers = {};
  if (apiCfg.apiKey) headers.Authorization = `Bearer ${apiCfg.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
    signal: AbortSignal.timeout(120000),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`${label} 语音接口调用失败 (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  let text = '';
  try {
    const json = JSON.parse(raw);
    text = String(json.text || json.transcript || '').trim();
  } catch {
    text = raw.trim();
  }
  if (!text) throw new Error(`${label} 语音转写返回为空。`);
  return { text, engine: `${label} (${model})` };
}

function execFileAsync(bin, args, opts) {
  return new Promise((resolve) => {
    execFile(bin, args, opts, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * 通道 3：本机 whisper CLI（如果已安装，纯异步无 shell 执行，杜绝阻塞事件循环与命令注入）
 */
async function transcribeWithLocalWhisper({ buffer, ext }) {
  const safeExt = Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext) ? ext : '.webm';
  const probe = await execFileAsync('whisper', ['--help'], {
    windowsHide: true,
    timeout: 4000,
  });
  if (probe.status !== 0) return null;

  const tmpDir = path.join(os.tmpdir(), `srw-stt-${crypto.randomBytes(5).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const inFile = path.join(tmpDir, `input${safeExt}`);
  fs.writeFileSync(inFile, buffer);

  try {
    const run = await execFileAsync(
      'whisper',
      [inFile, '--language', 'Chinese', '--output_format', 'txt', '--output_dir', tmpDir],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 180000,
      }
    );
    const outTxt = path.join(tmpDir, 'input.txt');
    if (run.status === 0 && fs.existsSync(outTxt)) {
      const text = fs.readFileSync(outTxt, 'utf8').trim();
      if (text) return { text, engine: '本机 Whisper CLI' };
    }
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function transcribeAudio({ fileName = 'voice.webm', mimeType = '', base64 = '' }) {
  const started = Date.now();
  const decoded = decodeAudioBase64(fileName, mimeType, base64);
  const cfg = loadRawConfig();
  const errors = [];

  // 1. 优先尝试 Gemini API（原生音频理解对中文财经词汇极准）
  if (cfg.gemini?.apiKey) {
    try {
      const r = await transcribeWithGemini(cfg.gemini, decoded);
      return { ok: true, text: r.text, engine: r.engine, latencyMs: Date.now() - started };
    } catch (err) {
      errors.push(err.message);
    }
  }

  // 2. 尝试 OpenAI Whisper API
  if (cfg.openai?.apiKey) {
    try {
      const r = await transcribeWithOpenAiCompat('OpenAI Whisper', cfg.openai, { ...decoded, fileName });
      return { ok: true, text: r.text, engine: r.engine, latencyMs: Date.now() - started };
    } catch (err) {
      errors.push(err.message);
    }
  }

  // 3. 尝试自定义接口（如硅基流动 SiliconFlow SenseVoiceSmall）
  if (cfg.custom?.apiKey && /siliconflow|openai|groq|whisper|audio/i.test(cfg.custom.baseUrl || '')) {
    try {
      const r = await transcribeWithOpenAiCompat(cfg.custom.label || '自定义语音接口', cfg.custom, { ...decoded, fileName });
      return { ok: true, text: r.text, engine: r.engine, latencyMs: Date.now() - started };
    } catch (err) {
      errors.push(err.message);
    }
  }

  // 4. 尝试本机 whisper CLI
  const localRes = await transcribeWithLocalWhisper(decoded);
  if (localRes) {
    return { ok: true, text: localRes.text, engine: localRes.engine, latencyMs: Date.now() - started };
  }

  throw new Error(
    errors.length > 0
      ? `音频文件转写失败：${errors.join('；')}。建议直接使用免费的「实时语音听写」或按 Win+H 语音输入。`
      : '当前尚未配置支持音频文件转写的 API（Gemini / OpenAI Whisper / 硅基流动 SenseVoice）。你可以直接使用免费的「🎙️ 实时语音听写」按钮或 Windows 系统快捷键 Win+H 进行语音输入，再点一键 AI 转化！'
  );
}

module.exports = {
  transcribeAudio,
};
