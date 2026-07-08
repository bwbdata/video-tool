<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import classWorkerURL from './ffmpeg-worker.ts?worker&url';

type OutputFile = {
  name: string;
  url: string;
  size: string;
};

const CORE_BASE_URLS = [
  'https://registry.npmmirror.com/@ffmpeg/core/0.12.10/files/dist/esm',
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm',
];

const selectedFile = ref<File | null>(null);
const selectedFileUrl = ref<string | null>(null);
const audioOutput = ref<OutputFile | null>(null);
const silentVideoOutput = ref<OutputFile | null>(null);
const statusText = ref('选择一个本地视频后即可开始处理。');
const hintText = ref('整个处理流程都在浏览器本地完成，不会上传原视频。');
const progress = ref(0);
const isEngineLoading = ref(false);
const isProcessing = ref(false);
const ffmpegReady = ref(false);

let ffmpeg: FFmpeg | null = null;
let coreScriptBlobUrl: string | null = null;
let coreWasmBlobUrl: string | null = null;

const canStart = computed(() => selectedFile.value !== null && !isProcessing.value);
const progressLabel = computed(() => `${Math.max(0, Math.min(100, progress.value))}%`);

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

function revokeUrl(url: string | null): void {
  if (url) {
    URL.revokeObjectURL(url);
  }
}

function updateLoadProgress(base: number, ratio: number): void {
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  progress.value = Math.round(base + clampedRatio * 45);
}

async function fetchAsBlobUrl(
  url: string,
  mimeType: string,
  baseProgress: number,
  label: string,
): Promise<string> {
  statusText.value = label;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`资源请求失败：${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    const blob = await response.blob();
    updateLoadProgress(baseProgress, 1);
    return URL.createObjectURL(new Blob([blob], { type: mimeType }));
  }

  const total = Number(response.headers.get('content-length') ?? '0');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value) {
      chunks.push(value);
      received += value.byteLength;

      if (total > 0) {
        updateLoadProgress(baseProgress, received / total);
      }
    }
  }

  const merged = new Uint8Array(received);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  updateLoadProgress(baseProgress, 1);
  return URL.createObjectURL(new Blob([merged], { type: mimeType }));
}

function clearOutputs(): void {
  revokeUrl(audioOutput.value?.url ?? null);
  revokeUrl(silentVideoOutput.value?.url ?? null);
  audioOutput.value = null;
  silentVideoOutput.value = null;
}

function handleFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const [file] = input.files ?? [];

  clearOutputs();
  progress.value = 0;

  revokeUrl(selectedFileUrl.value);
  selectedFile.value = file ?? null;
  selectedFileUrl.value = file ? URL.createObjectURL(file) : null;
  statusText.value = file ? '文件已准备，点击开始处理。' : '选择一个本地视频后即可开始处理。';
}

async function ensureFfmpeg(): Promise<FFmpeg> {
  if (ffmpeg) {
    return ffmpeg;
  }

  isEngineLoading.value = true;
  statusText.value = '正在加载本地处理引擎，首次进入会下载一次 wasm 核心。';

  try {
    const instance = new FFmpeg();
    instance.on('progress', ({ progress: currentProgress }) => {
      progress.value = Math.round(currentProgress * 100);
    });

    let lastError: unknown = null;

    for (const baseUrl of CORE_BASE_URLS) {
      try {
        progress.value = 5;
        hintText.value = `正在尝试加载引擎源：${baseUrl}`;

        revokeUrl(coreScriptBlobUrl);
        revokeUrl(coreWasmBlobUrl);

        coreScriptBlobUrl = await fetchAsBlobUrl(
          `${baseUrl}/ffmpeg-core.js`,
          'text/javascript',
          5,
          '正在下载 ffmpeg 核心脚本。',
        );
        coreWasmBlobUrl = await fetchAsBlobUrl(
          `${baseUrl}/ffmpeg-core.wasm`,
          'application/wasm',
          50,
          '正在下载 ffmpeg wasm 核心，首次通常较慢。',
        );

        statusText.value = '正在初始化本地处理引擎。';
        progress.value = 96;
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => {
          controller.abort();
        }, 20000);

        try {
          await instance.load(
            {
              classWorkerURL,
              coreURL: coreScriptBlobUrl,
              wasmURL: coreWasmBlobUrl,
              workerURL: coreScriptBlobUrl,
            },
            { signal: controller.signal },
          );
        } finally {
          window.clearTimeout(timeoutId);
        }

        progress.value = 100;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        revokeUrl(coreScriptBlobUrl);
        revokeUrl(coreWasmBlobUrl);
        coreScriptBlobUrl = null;
        coreWasmBlobUrl = null;
      }
    }

    if (lastError) {
      throw lastError;
    }

    ffmpeg = instance;
    ffmpegReady.value = true;
    return instance;
  } finally {
    isEngineLoading.value = false;
  }
}

async function exportBlob(
  worker: FFmpeg,
  fileName: string,
  mimeType: string,
): Promise<OutputFile> {
  const data = await worker.readFile(fileName);
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const normalizedBytes = new Uint8Array(bytes.byteLength);
  normalizedBytes.set(bytes);
  const blob = new Blob([normalizedBytes], { type: mimeType });

  return {
    name: fileName,
    url: URL.createObjectURL(blob),
    size: formatBytes(blob.size),
  };
}

async function runFfmpegCommand(
  worker: FFmpeg,
  args: string[],
  logs: string[],
): Promise<void> {
  const exitCode = await worker.exec(args);

  if (exitCode === 0) {
    return;
  }

  const detail = logs.slice(-8).join(' | ');
  throw new Error(detail ? `FFmpeg 失败：${detail}` : `FFmpeg 失败，退出码 ${exitCode}`);
}

async function processVideo(): Promise<void> {
  if (!selectedFile.value) {
    return;
  }

  clearOutputs();
  isProcessing.value = true;
  progress.value = 0;
  hintText.value = '处理期间请保持当前页面打开。';

  const sourceFile = selectedFile.value;
  const safeBaseName = sourceFile.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9-_]/g, '_') || 'video';
  const inputName = `input-${Date.now()}-${safeBaseName}`;
  const audioName = `${safeBaseName}.mp3`;
  const silentName = `${safeBaseName}-silent.mp4`;

  try {
    const worker = await ensureFfmpeg();
    const commandLogs: string[] = [];
    const logListener = ({ message }: { message: string }) => {
      commandLogs.push(message);
    };

    worker.on('log', logListener);

    try {
      statusText.value = '正在写入本地文件到处理引擎。';
      await worker.writeFile(inputName, await fetchFile(sourceFile));

      try {
        commandLogs.length = 0;
        progress.value = 0;
        statusText.value = '正在提取 MP3 音频。';
        await runFfmpegCommand(
          worker,
          [
            '-i',
            inputName,
            '-map',
            '0:a:0',
            '-vn',
            '-c:a',
            'libmp3lame',
            '-q:a',
            '2',
            audioName,
          ],
          commandLogs,
        );
        audioOutput.value = await exportBlob(worker, audioName, 'audio/mpeg');
      } catch {
        audioOutput.value = null;
      }

      commandLogs.length = 0;
      progress.value = 0;
      statusText.value = '正在导出去音轨 MP4。';
      await runFfmpegCommand(
        worker,
        [
          '-i',
          inputName,
          '-an',
          '-c:v',
          'copy',
          '-movflags',
          '+faststart',
          silentName,
        ],
        commandLogs,
      );
      silentVideoOutput.value = await exportBlob(worker, silentName, 'video/mp4');

      statusText.value = audioOutput.value
        ? '处理完成，可以分别下载 MP3 和静音 MP4。'
        : '视频处理完成，但未导出 MP3，原视频可能没有可提取的音轨。';
      hintText.value = ffmpegReady.value
        ? '处理引擎已经驻留在当前页面，继续处理其他视频会更快。'
        : hintText.value;
    } finally {
      worker.off('log', logListener);
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error, null, 2) || '未知错误';
    statusText.value = `处理失败：${message}`;
    hintText.value = '如果再次失败，请把页面上的完整错误文本发我。';
  } finally {
    isProcessing.value = false;

    if (ffmpeg) {
      for (const fileName of [inputName, audioName, silentName]) {
        try {
          await ffmpeg.deleteFile(fileName);
        } catch {
          // Ignore cleanup failures from absent files.
        }
      }
    }
  }
}

onBeforeUnmount(() => {
  revokeUrl(selectedFileUrl.value);
  revokeUrl(coreScriptBlobUrl);
  revokeUrl(coreWasmBlobUrl);
  clearOutputs();
});
</script>

<template>
  <main class="page-shell">
    <section class="hero-card">
      <p class="eyebrow">Browser-Only Media Splitter</p>
      <h1>本地拆分视频音频，不走服务端</h1>
      <p class="hero-copy">
        上传一个本地视频，直接在浏览器里导出一份
        <strong>MP3 音频</strong>
        和一份
        <strong>去音轨 MP4</strong>。
      </p>

      <div class="upload-panel">
        <label class="picker">
          <span>选择本地视频</span>
          <input
            accept="video/*"
            type="file"
            @change="handleFileChange"
          />
        </label>

        <button
          class="action-button"
          :disabled="!canStart || isEngineLoading"
          @click="processVideo"
        >
          {{ isProcessing ? '处理中...' : isEngineLoading ? '加载引擎中...' : '开始处理' }}
        </button>
      </div>

      <div
        v-if="selectedFile"
        class="file-summary"
      >
        <div>
          <span class="summary-label">文件</span>
          <strong>{{ selectedFile.name }}</strong>
        </div>
        <div>
          <span class="summary-label">大小</span>
          <strong>{{ formatBytes(selectedFile.size) }}</strong>
        </div>
      </div>

      <div class="status-panel">
        <div class="status-row">
          <span>{{ statusText }}</span>
          <span>{{ progressLabel }}</span>
        </div>
        <div class="progress-track">
          <div
            class="progress-fill"
            :style="{ width: progressLabel }"
          />
        </div>
        <p class="hint-text">{{ hintText }}</p>
      </div>
    </section>

    <section class="preview-grid">
      <article class="glass-card">
        <h2>源视频预览</h2>
        <div
          v-if="selectedFileUrl"
          class="video-frame"
        >
          <video
            :src="selectedFileUrl"
            controls
          />
        </div>
        <p v-else class="empty-text">选择视频后可在这里预览。</p>
      </article>

      <article class="glass-card">
        <h2>处理结果</h2>
        <div class="download-list">
          <a
            v-if="audioOutput"
            class="download-item"
            :download="audioOutput.name"
            :href="audioOutput.url"
          >
            <span>下载 MP3 音频</span>
            <strong>{{ audioOutput.size }}</strong>
          </a>

          <a
            v-if="silentVideoOutput"
            class="download-item"
            :download="silentVideoOutput.name"
            :href="silentVideoOutput.url"
          >
            <span>下载静音 MP4</span>
            <strong>{{ silentVideoOutput.size }}</strong>
          </a>

          <p
            v-if="!audioOutput && !silentVideoOutput"
            class="empty-text"
          >
            处理完成后，这里会出现可下载的文件。
          </p>
        </div>
      </article>
    </section>
  </main>
</template>
