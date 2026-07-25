# 🎵 BiliAudio — 轻量B站音频播放器

> 只播音频不播视频，内存占用仅为 B站网页版的 **1/50**

[![License](https://img.shields.io/badge/license-MIT-pink)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-brightgreen)](https://nodejs.org/)

## ✨ 特性

- 🔗 **一键解析** — 支持B站链接、BV号、AV号、b23.tv 短链接
- 🎧 **纯音频播放** — 后端代理音频流，前端只渲染 `<audio>`，零视频帧开销
- 📋 **合集加载** — 自动识别视频所属合集，一键加载全部歌曲到歌单
- 📁 **歌单管理** — 多歌单创建/切换，单曲或批量加入播放队列
- 💿 **视觉动效** — 黑胶唱片旋转、8段频谱跳动、进度条流光（纯 CSS，GPU 加速）
- 📱 **手机适配** — 响应式布局，移动端触摸优化
- ⌨️ **快捷键** — `空格` 暂停 / `←→` 快进快退 5s / `↑↓` 调节音量
- 🖥️ **局域网共享** — 启动后同 WiFi 下其他设备可直接访问
- ⚡ **零依赖** — Node.js 内置模块，无需 `npm install`

## 🚀 快速开始

### 前提

- [Node.js](https://nodejs.org/) ≥ 18（推荐 22）

### 运行

```bash
# 克隆仓库
git clone https://github.com/cggpro/BiliAudio.git
cd BiliAudio

# 启动服务（默认端口 7789）
node server.js
```

浏览器打开 `http://localhost:7789`，粘贴 B站链接即可收听。

> 如需自定义端口：`PORT=3000 node server.js`（Linux/macOS）或 `set PORT=3000 && node server.js`（Windows CMD）。

## 📦 目录结构

```
BiliAudio/
├── server.js          # 后端：API 代理 + 音频流 + Wbi 签名
├── package.json       # 项目配置
├── public/
│   └── index.html     # 前端：播放器 UI（纯原生 HTML/CSS/JS）
└── README.md
```

## 🔧 部署到服务器

```bash
# 上传项目到服务器
scp -r BiliAudio/ root@你的服务器IP:/opt/

# SSH 登录后
cd /opt/BiliAudio

# 使用 pm2 守护进程
npm install -g pm2
pm2 start server.js --name bili-audio
pm2 save
```

配合 Nginx / Caddy / 1Panel 反代可启用 HTTPS：

```nginx
# Nginx 反代示例
location / {
    proxy_pass http://127.0.0.1:7789;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

## 🎮 使用说明

| 操作 | 方式 |
|------|------|
| 添加歌曲 | 输入链接 → 选择目标歌单 → 点击"解析" |
| 创建歌单 | 目标选择"🆕 新建歌单" |
| 加载合集 | 歌单标签或展开区点击 📋 |
| 单曲加队列 | 歌单中每首歌右侧点击 ＋ |
| 全部播放 | 歌单展开区点击 ▶ |
| 清空队列 | 队列头部点击 🗑️ |

## 🛠️ 技术实现

- **Wbi 签名** — 完整实现 B站 API v3 签名算法，支持签名降级
- **多 CDN 降级** — 同时请求 DASH / mp4 格式，主 CDN 不可达时自动切换备用节点
- **音频流代理** — 后端获取 CDN 音频 URL 后 `pipe` 到前端，支持 Range 请求（拖拽进度条）
- **图片代理** — 解决 B站封面图跨域拦截问题
- **增量渲染** — 切歌只改 CSS class，不重建 DOM 节点
- **节流更新** — 进度条 200ms 更新一次，减少重绘
- **纯 CSS 动效** — 黑胶唱片 `conic-gradient` + `@keyframes spin`，零 JS 开销
- **`content-visibility: auto`** — 长列表跳过屏幕外渲染，提升性能
- **内存缓存** — 视频信息 / 合集 / 音频 URL 分级缓存，命中后秒级响应

## 📄 许可

MIT License © [cggpro](https://github.com/cggpro)
