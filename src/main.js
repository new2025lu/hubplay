'use strict';

/**
 * Electron 主进程：拉起本地服务 + 承载界面。
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, shell, Menu, ipcMain, nativeImage, dialog } = require('electron');

const { LocalServer } = require('./server');

const PREFERRED_PORT = 17899;

let mainWindow = null;
let localServer = null;
let serverOrigin = '';

/**
 * 视频解码方式。
 *
 * 用户要的优先级是「**独显 → 核显 → 软件**」，Chromium 的分工是这样：
 *
 *   - 选哪块 GPU：由 `force_high_performance_gpu` 决定。混合显卡的机器上
 *     Chromium 默认会挑省电的那块（通常就是核显）；加上这个开关才会挑独显。
 *     **机器上如果没有独显，这个开关是空操作，自然就落到核显** —— 正好是
 *     「有独显用独显，没有就用核显」。
 *   - 硬解还是软解：Chromium 自己决定。硬件解码器不可用、或驱动被它的
 *     blocklist 挡掉时，它会自动退回软件解码。所以我们能做的是
 *     **别让人为因素把硬解关掉**（那正是 `ignore-gpu-blocklist` 的作用）。
 *   - `software`：显式关掉 GPU 与视频硬解，完全走 CPU。
 *
 * 注意：这些开关必须在 app ready **之前**设置，改了必须重启进程才生效，
 * 所以界面上的切换是「存配置 + 重启」。
 */
const DECODE_MODES = ['auto', 'discrete', 'integrated', 'software'];

/** 从渲染进程那份 config.json 里读解码方式（主进程要在 ready 前知道）。 */
function readDecodeMode() {
  try {
    const file = path.join(app.getPath('userData'), 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return DECODE_MODES.includes(cfg.decodeMode) ? cfg.decodeMode : 'auto';
  } catch (err) {
    return 'auto';   // 首次运行 / 文件还没写
  }
}

const decodeMode = readDecodeMode();

// 直播流要能自动起播
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

if (decodeMode === 'software') {
  // 兜底档：完全软件解码。CPU 够强时最不容易出兼容问题。
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-accelerated-video-decode');
  app.commandLine.appendSwitch('disable-gpu-compositing');
} else {
  if (decodeMode === 'discrete') app.commandLine.appendSwitch('force_high_performance_gpu');
  if (decodeMode === 'integrated') app.commandLine.appendSwitch('force_low_power_gpu');
  // auto：独显优先；没有独显时它不会报错，自然用核显
  if (decodeMode === 'auto') app.commandLine.appendSwitch('force_high_performance_gpu');

  // 显式要求视频硬解。Chromium 默认就开着，写出来是为了让意图明确、
  // 也避免某些发行版/驱动组合下被默认关掉。
  app.commandLine.appendSwitch('enable-accelerated-video-decode');
  /*
   * 关键的一条：Chromium 有一份 GPU/驱动 blocklist，驱动版本稍旧就会把
   * 视频硬解整个关掉（`getGPUFeatureStatus().video_decode` 会变成
   * disabled_software），表现就是「明明有独显却在用 CPU 软解」。
   * 忽略这份 blocklist 是各类播放器/浏览器的常规做法。
   */
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  // Windows 上 HEVC 硬解需要显式打开（部分显卡/驱动支持）
  app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/**
 * 定位随包资源（renderer/、build/）。
 *
 * 打包后本文件在 `…\resources\app.asar\src\main.js` 里，`__dirname/..` 拼出来的
 * `…\app.asar\renderer\index.html` **看启动方式会抽风**：实测同一份包，
 * 某次启动报 `ENOENT, renderer\index.html not found in …\app.asar`（整个界面起不来），
 * 另一次却正常。所以以 Electron 自己的应用根目录 `app.getAppPath()` 为准
 * ——它在 asar 与解包目录两种形态下都是对的；`__dirname/..` 只作为兜底。
 */
function appRoot() {
  try {
    const root = app.getAppPath();
    if (root && root !== __dirname) return root;
  } catch (err) { /* app 还没就绪时忽略 */ }
  return path.join(__dirname, '..');
}

function assetPath(...parts) {
  return path.join(appRoot(), ...parts);
}

async function startServer() {
  const rendererDir = assetPath('renderer');
  const dataDir = app.getPath('userData');

  const attempts = [PREFERRED_PORT, 0];
  let lastError = null;
  for (const port of attempts) {
    const server = new LocalServer({ rendererDir, dataDir, port });
    try {
      const origin = await server.start();
      localServer = server;
      return origin;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('本地服务启动失败');
}

function buildMenu() {
  const template = [
    {
      label: '播放',
      submenu: [
        { label: '重新载入界面', accelerator: 'F5', click: () => mainWindow && mainWindow.reload() },
        { label: '全屏', accelerator: 'F11', click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '重置缩放', role: 'resetZoom' },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', click: () => mainWindow && mainWindow.webContents.toggleDevTools() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 HubPlay',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于 HubPlay',
              message: `HubPlay ${app.getVersion()}`,
              detail:
                `本地服务：${serverOrigin}\n` +
                `数据目录：${app.getPath('userData')}\n\n` +
                '面向 iptv-hub 的桌面 IPTV 播放器。\n' +
                '内置 ffmpeg 兜底：Chromium 解不了的源（MPEG-2 / MP2 / HEVC / AC-3 等）自动转码播放。\n' +
                '本程序只做地址聚合与播放，不转播、不缓存任何媒体流。',
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const iconPath = assetPath('build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0a0f',
    title: 'HubPlay',
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverOrigin)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  await mainWindow.loadURL(`${serverOrigin}/`);
  return mainWindow;
}

app.whenReady().then(async () => {
  try {
    serverOrigin = await startServer();
  } catch (err) {
    dialog.showErrorBox('本地服务启动失败', String((err && err.message) || err));
    app.quit();
    return;
  }

  buildMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async () => {
  if (localServer) {
    try {
      await localServer.stop();
    } catch (err) {
      /* 退出阶段忽略 */
    }
    localServer = null;
  }
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: process.platform,
  origin: serverOrigin,
  userData: app.getPath('userData'),
}));

/**
 * 报告真实的解码/显卡状态，好让界面能回答「我现在到底在用独显硬解还是软件解」。
 *
 * `getGPUFeatureStatus().video_decode` 是 Chromium 自己的结论：
 *   enabled            → 视频硬解可用
 *   disabled_software  → 退回软件解码（最常见的原因是驱动在 blocklist 里）
 *   disabled_off       → 被关掉
 *   unavailable_software / disabled_off_ok 等也都是「没有硬解」
 */
ipcMain.handle('app:gpu', async () => {
  let devices = [];
  try {
    const info = await app.getGPUInfo('basic');
    devices = (info && info.gpuDevice) || [];
  } catch (err) {
    /* 拿不到就算了，下面还有 feature status */
  }
  return {
    decodeMode,
    featureStatus: app.getGPUFeatureStatus(),
    devices: devices.map((d) => ({
      vendorId: d.vendorId, deviceId: d.deviceId,
      active: !!d.active, name: d.deviceString || d.driverVendor || '',
    })),
  };
});

/** 切换解码方式：写进 config.json，然后重启进程（命令行开关只能启动时生效）。 */
ipcMain.handle('app:set-decode-mode', async (_event, mode) => {
  if (!DECODE_MODES.includes(mode)) return { ok: false, error: '未知的解码方式' };
  try {
    const file = path.join(app.getPath('userData'), 'config.json');
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      cfg = {};
    }
    cfg.decodeMode = mode;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  // 重启才能让新的命令行开关生效
  app.relaunch();
  setTimeout(() => app.exit(0), 200);
  return { ok: true, restarting: true };
});

ipcMain.handle('app:fullscreen', () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});

ipcMain.handle('app:open-external', (_event, url) => {
  if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url);
});

/** 打开本地视频文件（支持多选） */
ipcMain.handle('app:open-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '视频文件',
        extensions: ['mp4', 'mkv', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mov', 'm4v',
          'mpg', 'mpeg', 'rmvb', 'rm', 'webm', '3gp', 'vob', 'asf', 'divx', 'f4v'],
      },
      { name: '音频文件', extensions: ['mp3', 'aac', 'flac', 'm4a', 'wav', 'ogg', 'opus'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths || [];
});
