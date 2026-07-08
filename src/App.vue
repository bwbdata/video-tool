<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

type OutputFile = {
  name: string;
  url: string;
  size: string;
};

const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

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

    await instance.load({
      coreURL: await toBlobURL(`${CDN_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CDN_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      workerURL: await toBlobURL(`${CDN_BASE}/ffmpeg-core.worker.js`, 'text/javascript'),
    });

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

    statusText.value = '正在写入本地文件到处理引擎。';
    await worker.writeFile(inputName, await fetchFile(sourceFile));

    try {
      progress.value = 0;
      statusText.value = '正在提取 MP3 音频。';
      await worker.exec([
        '-i',
        inputName,
        '-vn',
        '-c:a',
        'libmp3lame',
        '-q:a',
        '2',
        audioName,
      ]);
      audioOutput.value = await exportBlob(worker, audioName, 'audio/mpeg');
    } catch {
      audioOutput.value = null;
    }

    progress.value = 0;
    statusText.value = '正在导出去音轨 MP4。';
    await worker.exec([
      '-i',
      inputName,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      silentName,
    ]);
    silentVideoOutput.value = await exportBlob(worker, silentName, 'video/mp4');

    statusText.value = audioOutput.value
      ? '处理完成，可以分别下载 MP3 和静音 MP4。'
      : '视频处理完成，但未导出 MP3，原视频可能没有可提取的音轨。';
    hintText.value = ffmpegReady.value
      ? '处理引擎已经驻留在当前页面，继续处理其他视频会更快。'
      : hintText.value;
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    statusText.value = `处理失败：${message}`;
    hintText.value = '请尝试更换文件，或使用体积更小、编码更常见的视频。';
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
