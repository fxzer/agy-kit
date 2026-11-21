'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const childProcess = require('child_process');

const DEFAULT_APP_BUNDLE = '/Applications/Antigravity.app';
const DEFAULT_UPDATE_CONFIG = path.join(DEFAULT_APP_BUNDLE, 'Contents', 'Resources', 'app-update.yml');
const DEFAULT_CACHE_DIR = path.join(os.homedir(), 'Library', 'Caches', 'com.google.antigravity');
const FALLBACK_MANIFEST_BASE = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/';

function getCurrentVersion(appBundle = DEFAULT_APP_BUNDLE) {
  const plistPath = path.join(appBundle, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) return null;
  try {
    return childProcess.execFileSync('/usr/libexec/PlistBuddy', [
      '-c', 'Print :CFBundleShortVersionString',
      plistPath
    ], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function getManifestUrl(options = {}) {
  const appBundle = options.appBundle || DEFAULT_APP_BUNDLE;
  const configPath = path.join(appBundle, 'Contents', 'Resources', 'app-update.yml');
  let baseUrl = FALLBACK_MANIFEST_BASE;
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(/url:\s*([^\r\n]+)/);
    if (match) baseUrl = match[1].trim();
  }
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  const arch = options.arch || process.arch;
  const fileName = arch === 'arm64' ? 'latest-arm64-mac.yml' : 'latest-x64-mac.yml';
  return `${baseUrl}${fileName}`;
}

function parseManifest(text) {
  const versionMatch = text.match(/version:\s*([^\r\n]+)/);
  const version = versionMatch ? versionMatch[1].trim().replace(/^['"]|['"]$/g, '') : null;
  const urlMatch = text.match(/url:\s*([^\r\n]+)/);
  const url = urlMatch ? urlMatch[1].trim().replace(/^['"]|['"]$/g, '') : null;
  const shaMatch = text.match(/sha512:\s*([^\r\n]+)/);
  const sha512 = shaMatch ? shaMatch[1].trim().replace(/^['"]|['"]$/g, '') : null;
  const sizeMatch = text.match(/size:\s*(\d+)/);
  const size = sizeMatch ? Number(sizeMatch[1]) : 0;
  return { version, url, sha512, size };
}

function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;
  const p1 = v1.split('.').map(n => parseInt(n, 10) || 0);
  const p2 = v2.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`请求失败，HTTP 状态码: ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function verifySha512(filePath, expectedSha512) {
  if (!expectedSha512 || !fs.existsSync(filePath)) return false;
  const hash = crypto.createHash('sha512');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  const digestBase64 = hash.digest('base64');
  return digestBase64 === expectedSha512;
}

function checkCachedPackage(options = {}) {
  const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR;
  const cachedFile = path.join(cacheDir, 'pending', 'Antigravity.zip');
  if (!fs.existsSync(cachedFile)) return null;
  if (options.expectedSha512 && !verifySha512(cachedFile, options.expectedSha512)) {
    return null;
  }
  return cachedFile;
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.rmSync(destPath, { force: true });
        return resolve(downloadFile(res.headers.location, destPath, onProgress));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.rmSync(destPath, { force: true });
        return reject(new Error(`下载失败，HTTP 状态码: ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (typeof onProgress === 'function') onProgress(downloaded, total);
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(destPath));
      });
    }).on('error', (err) => {
      file.close();
      fs.rmSync(destPath, { force: true });
      reject(err);
    });
  });
}

function assertAppClosed() {
  try {
    const out = childProcess.execFileSync('/usr/bin/pgrep', ['-f', 'Contents/MacOS/Antigravity'], { encoding: 'utf8' });
    if (out.trim().length > 0) {
      throw new Error('请先完全退出 Antigravity（按 Cmd+Q 彻底关闭），再运行更新命令。');
    }
  } catch (error) {
    if (error.message.includes('请先完全退出')) throw error;
  }
}

async function checkUpdate(options = {}) {
  const appBundle = options.appBundle || DEFAULT_APP_BUNDLE;
  const currentVersion = getCurrentVersion(appBundle);
  const manifestUrl = getManifestUrl(options);
  const manifestText = await fetchText(manifestUrl);
  const manifest = parseManifest(manifestText);
  if (!manifest.version || !manifest.url) {
    throw new Error('无法从更新服务器获取有效的版本清单。');
  }
  const hasUpdate = compareVersions(manifest.version, currentVersion) > 0;
  return {
    currentVersion,
    latestVersion: manifest.version,
    hasUpdate,
    manifest,
    manifestUrl
  };
}

async function updateClient(options = {}) {
  const appBundle = options.appBundle || DEFAULT_APP_BUNDLE;
  const persistence = options.persistence || require('./persistence');
  const logger = options.logger || console;

  logger.log('🔍 [agy-kit] 正在检查官方 Antigravity 最新版本...');
  const check = await checkUpdate(options);
  logger.log(`  - 本地当前版本: ${check.currentVersion || '未知'}`);
  logger.log(`  - 官方最新版本: ${check.latestVersion}`);

  if (!check.hasUpdate && !options.force) {
    logger.log('✨ 当前已是最新版本，无需升级。如需强制重装官方原版并应用补丁，可传入 --force。');
    return { updated: false, version: check.currentVersion };
  }

  assertAppClosed();

  let zipPath = checkCachedPackage({
    cacheDir: options.cacheDir,
    expectedSha512: check.manifest.sha512
  });

  if (zipPath) {
    logger.log(`📦 检测到本地完整安装包缓存: ${zipPath}（哈希校验通过，免下载）`);
  } else {
    logger.log(`🌐 正在从官方源下载最新原版包: ${check.manifest.url}`);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-kit-dl-'));
    zipPath = path.join(tempDir, 'Antigravity.zip');
    let lastPercent = -1;
    await downloadFile(check.manifest.url, zipPath, (downloaded, total) => {
      if (total > 0) {
        const percent = Math.floor((downloaded / total) * 100);
        if (percent !== lastPercent && percent % 10 === 0) {
          logger.log(`  - 下载进度: ${percent}% (${Math.round(downloaded / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`);
          lastPercent = percent;
        }
      }
    });

    if (check.manifest.sha512 && !verifySha512(zipPath, check.manifest.sha512)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw new Error('下载的安装包 SHA512 校验失败，文件可能已损坏。');
    }
    logger.log('✅ 下载完成并校验通过。');
  }

  logger.log('🔨 正在解压并覆盖安装官方原版...');
  const unpackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-kit-extract-'));
  try {
    childProcess.execFileSync('/usr/bin/ditto', ['-xk', zipPath, unpackDir]);
    const stagedApp = path.join(unpackDir, 'Antigravity.app');
    if (!fs.existsSync(stagedApp)) {
      throw new Error('安装包解压异常，未找到 Antigravity.app。');
    }

    fs.rmSync(appBundle, { recursive: true, force: true });
    childProcess.execFileSync('/usr/bin/ditto', [stagedApp, appBundle]);
    try {
      childProcess.execFileSync('/usr/bin/xattr', ['-cr', appBundle]);
    } catch {}
    logger.log(`✅ 官方原版已成功更新至 v${check.latestVersion}。`);
  } finally {
    fs.rmSync(unpackDir, { recursive: true, force: true });
  }

  logger.log('⚡ 正在对新版客户端重新打入 agy-kit 增强补丁（含中文会话标题与 UI 挂载）...');
  const installResult = persistence.installPersistent();
  logger.log('✅ agy-kit 已成功写入新版客户端并完成代码签名。');
  if (installResult.zhTitlePatch?.patched) {
    logger.log('✅ 中文会话标题补丁已就绪。');
  }

  logger.log(`\n🎉 [agy-kit] 升级完成！Antigravity 现已升至 v${check.latestVersion}，请重新启动客户端。`);
  return { updated: true, version: check.latestVersion };
}

module.exports = {
  getCurrentVersion,
  getManifestUrl,
  parseManifest,
  compareVersions,
  fetchText,
  verifySha512,
  checkCachedPackage,
  checkUpdate,
  updateClient
};
