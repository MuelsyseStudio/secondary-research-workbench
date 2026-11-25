'use strict';

/**
 * 统一 AI 推理调用层
 * 支持四种官方/标准引擎：
 * 1. codex_cli  —— 调用本机官方 Codex CLI（走用户已登录的 ChatGPT 官方套餐授权，read-only 隔离沙箱 + -o 精确输出）
 * 2. gemini_cli —— 调用本机官方 Gemini CLI（走用户已登录的 Google 官方授权）
 * 3. gemini     —— Google Gemini REST API
 * 4. openai     —— OpenAI / GPT（及任意 OpenAI 兼容网关）REST API
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { loadRawConfig, OPENAI_COMPAT_PROVIDERS, PROVIDER_META, sanitizeCliCommand, resolveExecutableSpec } = require('./ai-config.cjs');

/**
 * 从模型回复中稳健提取 JSON 对象
 */
function parseJsonFromModelOutput(rawText) {
  const cleaned = String(rawText || '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // continue
  }
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // continue
    }
  }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) {
    return JSON.parse(cleaned.slice(first, last + 1));
  }
  throw new Error('模型输出中未能解析出合法 JSON 对象，返回片段：' + cleaned.slice(0, 260));
}

/**
 * 1. 调用本机官方 Codex CLI（`codex exec -`）
 * - 运行在隔离空临时目录 + `--sandbox read-only` + `--ephemeral` + `--skip-git-repo-check`
 * - 使用 `-o <outFile>` 精准捕获最终回复文本，完全避免终端 ANSI/进度条噪音
 */
function callCodexCli(codexCfg, systemPrompt, userPrompt, timeoutMs = 240000, imageInput = null) {
  return new Promise((resolve, reject) => {
    const cmd = codexCfg.command || 'codex';
    const runId = crypto.randomBytes(6).toString('hex');
    const tmpDir = path.join(os.tmpdir(), `srw-codex-${runId}`);
    const outFile = path.join(tmpDir, 'last-message.txt');
    fs.mkdirSync(tmpDir, { recursive: true });

    const args = [
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color',
      'never',
      '--cd',
      tmpDir,
      '--output-last-message',
      outFile,
    ];

    if (imageInput && imageInput.base64) {
      const ext = /png/i.test(imageInput.mimeType || '') ? '.png' : /webp/i.test(imageInput.mimeType || '') ? '.webp' : '.jpg';
      const imgFile = path.join(tmpDir, `input-image${ext}`);
      const rawB64 = String(imageInput.base64).replace(/^data:[^;]+;base64,/, '');
      fs.writeFileSync(imgFile, Buffer.from(rawB64, 'base64'));
      args.push('--image', imgFile);
    }

    if (codexCfg.model) {
      args.push('--model', codexCfg.model);
    }
    if (codexCfg.reasoningEffort) {
      args.push('--config', `model_reasoning_effort=${codexCfg.reasoningEffort}`);
    }
    // 注意：不传孤立的 "-"（codex exec 在省略 PROMPT 时自动从 stdin 读取），避免 Windows PowerShell 包装脚本将 "-" 误判为空参数名

    const fullPrompt = `${systemPrompt}\n\n【执行约束】你正在纯分析模式下工作：不要调用任何终端命令或读写本地文件，请严格仅根据下方已提供的完整数据包/文献文本直接输出最终 JSON 结果。\n\n${userPrompt}`;

    const safeCmd = sanitizeCliCommand(cmd, 'codex');
    const spec = resolveExecutableSpec(safeCmd);
    if (!spec) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      reject(new Error(`未在本机 PATH 中找到可执行 Codex CLI（${safeCmd}），请先安装或在「AI 引擎」改用 API Key。`));
      return;
    }

    const child = spawn(spec.bin, [...spec.prefixArgs, ...args], {
      windowsHide: true,
      cwd: tmpDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      cleanup();
      reject(new Error(`Codex CLI 执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒）。`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`启动本机 Codex CLI 失败（${cmd}）：${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      let finalMsg = '';
      try {
        if (fs.existsSync(outFile)) {
          finalMsg = fs.readFileSync(outFile, 'utf8').trim();
        }
      } catch {
        // ignore
      }
      cleanup();

      if (code !== 0 && !finalMsg) {
        const errHint = (stderr || stdout || '').trim().slice(-400);
        reject(new Error(`Codex CLI 退出异常 (code=${code})：${errHint || '请检查终端 codex login status 确认登录状态。'}`));
        return;
      }
      const rawText = finalMsg || stdout.trim();
      if (!rawText) {
        reject(new Error('Codex CLI 未返回任何内容，请检查本地官方授权状态。'));
        return;
      }
      resolve({
        rawText,
        model: codexCfg.model || 'Codex 官方默认套餐模型',
        usage: null,
        groundingChunks: [],
      });
    });

    child.stdin.on('error', () => {
      // Prevent unhandled EPIPE if child process exits before consuming prompt
    });
    child.stdin.write(fullPrompt, 'utf8');
    child.stdin.end();
  });
}

/**
 * 2. 调用本机官方 Gemini CLI（`gemini -p` + stdin）
 */
function callGeminiCli(geminiCliCfg, systemPrompt, userPrompt, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const safeCmd = sanitizeCliCommand(geminiCliCfg.command || 'gemini', 'gemini');
    const spec = resolveExecutableSpec(safeCmd);
    if (!spec) {
      reject(new Error(`未在本机 PATH 中找到可执行 Gemini CLI（${safeCmd}）。`));
      return;
    }
    const args = [];
    if (geminiCliCfg.model) {
      args.push('-m', geminiCliCfg.model);
    }
    args.push('-p', '严格按照标准输入中的系统指令与数据，直接输出单个合法 JSON 对象，不要调用任何本地工具。');

    const child = spawn(spec.bin, [...spec.prefixArgs, ...args], {
      windowsHide: true,
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      reject(new Error(`Gemini CLI 执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒）。`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`启动本机 Gemini CLI 失败（${safeCmd}）：${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`Gemini CLI 退出异常 (code=${code})：${stderr.trim().slice(-300)}`));
        return;
      }
      resolve({
        rawText: stdout.trim(),
        model: geminiCliCfg.model || 'Gemini CLI 官方默认模型',
        usage: null,
        groundingChunks: [],
      });
    });

    child.stdin.on('error', () => {
      // Prevent unhandled EPIPE if child process exits early
    });
    child.stdin.write(`${systemPrompt}\n\n${userPrompt}`, 'utf8');
    child.stdin.end();
  });
}

/**
 * 3. 调用 Google Gemini REST API
 */
async function callGeminiApi(geminiCfg, temperature, systemPrompt, userPrompt, expectJson = true, timeoutMs = 120000, imageInput = null) {
  if (!geminiCfg.apiKey) throw new Error('尚未配置 Gemini API Key，请先在「AI 设置」填写或切换至本机 Codex CLI。');
  const url = `${geminiCfg.baseUrl}/v1beta/models/${encodeURIComponent(geminiCfg.model)}:generateContent`;
  const userParts = [{ text: userPrompt }];
  if (imageInput && imageInput.base64) {
    userParts.push({
      inlineData: {
        mimeType: imageInput.mimeType || 'image/png',
        data: String(imageInput.base64).replace(/^data:[^;]+;base64,/, ''),
      },
    });
  }
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: {
      temperature,
      ...(expectJson && !geminiCfg.enableGoogleSearch ? { responseMimeType: 'application/json' } : {}),
    },
    ...(geminiCfg.enableGoogleSearch ? { tools: [{ google_search: {} }] } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': geminiCfg.apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawErr = data?.error?.message || JSON.stringify(data).slice(0, 200);
    const safeErr = String(rawErr).replaceAll(geminiCfg.apiKey, '***');
    throw new Error(`Gemini API 调用失败 (HTTP ${res.status}): ${safeErr}`);
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini API 返回内容为空。');
  return {
    rawText: text,
    model: geminiCfg.model,
    usage: data.usageMetadata || null,
    groundingChunks: data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [],
  };
}

/**
 * 4. 通用 OpenAI 兼容 REST API 调用层
 * 支持：DeepSeek（V3/R1）、通义千问 Qwen、Kimi (Moonshot)、智谱 GLM、OpenAI / GPT、以及任意自定义兼容网关（OpenRouter/硅基流动/火山方舟/Ollama）
 */
async function callOpenAiCompatApi(providerKey, apiCfg, temperature, systemPrompt, userPrompt, expectJson = true, timeoutMs = 180000, imageInput = null) {
  const displayName = PROVIDER_META[providerKey]?.label || providerKey;
  const isLocalEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(apiCfg.baseUrl || '');
  if (!apiCfg.apiKey && !isLocalEndpoint) {
    throw new Error(`尚未配置 ${displayName} API Key，请先在「AI 引擎设置」中填写或切换至本机 Codex CLI。`);
  }
  const baseUrl = (apiCfg.baseUrl || '').replace(/\/+$/, '');
  const url = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
  const model = apiCfg.model;

  // 推理模型（DeepSeek-R1 / QwQ / OpenAI o1/o3/o4/gpt-5 / Kimi-thinking 等）跳过 temperature 与 response_format 以防接口报 400
  const isReasoningModel = /(deepseek-reasoner|\br1\b|qwq|thinking|^o1|^o3|^o4|^gpt-5)/i.test(model);
  let userContent = userPrompt;
  if (imageInput && imageInput.base64) {
    const rawB64 = String(imageInput.base64).replace(/^data:[^;]+;base64,/, '');
    const mime = imageInput.mimeType || 'image/png';
    userContent = [
      { type: 'text', text: userPrompt },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${rawB64}` } },
    ];
  }
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    ...(expectJson && !isReasoningModel ? { response_format: { type: 'json_object' } } : {}),
    ...(isReasoningModel ? {} : { temperature }),
  };

  const headers = { 'Content-Type': 'application/json' };
  if (apiCfg.apiKey) headers.Authorization = `Bearer ${apiCfg.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawErr = String(data?.error?.message || data?.message || JSON.stringify(data).slice(0, 240));
    const safeErr = apiCfg.apiKey ? rawErr.replaceAll(apiCfg.apiKey, '***') : rawErr;
    throw new Error(`${displayName} API 调用失败 (HTTP ${res.status}): ${safeErr}`);
  }
  const msg = data?.choices?.[0]?.message || {};
  const text = (msg.content || '').trim() || (msg.reasoning_content || '').trim();
  if (!text) throw new Error(`${displayName} API 返回内容为空。`);
  return {
    rawText: text,
    model,
    usage: data.usage || null,
    groundingChunks: [],
  };
}

/**
 * 统一调度入口
 */
async function invokeModel({ providerOverride, systemPrompt, userPrompt, expectJson = true, timeoutMs, enableWebSearch = false, imageInput = null }) {
  const cfg = loadRawConfig();
  const provider = providerOverride || cfg.provider;
  const started = Date.now();

  let res;
  if (provider === 'codex_cli') {
    res = await callCodexCli(cfg.codex_cli, systemPrompt, userPrompt, timeoutMs || 240000, imageInput);
  } else if (provider === 'gemini_cli') {
    res = await callGeminiCli(cfg.gemini_cli, systemPrompt, userPrompt, timeoutMs || 240000);
  } else if (provider === 'gemini') {
    const gCfg = enableWebSearch ? { ...cfg.gemini, enableGoogleSearch: true } : cfg.gemini;
    res = await callGeminiApi(gCfg, cfg.temperature, systemPrompt, userPrompt, expectJson, timeoutMs || 150000, imageInput);
  } else if (OPENAI_COMPAT_PROVIDERS.includes(provider)) {
    res = await callOpenAiCompatApi(
      provider,
      cfg[provider],
      cfg.temperature,
      systemPrompt,
      userPrompt,
      expectJson,
      timeoutMs || 180000,
      imageInput
    );
  } else {
    throw new Error(`不支持的 AI 引擎类型：${provider}`);
  }

  return {
    provider,
    model: res.model,
    rawText: res.rawText,
    usage: res.usage,
    groundingChunks: res.groundingChunks || [],
    latencyMs: Date.now() - started,
  };
}

async function testProviderConnection(providerOverride) {
  const res = await invokeModel({
    providerOverride,
    systemPrompt: 'You are a connectivity test assistant. Reply ONLY with JSON {"pong": true}.',
    userPrompt: 'Reply ONLY with {"pong": true}.',
    expectJson: true,
    timeoutMs: 60000,
  });
  return {
    ok: true,
    provider: res.provider,
    model: res.model,
    latencyMs: res.latencyMs,
    sample: res.rawText.slice(0, 120),
  };
}

module.exports = {
  parseJsonFromModelOutput,
  invokeModel,
  testProviderConnection,
};
