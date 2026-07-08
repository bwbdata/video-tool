# video-tool

一个基于 Vue 3 + TypeScript + Vite 的纯前端视频处理工具。

功能：

- 上传本地视频文件
- 在浏览器本地提取音频并导出 `MP3`
- 在浏览器本地移除音轨并导出 `MP4`
- 不把用户视频上传到服务端参与处理

## 启动

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

## 说明

- 视频处理使用 `ffmpeg.wasm`
- 文件处理过程发生在本地浏览器
- 首次使用时，浏览器需要加载一次 `ffmpeg` 的 wasm 核心资源；之后通常会被缓存
