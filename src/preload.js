'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('hubplay', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  toggleFullscreen: () => ipcRenderer.invoke('app:fullscreen'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  /**
   * 拖进来的 File 对象拿真实磁盘路径。
   * Electron 32 起 File.path 已被移除，必须走 webUtils。
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (err) {
      return file && file.path ? file.path : '';
    }
  },

  /** 弹系统文件对话框选视频 */
  openFiles: () => ipcRenderer.invoke('app:open-files'),

  /** 真实的显卡 / 视频硬解状态（独显核显、硬解是否生效） */
  gpuInfo: () => ipcRenderer.invoke('app:gpu'),

  /** 切换解码方式（auto/discrete/integrated/software）。会重启应用。 */
  setDecodeMode: (mode) => ipcRenderer.invoke('app:set-decode-mode', mode),
});
