const path = require('path');
const Module = require('module');

// 打包后 node_modules 在 app 根目录，确保子模块能正确解析
const appRoot = path.join(__dirname, '..');
const nodeModulesPath = path.join(appRoot, 'node_modules');
if (!Module.globalPaths.includes(nodeModulesPath)) {
  Module.globalPaths.unshift(nodeModulesPath);
}

const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, shell } = require('electron');
const { startServer, stopServer } = require('./server');
const { initDatabase } = require('./database');
const { checkForUpdates, downloadAndInstall, getState: getUpdateState } = require('./updater');
const Store = require('electron-store');

const store = new Store();
let mainWindow = null;
let tray = null;
let serverPort = 3001;
const isDev = !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0f0f1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const webUrl = isDev ? 'http://localhost:3000' : `http://localhost:${serverPort}`;
  mainWindow.loadURL(webUrl);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('BUFF Monitor - 饰品价格监控');

  const contextMenu = Menu.buildFromTemplate([
    { label: '打开主界面', click: () => showWindow() },
    { type: 'separator' },
    { label: '立即检查价格', click: () => triggerPriceCheck() },
    { label: '暂停监控', type: 'checkbox', checked: false, click: (item) => toggleMonitor(item.checked) },
    { type: 'separator' },
    { label: '设置', click: () => { showWindow(); mainWindow?.webContents.send('navigate', '/settings'); } },
    { type: 'separator' },
    { label: '检查更新', click: () => triggerUpdateCheck() },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => showWindow());
}

function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function quitApp() {
  app.isQuitting = true;
  stopServer();
  app.quit();
}

async function triggerPriceCheck() {
  try {
    await fetch(`http://localhost:${serverPort}/api/alerts/check`, { method: 'POST' });
  } catch (err) {
    console.error('Price check failed:', err);
  }
}

function toggleMonitor(paused) {
  fetch(`http://localhost:${serverPort}/api/scheduler/${paused ? 'pause' : 'resume'}`, { method: 'POST' }).catch(console.error);
}

function setupAppMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: '检查更新...', click: () => triggerUpdateCheck() },
        { type: 'separator' },
        { label: '设置...', accelerator: 'Cmd+,', click: () => { showWindow(); } },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: '退出', accelerator: 'Cmd+Q', click: () => quitApp() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function triggerUpdateCheck() {
  const state = await checkForUpdates(false);
  if (state.available) {
    const { response } = await require('electron').dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `BUFF Monitor v${state.latestVersion} 可用`,
      detail: `当前版本: v${app.getVersion()}\n\n更新内容:\n${state.releaseNotes?.slice(0, 500) || '(无说明)'}`,
      buttons: ['下载更新', '稍后再说', '打开发布页'],
      defaultId: 0,
    });
    if (response === 0) {
      downloadAndInstall().catch((err) => {
        require('electron').dialog.showErrorBox('更新失败', err.message);
      });
    } else if (response === 2) {
      shell.openExternal(`https://github.com/bobipoppy/buff-monitor/releases/latest`);
    }
  }
}

ipcMain.handle('get-config', (_event, key) => {
  return store.get(key);
});

ipcMain.handle('set-config', (_event, key, value) => {
  store.set(key, value);
});

ipcMain.handle('show-notification', (_event, title, body) => {
  new Notification({ title, body }).show();
});

app.whenReady().then(async () => {
  try {
    initDatabase();
    serverPort = await startServer();
    console.log(`API server started on port ${serverPort}`);
  } catch (err) {
    console.error('Failed to start:', err);
  }

  setupAppMenu();
  createWindow();
  createTray();

  setTimeout(() => checkForUpdates(true), 10000);

  app.on('activate', () => {
    if (mainWindow === null) createWindow();
    else mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  // macOS: keep running in tray
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopServer();
});
