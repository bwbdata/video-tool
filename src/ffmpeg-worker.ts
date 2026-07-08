/// <reference lib="webworker" />
export {};

const FFMessageType = {
  LOAD: 'LOAD',
  EXEC: 'EXEC',
  FFPROBE: 'FFPROBE',
  WRITE_FILE: 'WRITE_FILE',
  READ_FILE: 'READ_FILE',
  DELETE_FILE: 'DELETE_FILE',
  RENAME: 'RENAME',
  CREATE_DIR: 'CREATE_DIR',
  LIST_DIR: 'LIST_DIR',
  DELETE_DIR: 'DELETE_DIR',
  ERROR: 'ERROR',
  PROGRESS: 'PROGRESS',
  LOG: 'LOG',
  MOUNT: 'MOUNT',
  UNMOUNT: 'UNMOUNT',
} as const;

type MessageType = (typeof FFMessageType)[keyof typeof FFMessageType];

type FFmpegCoreModule = {
  FS: {
    writeFile: (path: string, data: Uint8Array | string) => void;
    readFile: (path: string, options?: { encoding?: string }) => Uint8Array | string;
    unlink: (path: string) => void;
    rename: (oldPath: string, newPath: string) => void;
    mkdir: (path: string) => void;
    readdir: (path: string) => string[];
    stat: (path: string) => { mode: number };
    isDir: (mode: number) => boolean;
    rmdir: (path: string) => void;
    mount: (fs: unknown, options: unknown, mountPoint: string) => void;
    unmount: (mountPoint: string) => void;
    filesystems: Record<string, unknown>;
  };
  exec: (...args: string[]) => void;
  ffprobe: (...args: string[]) => void;
  setLogger: (logger: (data: unknown) => void) => void;
  setProgress: (handler: (data: { progress: number; time: number }) => void) => void;
  setTimeout: (timeout: number) => void;
  reset: () => void;
  ret: number;
};

type LoadPayload = {
  coreURL?: string;
  wasmURL?: string;
  workerURL?: string;
};

type MessagePayload = {
  id: number;
  type: MessageType;
  data: unknown;
};

type CreateFFmpegCore = (config: { mainScriptUrlOrBlob: string }) => Promise<FFmpegCoreModule>;

declare global {
  interface WorkerGlobalScope {
    createFFmpegCore?: CreateFFmpegCore;
  }
}

const workerScope = self as DedicatedWorkerGlobalScope & typeof globalThis & {
  createFFmpegCore?: CreateFFmpegCore;
};

const ERROR_UNKNOWN_MESSAGE_TYPE = new Error('unknown message type');
const ERROR_NOT_LOADED = new Error('ffmpeg is not loaded, call `await ffmpeg.load()` first');
const ERROR_IMPORT_FAILURE = new Error('failed to import ffmpeg-core.js');

let ffmpeg: FFmpegCoreModule | undefined;

async function load({
  coreURL,
  wasmURL,
  workerURL,
}: LoadPayload): Promise<boolean> {
  const first = !ffmpeg;

  if (!coreURL) {
    throw new Error('coreURL is required');
  }

  try {
    workerScope.importScripts(coreURL);
  } catch {
    const imported = await import(/* @vite-ignore */ coreURL);
    workerScope.createFFmpegCore = imported.default as CreateFFmpegCore | undefined;
  }

  if (!workerScope.createFFmpegCore) {
    throw ERROR_IMPORT_FAILURE;
  }

  ffmpeg = await workerScope.createFFmpegCore({
    // Single-thread core package does not ship a separate worker file.
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({
      wasmURL: wasmURL ?? coreURL.replace(/\.js$/g, '.wasm'),
      workerURL: workerURL ?? coreURL,
    }))}`,
  });

  ffmpeg.setLogger((data) => {
    workerScope.postMessage({ type: FFMessageType.LOG, data });
  });

  ffmpeg.setProgress((data) => {
    workerScope.postMessage({
      type: FFMessageType.PROGRESS,
      data,
    });
  });

  return first;
}

function exec(payload: { args: string[]; timeout?: number }): number {
  if (!ffmpeg) {
    throw ERROR_NOT_LOADED;
  }

  const instance = ffmpeg;
  instance.setTimeout(payload.timeout ?? -1);
  instance.exec(...payload.args);
  const ret = instance.ret;
  instance.reset();
  return ret;
}

function ffprobe(payload: { args: string[]; timeout?: number }): number {
  if (!ffmpeg) {
    throw ERROR_NOT_LOADED;
  }

  const instance = ffmpeg;
  instance.setTimeout(payload.timeout ?? -1);
  instance.ffprobe(...payload.args);
  const ret = instance.ret;
  instance.reset();
  return ret;
}

workerScope.onmessage = async ({ data }: MessageEvent<MessagePayload>) => {
  const trans: Transferable[] = [];
  let responseData: unknown;

  try {
    if (data.type !== FFMessageType.LOAD && !ffmpeg) {
      throw ERROR_NOT_LOADED;
    }

    switch (data.type) {
      case FFMessageType.LOAD:
        responseData = await load(data.data as LoadPayload);
        break;
      case FFMessageType.EXEC:
        responseData = exec(data.data as { args: string[]; timeout?: number });
        break;
      case FFMessageType.FFPROBE:
        responseData = ffprobe(data.data as { args: string[]; timeout?: number });
        break;
      case FFMessageType.WRITE_FILE: {
        const payload = data.data as { path: string; data: Uint8Array | string };
        ffmpeg!.FS.writeFile(payload.path, payload.data);
        responseData = true;
        break;
      }
      case FFMessageType.READ_FILE: {
        const payload = data.data as { path: string; encoding?: string };
        responseData = ffmpeg!.FS.readFile(payload.path, { encoding: payload.encoding });
        break;
      }
      case FFMessageType.DELETE_FILE: {
        const payload = data.data as { path: string };
        ffmpeg!.FS.unlink(payload.path);
        responseData = true;
        break;
      }
      case FFMessageType.RENAME: {
        const payload = data.data as { oldPath: string; newPath: string };
        ffmpeg!.FS.rename(payload.oldPath, payload.newPath);
        responseData = true;
        break;
      }
      case FFMessageType.CREATE_DIR: {
        const payload = data.data as { path: string };
        ffmpeg!.FS.mkdir(payload.path);
        responseData = true;
        break;
      }
      case FFMessageType.LIST_DIR: {
        const payload = data.data as { path: string };
        responseData = ffmpeg!.FS.readdir(payload.path).map((name) => {
          const stat = ffmpeg!.FS.stat(`${payload.path}/${name}`);
          return { name, isDir: ffmpeg!.FS.isDir(stat.mode) };
        });
        break;
      }
      case FFMessageType.DELETE_DIR: {
        const payload = data.data as { path: string };
        ffmpeg!.FS.rmdir(payload.path);
        responseData = true;
        break;
      }
      case FFMessageType.MOUNT: {
        const payload = data.data as {
          fsType: string;
          options: unknown;
          mountPoint: string;
        };
        const fs = ffmpeg!.FS.filesystems[payload.fsType];
        responseData = Boolean(fs);

        if (fs) {
          ffmpeg!.FS.mount(fs, payload.options, payload.mountPoint);
        }

        break;
      }
      case FFMessageType.UNMOUNT: {
        const payload = data.data as { mountPoint: string };
        ffmpeg!.FS.unmount(payload.mountPoint);
        responseData = true;
        break;
      }
      default:
        throw ERROR_UNKNOWN_MESSAGE_TYPE;
    }
  } catch (error) {
    workerScope.postMessage({
      id: data.id,
      type: FFMessageType.ERROR,
      data: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (responseData instanceof Uint8Array) {
    trans.push(responseData.buffer);
  }

  workerScope.postMessage(
    {
      id: data.id,
      type: data.type,
      data: responseData,
    },
    trans,
  );
};
