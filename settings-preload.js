'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
    getConfig:      ()                => ipcRenderer.invoke('settings:get'),
    saveConfig:     (data)            => ipcRenderer.invoke('settings:save', data),
    pickFolder:     ()                => ipcRenderer.invoke('settings:pick-folder'),
    testConnection: (baseUrl, token)  => ipcRenderer.invoke('settings:test', baseUrl, token),
});
