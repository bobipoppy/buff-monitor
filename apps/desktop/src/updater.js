const { app, dialog, shell, Notification, BrowserWindow } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const GITHUB_REPO = 'bobipoppy/buff-monitor';
const CURRENT_VERSION = app.getVersion();

let updateState = {
  checking: false,
  available: false,
  downloading: false,
  progress: 0,
  latestVersion: null,
  releaseNotes: '',
  downloadUrl: '',
  dmgPath: '',
  error: null,
};

function getState() {
  return { ...updateState, currentVersion: CURRENT_VERSION };
}

async function checkForUpdates(silent = false) {
  if (updateState.checking) return updateState;
  updateState.checking = true;
  updateState.error = null;

  try {
    const release = await fetchLatestRelease();
    const latestVersion = release.tag_name.replace(/^v/, '');

    if (isNewerVersion(latestVersion, CURRENT_VERSION)) {
      const dmgAsset = release.assets.find((a) => a.name.endsWith('.dmg'));
      updateState.available = true;
      updateState.latestVersion = latestVersion;
      updateState.releaseNotes = release.body || '';
      updateState.downloadUrl = dmgAsset?.browser_download_url || '';

      if (!silent) {
        new Notification({
          title: 'BUFF Monitor 有新版本',
          body: `v${latestVersion} 可用，当前 v${CURRENT_VERSION}`,
        }).show();
      }
    } else {
      updateState.available = false;
      updateState.latestVersion = latestVersion;
      if (!silent) {
        new Notification({ title: 'BUFF Monitor', body: '当前已是最新版本' }).show();
      }
    }
  } catch (err) {
    updateState.error = err.message;
    console.error('[Updater] Check failed:', err.message);
  } finally {
    updateState.checking = false;
  }

  return updateState;
}

async function downloadAndInstall() {
  if (!updateState.available || !updateState.downloadUrl) {
    throw new Error('No update available');
  }
  if (updateState.downloading) return;

  updateState.downloading = true;
  updateState.progress = 0;
  updateState.error = null;

  try {
    const tmpDir = app.getPath('temp');
    const dmgName = `BUFF-Monitor-${updateState.latestVersion}.dmg`;
    const dmgPath = path.join(tmpDir, dmgName);

    await downloadFile(updateState.downloadUrl, dmgPath, (progress) => {
      updateState.progress = progress;
      notifyProgress(progress);
    });

    updateState.dmgPath = dmgPath;
    updateState.downloading = false;
    updateState.progress = 100;

    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'info',
      title: '更新下载完成',
      message: `BUFF Monitor v${updateState.latestVersion} 已下载完成`,
      detail: '点击"安装并重启"将打开 DMG 并退出当前应用，请手动拖入 Applications 文件夹完成更新。',
      buttons: ['安装并重启', '稍后安装'],
      defaultId: 0,
    });

    if (result.response === 0) {
      await installUpdate(dmgPath);
    }
  } catch (err) {
    updateState.error = err.message;
    updateState.downloading = false;
    console.error('[Updater] Download failed:', err.message);
    throw err;
  }
}

async function installUpdate(dmgPath) {
  try {
    execSync(`open "${dmgPath}"`);
    setTimeout(() => {
      app.isQuitting = true;
      app.quit();
    }, 1500);
  } catch (err) {
    shell.showItemInFolder(dmgPath);
  }
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': `BUFF-Monitor/${CURRENT_VERSION}`,
        'Accept': 'application/vnd.github+json',
      },
    };

    const req = https.request(options, handleResponse(resolve, reject));
    req.on('error', reject);
    req.end();
  });
}

function handleResponse(resolve, reject) {
  return (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        if (res.statusCode !== 200) reject(new Error(`GitHub API: ${res.statusCode}`));
        else resolve(JSON.parse(data));
      } catch (e) { reject(e); }
    });
    res.on('error', reject);
  };
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (url.startsWith('https') ? https : http).get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(res.headers.location, dest, onProgress).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }

      const totalSize = parseInt(res.headers['content-length'], 10) || 0;
      let downloaded = 0;

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalSize > 0) {
          onProgress(Math.round((downloaded / totalSize) * 100));
        }
      });

      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    });

    request.on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function isNewerVersion(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

function notifyProgress(progress) {
  const win = BrowserWindow.getFocusedWindow();
  if (win) {
    win.setProgressBar(progress / 100);
    if (progress >= 100) win.setProgressBar(-1);
  }
}

module.exports = { checkForUpdates, downloadAndInstall, getState, CURRENT_VERSION };
