import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightCircle,
  Bot,
  CheckCircle2,
  ClipboardCopy,
  FileAudio,
  FileJson,
  FileText,
  Flame,
  GitBranch,
  Loader2,
  Mic,
  MicOff,
  Radio,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { AiIngestionResult, AiProvider, AiSafeConfig, BackgroundJobSummary, ExtractedDoc } from '../types';
import { AiProviderPicker, isAiProviderReady } from './AiProviderPicker';

interface AiIngestionModalProps {
  open: boolean;
  targetLibrary: 'methodology' | 'cognition';
  initialMode?: 'document' | 'voice';
  aiConfig: AiSafeConfig | null;
  recentIngestJob?: BackgroundJobSummary | null;
  onJobStarted?: (job: BackgroundJobSummary) => void;
  onJobFinished?: () => void;
  onClose: () => void;
  onOpenAiSettings: () => void;
  onFillNewCardForm: (cardData: Record<string, any>) => void;
  onRequestMutation: (action: string, payload: Record<string, unknown>, onSuccess?: () => void) => void;
  onToast: (msg: string) => void;
}

function nowStampShort() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtMMSS(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 工作模式一：AI 文献 / 文档 / 语音速记智能转化工作台
 * - 支持上传 .pdf / .docx / .md / .txt / .html / .csv / .json、直接粘贴文章、
 *   以及「浏览器实时中文语音听写 / 高保真麦克风录音转写 / 上传 .mp3/.m4a/.wav 语音文件」并一键 AI 转化！
 * - 支持全站 9 大引擎（Codex 官方套餐 / Gemini CLI / DeepSeek / 通义千问 / Kimi / 智谱 GLM / Gemini / GPT / 自定义接口）
 * - 后台异步持久化运行，关闭弹窗或切换页面均不中断
 */
export const AiIngestionModal: React.FC<AiIngestionModalProps> = ({
  open,
  targetLibrary,
  initialMode = 'document',
  aiConfig,
  recentIngestJob,
  onJobStarted,
  onJobFinished,
  onClose,
  onOpenAiSettings,
  onFillNewCardForm,
  onRequestMutation,
  onToast,
}) => {
  const isMethod = targetLibrary === 'methodology';
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [sourceName, setSourceName] = useState('');
  const [batchNote, setBatchNote] = useState(isMethod ? '研报/文献AI转化批次' : '产业研报AI转化批次');
  const [hint, setHint] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [extractedMeta, setExtractedMeta] = useState<ExtractedDoc | null>(null);
  const [extracting, setExtracting] = useState(false);

  // 语音输入与录音转写状态
  const [voicePanelOpen, setVoicePanelOpen] = useState(initialMode === 'voice');
  const [isVoiceInput, setIsVoiceInput] = useState(initialMode === 'voice');
  const [isListening, setIsListening] = useState(false); // Web Speech API 实时中文听写
  const [interimText, setInterimText] = useState('');
  const [voiceSec, setVoiceSec] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false); // MediaRecorder 高保真录音
  const [transcribingAudio, setTranscribingAudio] = useState(false);
  const [autoConvertAfterVoice, setAutoConvertAfterVoice] = useState(true);

  const recognitionRef = useRef<any>(null);
  const keepListeningRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const [selectedProvider, setSelectedProvider] = useState<AiProvider>(aiConfig?.provider || 'codex_cli');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJobStartedAt, setActiveJobStartedAt] = useState<number>(Date.now());
  const [elapsedSec, setElapsedSec] = useState(0);
  const [result, setResult] = useState<AiIngestionResult | null>(null);
  const [auditInfo, setAuditInfo] = useState<{ provider: string; model: string; latencyMs: number; sourceChars: number } | null>(null);
  const [committedKeys, setCommittedKeys] = useState<Set<string>>(new Set());

  const [showJsonImport, setShowJsonImport] = useState(false);
  const [manualJson, setManualJson] = useState('');

  const appliedJobIds = useRef<Set<string>>(new Set());
  const onJobFinishedRef = useRef(onJobFinished);
  const onToastRef = useRef(onToast);
  onJobFinishedRef.current = onJobFinished;
  onToastRef.current = onToast;

  const running = Boolean(activeJobId);

  useEffect(() => {
    if (open && initialMode === 'voice') {
      setVoicePanelOpen(true);
      setIsVoiceInput(true);
      if (!sourceName) setSourceName(`语音口述速记 ${nowStampShort()}`);
      setBatchNote(isMethod ? '方法论语音速记AI转化' : '行业认知语音速记AI转化');
    }
  }, [open, initialMode, isMethod]);

  useEffect(() => {
    if (aiConfig?.provider) {
      setSelectedProvider(aiConfig.provider);
    }
  }, [aiConfig?.provider]);

  // 语音/录音计时器
  useEffect(() => {
    if (!isListening && !isRecordingAudio) {
      setVoiceSec(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setVoiceSec(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [isListening, isRecordingAudio]);

  // 组件卸载时释放麦克风与识别器
  useEffect(() => {
    return () => {
      keepListeningRef.current = false;
      try {
        recognitionRef.current?.stop?.();
      } catch {
        // ignore
      }
      try {
        mediaRecorderRef.current?.stop?.();
        mediaStreamRef.current?.getTracks?.().forEach((t) => t.stop());
      } catch {
        // ignore
      }
    };
  }, []);

  // 浏览器刷新后如后端仍有正在跑的同库转化任务，自动接管（防竞态重挂）
  useEffect(() => {
    if (
      !activeJobId &&
      recentIngestJob &&
      recentIngestJob.status === 'running' &&
      !appliedJobIds.current.has(recentIngestJob.id)
    ) {
      setActiveJobId(recentIngestJob.id);
      const ts = recentIngestJob.startedAt ? new Date(recentIngestJob.startedAt).getTime() : Date.now();
      setActiveJobStartedAt(Number.isFinite(ts) ? ts : Date.now());
    }
  }, [activeJobId, recentIngestJob]);

  // 后台轮询（关闭弹窗或切换页面都不中断）
  useEffect(() => {
    if (!activeJobId) {
      setElapsedSec(0);
      return;
    }
    const updateElapsed = () => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - activeJobStartedAt) / 1000)));
    };
    updateElapsed();
    const tick = setInterval(updateElapsed, 1000);

    const poll = setInterval(async () => {
      try {
        const res = await api.getJob(activeJobId);
        const job = res.job;
        if (job.status === 'completed') {
          setActiveJobId(null);
          onJobFinishedRef.current?.();
          if (job.result?.result && !appliedJobIds.current.has(job.id)) {
            appliedJobIds.current.add(job.id);
            setResult(job.result.result);
            setAuditInfo(job.result.auditTrail || null);
            setCommittedKeys(new Set());
            onToastRef.current(
              `后台${isMethod ? '方法论' : '认知库'}文献转化完成！提炼新增候选 ${job.result.result.newCards.length} 张、增订 ${job.result.result.amendments.length} 处`
            );
          }
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          appliedJobIds.current.add(job.id);
          setActiveJobId(null);
          onJobFinishedRef.current?.();
          onToastRef.current(
            job.status === 'cancelled'
              ? '后台文献转化任务已取消'
              : `后台文献转化失败：${job.error || '未知错误'}`
          );
        }
      } catch {
        // retry next tick
      }
    }, 1500);

    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [activeJobId, activeJobStartedAt, isMethod]);

  const handleLoadCompletedJob = async (jobId: string) => {
    try {
      const res = await api.getJob(jobId);
      if (res.job.result?.result) {
        setResult(res.job.result.result);
        setAuditInfo(res.job.result.auditTrail || null);
        setCommittedKeys(new Set());
        onToast('已从本地后台缓存载入上次 AI 转化结果！');
      }
    } catch (err: any) {
      onToast(`恢复失败：${err.message}`);
    }
  };

  if (!open) return null;

  const isProviderReady = (p: AiProvider) => isAiProviderReady(aiConfig, p);

  const handleFileSelected = async (file: File | undefined) => {
    if (!file) return;
    setExtracting(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取本地文件失败'));
        reader.readAsDataURL(file);
      });
      const res = await api.extractDocument(file.name, base64);
      setExtractedMeta(res.extracted);
      setSourceName(file.name);
      setSourceText(res.extracted.text);
      onToast(
        `已解析 ${file.name}（${res.extracted.pageCount ? `${res.extracted.pageCount} 页，` : ''}${res.extracted.extractedChars} 字）`
      );
    } catch (err: any) {
      onToast(`文档提取失败：${err.message}`);
    } finally {
      setExtracting(false);
    }
  };

  const launchAiJob = async (textOverride?: string, voiceFlag?: boolean) => {
    const finalText = (textOverride !== undefined ? textOverride : sourceText).trim();
    const useVoice = voiceFlag !== undefined ? voiceFlag : isVoiceInput;
    if (!finalText || finalText.length < 20) {
      onToast('内容过短（需至少 20 字），请继续语音口述、上传文档或补充文字材料。');
      return;
    }
    if (!isProviderReady(selectedProvider)) {
      onToast('当前所选 AI 引擎尚未就绪，请先检查登录状态或填写 API Key。');
      onOpenAiSettings();
      return;
    }
    const finalSourceName = sourceName.trim() || (useVoice ? `语音口述速记 ${nowStampShort()}` : '用户粘贴文本');
    const finalBatch = batchNote.trim() || (useVoice ? '语音速记AI转化批次' : '文献AI转化批次');
    try {
      const res = await api.startAiIngestionJob(
        targetLibrary,
        finalText,
        { sourceName: finalSourceName, batchNote: finalBatch, hint, isVoiceInput: useVoice },
        selectedProvider
      );
      setActiveJobStartedAt(Date.now());
      setActiveJobId(res.job.id);
      onJobStarted?.(res.job);
      onToast(
        useVoice
          ? '语音内容已送入后台 AI 清洗并转化入库！关闭弹窗或切页均不中断，完成后顶栏会提醒。'
          : '文献转化已转入后台运行！关闭弹窗或切到其他页面都不会中断，完成后顶栏会提醒。'
      );
    } catch (err: any) {
      onToast(`启动后台转化失败：${err.message}`);
    }
  };

  const handleRunAi = async () => {
    await launchAiJob();
  };

  // =========================================================================
  // 语音通道 1：浏览器原生实时中文语音听写（Web Speech API，免费免 Key）
  // =========================================================================
  const speechSupported =
    typeof window !== 'undefined' &&
    Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  const startLiveSpeech = () => {
    setVoiceError(null);
    if (!speechSupported) {
      setVoiceError('当前浏览器不支持原生 Web Speech 听写，请改用「录制音频转写 / 上传音频」或按 Windows 快捷键 Win+H 直接在下方文本框语音听写。');
      return;
    }
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new SpeechRec();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => {
      setIsListening(true);
      setIsVoiceInput(true);
      if (!sourceName.trim()) setSourceName(`语音口述速记 ${nowStampShort()}`);
    };

    rec.onresult = (event: any) => {
      let finalChunk = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const seg = event.results[i][0]?.transcript || '';
        if (event.results[i].isFinal) {
          finalChunk += seg;
        } else {
          interim += seg;
        }
      }
      setInterimText(interim);
      if (finalChunk.trim()) {
        setSourceText((prev) => {
          const sep = prev && !/[\n。！？，、\s]$/.test(prev) ? '。' : '';
          return `${prev}${sep}${finalChunk.trim()}`;
        });
      }
    };

    rec.onerror = (event: any) => {
      const code = event?.error || 'unknown';
      keepListeningRef.current = false;
      setIsListening(false);
      setInterimText('');
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setVoiceError('麦克风权限被拒绝，请在浏览器地址栏左侧允许麦克风访问；或使用下方「上传录音文件」。');
      } else if (code === 'network') {
        setVoiceError(
          '浏览器在线语音服务网络受限（Chrome 原生听写需连通 Google 语音接口）。建议直接按 Windows 11 系统快捷键 Win+H 在下方文本框内离线语音输入，或改用「录制音频 / 上传音频文件」！'
        );
      } else if (code !== 'no-speech' && code !== 'aborted') {
        setVoiceError(`实时语音识别中断 (${code})，可点击重试或改用 Win+H / 上传录音。`);
      }
    };

    rec.onend = () => {
      if (keepListeningRef.current) {
        try {
          rec.start();
          return;
        } catch {
          // stop cleanly
        }
      }
      setIsListening(false);
    };

    recognitionRef.current = rec;
    keepListeningRef.current = true;
    try {
      rec.start();
    } catch (err: any) {
      keepListeningRef.current = false;
      setVoiceError(`启动语音识别失败：${err.message}`);
    }
  };

  const stopLiveSpeech = (andConvert = false) => {
    keepListeningRef.current = false;
    try {
      recognitionRef.current?.stop?.();
    } catch {
      // ignore
    }
    setIsListening(false);
    const pending = interimText.trim();
    setInterimText('');
    let combined = sourceText;
    if (pending) {
      const sep = combined && !/[\n。！？，、\s]$/.test(combined) ? '。' : '';
      combined = `${combined}${sep}${pending}`;
      setSourceText(combined);
    }
    if (andConvert) {
      setTimeout(() => {
        launchAiJob(combined, true);
      }, 60);
    }
  };

  // =========================================================================
  // 语音通道 2：MediaRecorder 高保真录音 / 上传音频文件 -> 后端转写并一键转化
  // =========================================================================
  const sendAudioBlobToTranscribe = async (blob: Blob, fileName: string) => {
    setTranscribingAudio(true);
    setVoiceError(null);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取音频数据失败'));
        reader.readAsDataURL(blob);
      });
      const res = await api.transcribeAudio(fileName, blob.type || '', base64);
      setIsVoiceInput(true);
      if (!sourceName.trim()) setSourceName(`语音转写：${fileName}`);
      const nextText = sourceText.trim() ? `${sourceText.trim()}\n\n${res.text}` : res.text;
      setSourceText(nextText);
      onToast(`语音转写完成（${res.engine}，${(res.latencyMs / 1000).toFixed(1)}s，共 ${res.text.length} 字）`);
      if (autoConvertAfterVoice && nextText.trim().length >= 20) {
        await launchAiJob(nextText, true);
      }
    } catch (err: any) {
      setVoiceError(err.message);
      onToast(`音频转写提示：${err.message}`);
    } finally {
      setTranscribingAudio(false);
    }
  };

  const startMediaRecording = async () => {
    setVoiceError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceError('当前浏览器不支持麦克风音频录制，请使用「上传录音文件」或按 Win+H 语音听写。');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType: mime });
      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      mr.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mime });
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        setIsRecordingAudio(false);
        if (blob.size > 200) {
          sendAudioBlobToTranscribe(blob, `mic_${Date.now()}.webm`);
        }
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setIsRecordingAudio(true);
    } catch (err: any) {
      setVoiceError(`无法打开麦克风：${err.message}`);
    }
  };

  const stopMediaRecording = () => {
    try {
      mediaRecorderRef.current?.stop?.();
    } catch {
      setIsRecordingAudio(false);
    }
  };

  const handleAudioFileSelected = async (file: File | undefined) => {
    if (!file) return;
    await sendAudioBlobToTranscribe(file, file.name);
  };

  const handleCopyPrompt = async () => {
    if (!sourceText.trim() || sourceText.trim().length < 20) {
      onToast('请先上传文档或粘贴原文内容。');
      return;
    }
    try {
      const res = await api.buildIngestionPrompt(targetLibrary, sourceText, {
        sourceName: sourceName || '用户粘贴文本',
        batchNote,
        hint,
      });
      await navigator.clipboard.writeText(res.combinedPrompt);
      onToast('已复制包含全库去重索引的文献转化 Prompt，可贴入 ChatGPT/Gemini 网页版运行！');
    } catch (err: any) {
      onToast(`复制失败：${err.message}`);
    }
  };

  const handleParseManualJson = async () => {
    try {
      const res = await api.parseManualIngestionJson(targetLibrary, manualJson, {
        sourceName: sourceName || '网页版导入',
        batchNote,
      });
      setResult(res.result);
      setAuditInfo(null);
      setShowJsonImport(false);
      setManualJson('');
      onToast(`已校验导入 ${res.result.newCards.length} 张候选卡与 ${res.result.amendments.length} 条增订`);
    } catch (err: any) {
      onToast(`JSON 解析失败：${err.message}`);
    }
  };

  const markCommitted = (key: string) => {
    setCommittedKeys((prev) => new Set(prev).add(key));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 960, maxHeight: '90vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Sparkles size={19} color={isMethod ? 'var(--navy)' : 'var(--teal)'} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 15.5 }}>
                AI 文献 / 语音速记智能转化入库 → {isMethod ? '《方法论卡片库》' : '《行业前沿认知库》'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                支持 🎙️ 实时语音口述 / 上传录音文件 / 上传 PDF·DOCX·MD 或粘贴文字 → 自动去重拆解 → 一键生成结构化卡片
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Step 1: 语音输入 / 上传文档 / 粘贴文本 */}
          <div className="panel panel-pad" style={{ background: 'var(--bg-soft)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                <FileText size={15} color={isMethod ? 'var(--navy)' : 'var(--teal)'} />
                Step 1 · 语音口述 / 上传文档 / 粘贴原文
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={`btn btn-sm ${voicePanelOpen || isListening || isRecordingAudio ? 'btn-amber' : ''}`}
                  onClick={() => setVoicePanelOpen((v) => !v)}
                >
                  <Mic size={13} /> {isListening ? `语音听写中 ${fmtMMSS(voiceSec)}` : voicePanelOpen ? '收起语音工作台' : '语音输入 / 录音转化'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm,.csv,.json"
                  style={{ display: 'none' }}
                  onChange={(e) => handleFileSelected(e.target.files?.[0])}
                />
                <button
                  type="button"
                  className={`btn btn-sm ${isMethod ? 'btn-primary' : 'btn-teal'}`}
                  disabled={extracting}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={13} />
                  {extracting ? '正在提取文档文字...' : '上传 PDF / DOCX / MD / TXT'}
                </button>
                {sourceText && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setSourceText('');
                      setExtractedMeta(null);
                      setSourceName('');
                      setResult(null);
                      setIsVoiceInput(false);
                    }}
                  >
                    <Trash2 size={13} /> 清空
                  </button>
                )}
              </div>
            </div>

            {/* 🎙️ 语音输入与一键 AI 转化工作台 */}
            {voicePanelOpen && (
              <div
                style={{
                  padding: '11px 13px',
                  borderRadius: 9,
                  background: 'var(--bg-elev)',
                  border: `1px solid ${isListening || isRecordingAudio ? 'var(--crimson)' : 'color-mix(in srgb, var(--amber) 45%, var(--border))'}`,
                  marginBottom: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700 }}>
                    {isListening || isRecordingAudio ? <span className="rec-dot" /> : <Mic size={15} color="var(--amber)" />}
                    <span>语音口述速记 & 一键 AI 转化</span>
                    {(isListening || isRecordingAudio) && (
                      <span className="badge badge-crimson mono">
                        {isListening ? '实时听写中' : '录音中'} {fmtMMSS(voiceSec)}
                      </span>
                    )}
                    {isVoiceInput && !isListening && !isRecordingAudio && (
                      <span className="badge badge-amber">已启用语音口语自动清洗</span>
                    )}
                  </div>

                  <label style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={autoConvertAfterVoice}
                      onChange={(e) => setAutoConvertAfterVoice(e.target.checked)}
                    />
                    音频转写后自动一键 AI 转化
                  </label>
                </div>

                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                  {!isListening ? (
                    <button
                      type="button"
                      className="btn btn-amber btn-sm"
                      disabled={isRecordingAudio || transcribingAudio}
                      onClick={startLiveSpeech}
                      title="使用浏览器内置中文实时语音识别，免费免 API Key"
                    >
                      <Mic size={13} /> 开始实时中文语音输入
                    </button>
                  ) : (
                    <>
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => stopLiveSpeech(false)}>
                        <MicOff size={13} /> 仅停止听写
                      </button>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => stopLiveSpeech(true)}>
                        <Sparkles size={13} /> 停止并一键 AI 转化成卡
                      </button>
                    </>
                  )}

                  {!isRecordingAudio ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={isListening || transcribingAudio}
                      onClick={startMediaRecording}
                      title="录制高清音频并交由 Gemini / OpenAI Whisper / 硅基流动 SenseVoice 转写"
                    >
                      <Radio size={13} /> {transcribingAudio ? '正在转写音频...' : '高清录音转写'}
                    </button>
                  ) : (
                    <button type="button" className="btn btn-danger btn-sm" onClick={stopMediaRecording}>
                      <Square size={12} /> 结束录音并转写
                    </button>
                  )}

                  <input
                    ref={audioFileInputRef}
                    type="file"
                    accept=".mp3,.m4a,.wav,.webm,.ogg,.flac,.aac,audio/*"
                    style={{ display: 'none' }}
                    onChange={(e) => handleAudioFileSelected(e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={transcribingAudio || isRecordingAudio}
                    onClick={() => audioFileInputRef.current?.click()}
                  >
                    <FileAudio size={13} /> {transcribingAudio ? '音频转写中...' : '上传录音 (.mp3/.m4a/.wav)'}
                  </button>

                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 11.5 }}
                    onClick={() => {
                      setIsVoiceInput(true);
                      if (!sourceName.trim()) setSourceName(`语音口述速记 ${nowStampShort()}`);
                      textareaRef.current?.focus();
                      onToast('已聚焦下方文本框：你也可以直接按 Windows 11 系统快捷键 Win + H 开启系统级中文语音听写，说完点一键 AI 转化！');
                    }}
                  >
                    💡 Win+H 系统听写
                  </button>
                </div>

                {interimText && (
                  <div
                    style={{
                      padding: '6px 10px',
                      borderRadius: 6,
                      background: 'var(--amber-soft)',
                      color: 'var(--amber)',
                      fontSize: 12.5,
                    }}
                  >
                    正在识别：{interimText}
                  </div>
                )}

                {voiceError && (
                  <div style={{ fontSize: 12, color: 'var(--crimson)', background: 'var(--crimson-soft)', padding: '6px 10px', borderRadius: 6 }}>
                    <AlertTriangle size={12} style={{ verticalAlign: -1, marginRight: 5 }} />
                    {voiceError}
                  </div>
                )}
              </div>
            )}

            {extractedMeta && (
              <div
                style={{
                  padding: '7px 11px',
                  borderRadius: 7,
                  background: 'var(--emerald-soft)',
                  fontSize: 12,
                  marginBottom: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 6,
                }}
              >
                <span>
                  <CheckCircle2 size={13} style={{ verticalAlign: -2, marginRight: 5, color: 'var(--emerald)' }} />
                  已加载 <strong>{extractedMeta.fileName}</strong>
                  {extractedMeta.pageCount ? `（共 ${extractedMeta.pageCount} 页）` : ''} · 提取{' '}
                  <strong className="num">{extractedMeta.extractedChars.toLocaleString()}</strong> 字
                </span>
                {extractedMeta.warnings.length > 0 && (
                  <span style={{ color: 'var(--amber)' }}>{extractedMeta.warnings.join('；')}</span>
                )}
              </div>
            )}

            <div className="grid-3" style={{ marginBottom: 8 }}>
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">材料来源/标题</label>
                <input className="input" placeholder="例：东吴证券《探针卡行业深度》" value={sourceName} onChange={(e) => setSourceName(e.target.value)} />
              </div>
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">入库批次标注</label>
                <input className="input" value={batchNote} onChange={(e) => setBatchNote(e.target.value)} />
              </div>
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">可选提炼重点指令</label>
                <input className="input" placeholder="例：重点提炼估值框架与失效边界" value={hint} onChange={(e) => setHint(e.target.value)} />
              </div>
            </div>

            <textarea
              ref={textareaRef}
              className="textarea"
              style={{ minHeight: 135, background: 'var(--bg-elev)' }}
              placeholder="在此直接口述语音、粘贴研报正文、微信文章、电话会纪要或读书笔记（上传 PDF/DOCX 或录音转写的文本也会显示在此，可删减噪音再一键转化）..."
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
            />
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
              <span>已输入 <strong className="num">{sourceText.length.toLocaleString()}</strong> 字（建议剔除免责声明页）</span>
              <span>AI 会自动对照库内全部已有卡片去重，避免重复建卡</span>
            </div>
          </div>

          {/* Step 2: 引擎选择与触发栏 */}
          <div
            className="panel panel-pad"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Bot size={16} color="var(--navy)" />
              <AiProviderPicker
                value={selectedProvider}
                config={aiConfig}
                onChange={setSelectedProvider}
                onOpenSettings={onOpenAiSettings}
              />
            </div>

            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={handleCopyPrompt} disabled={!sourceText.trim()}>
                <ClipboardCopy size={13} /> 复制去重 Prompt
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setShowJsonImport((v) => !v)}>
                <FileJson size={13} /> 粘贴 JSON
              </button>
              {!running && !result && recentIngestJob && recentIngestJob.status === 'completed' && recentIngestJob.hasResult && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => handleLoadCompletedJob(recentIngestJob.id)}
                >
                  <CheckCircle2 size={13} color="var(--emerald)" /> 载入上次后台转化
                </button>
              )}
              <button
                type="button"
                className={`btn ${isMethod ? 'btn-primary' : 'btn-teal'}`}
                disabled={running || sourceText.trim().length < 20}
                onClick={handleRunAi}
              >
                {running ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
                {running
                  ? `后台解析中 (${elapsedSec}s，关窗/切页不中断)...`
                  : isVoiceInput
                  ? '一键清洗口语并 AI 转化为候选卡'
                  : 'AI 自动解析转化为候选卡'}
              </button>
            </div>
          </div>

          {/* 手动 JSON 粘贴展开区 */}
          {showJsonImport && (
            <div className="panel panel-pad" style={{ background: 'var(--bg-soft)' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>粘贴网页版 GPT / Gemini 返回的转化 JSON：</div>
              <textarea
                className="textarea textarea-mono"
                style={{ minHeight: 140, marginBottom: 8 }}
                value={manualJson}
                onChange={(e) => setManualJson(e.target.value)}
                placeholder='{"summary": "...", "newCards": [...], "amendments": [...], "discarded": [...]}'
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-sm" onClick={() => setShowJsonImport(false)}>收起</button>
                <button type="button" className="btn btn-primary btn-sm" onClick={handleParseManualJson} disabled={!manualJson.trim()}>
                  校验并载入候选结果
                </button>
              </div>
            </div>
          )}

          {/* Step 3: 候选结果审核与一键填表/入库 */}
          {result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="field-block" style={{ marginBottom: 0, background: 'var(--navy-soft)', borderColor: 'color-mix(in srgb, var(--navy) 30%, transparent)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
                  <strong style={{ color: 'var(--navy)' }}>AI 文献提炼摘要</strong>
                  {auditInfo && (
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      {auditInfo.provider} ({auditInfo.model}) · {(auditInfo.latencyMs / 1000).toFixed(1)}s · {auditInfo.sourceChars}字
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13 }}>{result.summary || '提炼完成，请逐条核验后选择填入表单微调或直接预览入库 Diff。'}</div>
                {result.warnings.length > 0 && (
                  <div style={{ marginTop: 6, color: 'var(--amber)', fontSize: 12.5 }}>
                    <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                    {result.warnings.join('；')}
                  </div>
                )}
              </div>

              {/* 新增候选卡 */}
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
                  新增候选卡片（{result.newCards.length} 张）
                </div>
                {result.newCards.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 10 }}>
                    本次未提炼出需新建的独立卡片（请查看下方既有卡增订与丢弃清单）。
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {result.newCards.map((card, idx) => {
                      const key = `new-${idx}`;
                      const done = committedKeys.has(key);
                      return (
                        <div key={key} className="panel panel-pad" style={{ borderLeft: `4px solid ${isMethod ? 'var(--navy)' : 'var(--teal)'}` }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                            <div>
                              <span className={`badge ${isMethod ? 'badge-navy' : 'badge-teal'}`} style={{ marginRight: 7 }}>
                                候选新卡 #{idx + 1}
                              </span>
                              {isMethod ? (
                                <strong style={{ fontSize: 14 }}>{card.system}（{card.topic}）</strong>
                              ) : (
                                <>
                                  <strong style={{ fontSize: 14 }}>{card.title}</strong>
                                  <span className="badge badge-emerald" style={{ marginLeft: 7 }}>{card.evidenceLevel?.slice(0, 14)}</span>
                                </>
                              )}
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => {
                                  onFillNewCardForm(card);
                                  onClose();
                                }}
                              >
                                <ArrowRightCircle size={13} /> 填入新建表单微调
                              </button>
                              <button
                                type="button"
                                className={`btn btn-sm ${done ? 'btn-ghost' : isMethod ? 'btn-primary' : 'btn-teal'}`}
                                onClick={() =>
                                  onRequestMutation(
                                    isMethod ? 'methodology.createCard' : 'cognition.createCard',
                                    card,
                                    () => markCommitted(key)
                                  )
                                }
                              >
                                {done ? '已入库 ✓' : '直接预览落库 Diff'}
                              </button>
                            </div>
                          </div>

                          {isMethod ? (
                            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <div><strong>核心论断：</strong>{card.coreThesis}</div>
                              {card.logicChain && <div><strong>逻辑链条：</strong>{card.logicChain}</div>}
                              <div><strong>适用条件：</strong>{card.applicableConditions}</div>
                              <div style={{ color: 'var(--crimson)' }}><strong>失效信号：</strong>{card.invalidationSignals || '（缺失，请先填入表单补充）'}</div>
                              <div><strong>历史案例：</strong>{card.historicalCases}</div>
                              <div style={{ color: 'var(--text-muted)' }}><strong>来源：</strong>{card.source}</div>
                            </div>
                          ) : (
                            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <div><strong style={{ color: 'var(--emerald)' }}>客观事实：</strong>{card.facts}</div>
                              <div><strong style={{ color: 'var(--navy)' }}>产业含义：</strong>{card.industryImplications}</div>
                              <div><strong style={{ color: 'var(--teal)' }}>A 股映射：</strong>{card.aShareMapping}</div>
                              <div style={{ color: 'var(--crimson)' }}><strong>失效/更新条件：</strong>{card.invalidationConditions}</div>
                              <div style={{ color: 'var(--text-muted)' }}>
                                <strong>来源：</strong>{card.source} · <strong>关联方法论：</strong>{card.relatedMethodIds || '-'} · <strong>关联认知：</strong>{card.relatedCognitionIds || '-'}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 既有卡增订候选 */}
              {result.amendments.length > 0 && (
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <GitBranch size={15} color="var(--violet)" />
                    既有卡片增订候选（{result.amendments.length} 处 · 不覆盖原字段）
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {result.amendments.map((am, idx) => {
                      const key = `amend-${idx}`;
                      const done = committedKeys.has(key);
                      return (
                        <div key={key} className="panel panel-pad" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 260, fontSize: 12.5 }}>
                            <div style={{ marginBottom: 4 }}>
                              <span className="badge badge-violet mono" style={{ marginRight: 6 }}>
                                {isMethod ? `卡片 ${am.cardId}` : `认知卡 ${am.cardId}`}
                              </span>
                              <strong>{am.cardTitle}</strong>
                              {!am.valid && <span className="badge badge-crimson" style={{ marginLeft: 6 }}>库内无此编号</span>}
                            </div>
                            <div style={{ color: 'var(--text-secondary)' }}>{am.content}</div>
                          </div>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={!am.valid}
                            onClick={() =>
                              onRequestMutation(
                                isMethod ? 'methodology.appendAmendment' : 'cognition.appendAmendment',
                                { cardId: am.cardId, batchNote: am.batchNote, content: am.content },
                                () => markCommitted(key)
                              )
                            }
                          >
                            {done ? '已增订 ✓' : '预览增订 Diff'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 冲突矩阵候选（仅方法论库） */}
              {isMethod && result.conflicts.length > 0 && (
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Flame size={15} color="var(--crimson)" />
                    冲突矩阵候选（{result.conflicts.length} 项）
                  </div>
                  {result.conflicts.map((cf, idx) => {
                    const key = `conf-${idx}`;
                    const done = committedKeys.has(key);
                    return (
                      <div key={key} className="panel panel-pad" style={{ marginBottom: 8, borderLeft: '4px solid var(--crimson)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                          <strong style={{ fontSize: 13.5 }}>{cf.title}</strong>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() => onRequestMutation('methodology.createConflict', cf, () => markCommitted(key))}
                          >
                            {done ? '已新增 ✓' : '预览新增冲突 Diff'}
                          </button>
                        </div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                          <div><strong>双方：</strong>{cf.sides}</div>
                          <div><strong>冲突点：</strong>{cf.conflictPoint}</div>
                          <div><strong>折中判别：</strong>{cf.resolution}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 丢弃清单 */}
              {result.discarded.length > 0 && (
                <div className="field-block" style={{ marginBottom: 0, background: 'var(--bg-soft)' }}>
                  <div className="field-block-label">按契约过滤丢弃项（{result.discarded.length} 项）</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--text-muted)' }}>
                    {result.discarded.map((d, i) => (
                      <li key={i}>
                        <strong>{d.item}</strong> — {d.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
