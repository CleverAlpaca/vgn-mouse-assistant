'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// 渲染层与主进程之间的最小桥：窗口控制、系统通知、设备插拔事件
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,

  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),

  getMaxState: () => ipcRenderer.invoke('win:get-max-state'),
  onMaxState: (cb) => ipcRenderer.on('win:max-state', (_e, maximized) => cb(maximized)),

  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  showWebDriver: () => ipcRenderer.send('webdrv:show'),
  hideWebDriver: () => ipcRenderer.send('webdrv:hide'),

  onHidChanged: (cb) => ipcRenderer.on('hid:changed', (_e, info) => cb(info)),
  onVersion: (cb) => ipcRenderer.on('app-version', (_e, version) => cb(version)),
})
