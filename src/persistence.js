'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { readHeader, readAsarFile, extractAll, packDirectory, getHeaderHash } = require('./asar-engine');

const DEFAULT_APP_BUNDLE = '/Applications/Antigravity.app';
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.gemini', 'agy-kit');
const HOOK_MARKER = '/* AGY_KIT_STARTUP_HOOK_V8 */';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyDirectory(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  if (fs.existsSync(source)) fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  else fs.mkdirSync(destination, { recursive: true });
}

function hashDirectory(directory) {
  const hash = crypto.createHash('sha256');
  function walk(current, relative = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      hash.update(rel);
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target, rel);
      else if (entry.isFile()) hash.update(fs.readFileSync(target));
      else throw new Error(`不支持的 ASAR unpacked 项：${rel}`);
    }
  }
  if (fs.existsSync(directory)) walk(directory);
  return hash.digest('hex');
}

function defaultAssertAppClosed() {
  try {
    childProcess.execFileSync('/usr/bin/pgrep', ['-x', 'Antigravity'], { stdio: 'ignore' });
    throw new Error('请先完全退出 Antigravity，再运行持久安装或恢复。');
  } catch (error) {
    if (error.message.includes('请先完全退出')) throw error;
    if (error.status !== 1) throw error;
  }
}

function getDeclaredAsarHash(infoPlist) {
  return childProcess.execFileSync('/usr/libexec/PlistBuddy', [
    '-c', 'Print :ElectronAsarIntegrity:Resources/app.asar:hash',
    infoPlist
  ], { encoding: 'utf8' }).trim();
}

function setIntegrityHash(infoPlist, hash) {
  childProcess.execFileSync('/usr/libexec/PlistBuddy', [
    '-c', `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`,
    infoPlist
  ], { stdio: 'pipe' });
}

function defaultSignApp(appBundle) {
  childProcess.execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'inherit' });
}

function startupHookSha256() {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'startup-hook.js'))).digest('hex');
}

function patchMain(mainPath) {
  const source = fs.readFileSync(mainPath, 'utf8');
  const anchor = 'const gotTheLock = electron_1.app.requestSingleInstanceLock();';
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex < 0) throw new Error('当前 Antigravity 主进程入口与安装器预期不匹配，未修改客户端。');
  const existingMarkers = source.match(/\/\* AGY_KIT_STARTUP_HOOK_V\d+ \*\//g) || [];
  if (existingMarkers.length > 1) throw new Error('主进程中存在多个 agy-kit 启动钩子，拒绝自动更新。');
  if (existingMarkers.length === 1 && source.includes(HOOK_MARKER)) return false;
  const hook = HOOK_MARKER + '\n' + fs.readFileSync(path.join(__dirname, 'startup-hook.js'), 'utf8') + '\n';
  if (existingMarkers.length === 1) {
    const markerIndex = source.indexOf(existingMarkers[0]);
    if (markerIndex < 0 || markerIndex > anchorIndex) throw new Error('旧版 agy-kit 启动钩子位置异常，拒绝自动更新。');
    fs.writeFileSync(mainPath, source.slice(0, markerIndex) + hook + source.slice(anchorIndex));
  } else {
    fs.writeFileSync(mainPath, source.slice(0, anchorIndex) + hook + source.slice(anchorIndex));
  }
  return true;
}

function createPersistence(config = {}) {
  const APP_BUNDLE = config.appBundle || DEFAULT_APP_BUNDLE;
  const RESOURCES = path.join(APP_BUNDLE, 'Contents', 'Resources');
  const ASAR_PATH = path.join(RESOURCES, 'app.asar');
  const INFO_PLIST = path.join(APP_BUNDLE, 'Contents', 'Info.plist');
  const PAYLOAD_DEST = path.join(RESOURCES, 'agy-kit-payload.js');
  const STATE_DIR = config.stateDir || DEFAULT_STATE_DIR;
  const STATE_FILE = path.join(STATE_DIR, 'install-state.json');
  const platform = config.platform || process.platform;
  const assertAppClosed = config.assertAppClosed || defaultAssertAppClosed;
  const signApp = config.signApp || (() => defaultSignApp(APP_BUNDLE));
  const getRendererSource = config.getRendererSource || (() => require('./renderer-source')());

  function writeState(state) {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, STATE_FILE);
  }

  function getPreviousState() {
    if (!fs.existsSync(STATE_FILE)) return null;
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { throw new Error(`安装状态文件无法解析：${STATE_FILE}`); }
  }

  function inspectBundle(prior) {
    if (!fs.existsSync(ASAR_PATH) || !fs.existsSync(INFO_PLIST)) {
      return { intact: false, hasHook: false, matchesPrior: false, cleanOfficial: false };
    }
    const currentHeaderHash = getHeaderHash(ASAR_PATH);
    let declaredHash = '';
    try { declaredHash = getDeclaredAsarHash(INFO_PLIST); } catch {}
    let hasHook = false;
    try {
      const main = readAsarFile(ASAR_PATH, 'dist/main.js').toString('utf8');
      hasHook = /\/\* AGY_KIT_STARTUP_HOOK_V\d+ \*\//.test(main);
    } catch {}
    const cleanOfficial = !hasHook && Boolean(declaredHash) && declaredHash === currentHeaderHash;
    const matchesPrior = Boolean(
      prior?.status === 'installed' &&
      hasHook &&
      currentHeaderHash === prior.installedHeaderHash &&
      fs.existsSync(PAYLOAD_DEST) &&
      sha256(PAYLOAD_DEST) === prior.installedPayloadSha256 &&
      sha256(INFO_PLIST) === prior.installedPlistSha256
    );
    return { intact: true, hasHook, matchesPrior, cleanOfficial, currentHeaderHash, declaredHash };
  }

  function getInstallStatus() {
    const prior = getPreviousState();
    if (!prior || prior.status !== 'installed') {
      return { state: prior?.status || 'none', label: '未安装', prior };
    }
    const bundle = inspectBundle(prior);
    if (bundle.matchesPrior) return { state: 'installed', label: '已安装', prior };
    if (bundle.cleanOfficial) {
      return { state: 'app-updated', label: '已失效（Antigravity 已更新，请重新运行 node cli.js install）', prior };
    }
    return { state: 'changed', label: '异常（客户端文件与安装记录不一致）', prior };
  }

  function updateInstalled(prior) {
    const source = getRendererSource();
  const nextPayloadHash = crypto.createHash('sha256').update(source).digest('hex');
  const nextStartupHash = startupHookSha256();
  if (nextPayloadHash === prior.installedPayloadSha256 && nextStartupHash === prior.installedStartupHookSha256) {
    return { alreadyInstalled: true };
  }
  if (nextStartupHash === prior.installedStartupHookSha256) {
    const previousPayload = fs.readFileSync(PAYLOAD_DEST);
    try {
      fs.writeFileSync(`${PAYLOAD_DEST}.tmp`, source, { mode: 0o644 });
      fs.renameSync(`${PAYLOAD_DEST}.tmp`, PAYLOAD_DEST);
      signApp();
      prior.installedPayloadSha256 = nextPayloadHash;
      writeState(prior);
      return { alreadyInstalled: false };
    } catch (error) {
      fs.writeFileSync(PAYLOAD_DEST, previousPayload);
      signApp();
      throw error;
    }
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-kit-update-'));
  const extracted = path.join(workDir, 'app');
  const stagedAsar = path.join(workDir, 'app.asar');
  const stagedPlist = path.join(workDir, 'Info.plist');
  const currentAsar = path.join(workDir, 'current.app.asar');
  const currentPlist = path.join(workDir, 'current.Info.plist');
  const currentUnpacked = path.join(workDir, 'current.app.asar.unpacked');
  const currentPayload = path.join(workDir, 'current.agy-kit-payload.js');
  const previousPayload = fs.readFileSync(PAYLOAD_DEST);
  try {
    fs.copyFileSync(ASAR_PATH, currentAsar);
    fs.copyFileSync(INFO_PLIST, currentPlist);
    copyDirectory(`${ASAR_PATH}.unpacked`, currentUnpacked);
    fs.copyFileSync(PAYLOAD_DEST, currentPayload);
    extractAll(ASAR_PATH, extracted);
    patchMain(path.join(extracted, 'dist', 'main.js'));
    packDirectory(extracted, stagedAsar, { referenceHeader: readHeader(ASAR_PATH).header });
    fs.copyFileSync(INFO_PLIST, stagedPlist);
    setIntegrityHash(stagedPlist, getHeaderHash(stagedAsar));
    fs.writeFileSync(`${PAYLOAD_DEST}.tmp`, source, { mode: 0o644 });
    fs.chmodSync(`${PAYLOAD_DEST}.tmp`, 0o644);
    if (fs.existsSync(`${stagedAsar}.unpacked`)) {
      fs.rmSync(`${ASAR_PATH}.unpacked`, { recursive: true, force: true });
      fs.renameSync(`${stagedAsar}.unpacked`, `${ASAR_PATH}.unpacked`);
    }
    fs.renameSync(stagedAsar, ASAR_PATH);
    fs.renameSync(stagedPlist, INFO_PLIST);
    fs.renameSync(`${PAYLOAD_DEST}.tmp`, PAYLOAD_DEST);
    signApp();
    prior.installedHeaderHash = getHeaderHash(ASAR_PATH);
    prior.installedPlistSha256 = sha256(INFO_PLIST);
    prior.installedPayloadSha256 = sha256(PAYLOAD_DEST);
    prior.installedStartupHookSha256 = nextStartupHash;
    writeState(prior);
    return { alreadyInstalled: false };
  } catch (error) {
    fs.copyFileSync(currentAsar, ASAR_PATH);
    fs.copyFileSync(currentPlist, INFO_PLIST);
    copyDirectory(currentUnpacked, `${ASAR_PATH}.unpacked`);
    fs.writeFileSync(PAYLOAD_DEST, previousPayload);
    try { signApp(); } catch (rollbackError) {
      error.message += `；更新回滚后重签失败：${rollbackError.message}`;
    }
    throw error;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function installPersistent() {
  if (platform !== 'darwin') throw new Error('持久安装目前只支持 macOS。');
  if (!fs.existsSync(ASAR_PATH) || !fs.existsSync(INFO_PLIST)) throw new Error(`Antigravity 安装不完整：${APP_BUNDLE}`);
  assertAppClosed();

  const runtimeDir = path.join(STATE_DIR, 'runtime');
  const runtimeTemp = path.join(STATE_DIR, 'runtime-staging');
  fs.rmSync(runtimeTemp, { recursive: true, force: true });
  fs.mkdirSync(path.join(runtimeTemp, 'src'), { recursive: true, mode: 0o700 });
  for (const file of ['backend-service.js', 'history-store.js', 'settings-store.js']) {
    fs.copyFileSync(path.join(__dirname, file), path.join(runtimeTemp, 'src', file));
  }
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.renameSync(runtimeTemp, runtimeDir);
  const prior = getPreviousState();
  if (prior?.status === 'preparing') {
    throw new Error('检测到上次安装未完成；请先运行 node cli.js restore 还原安装前备份。');
  }
  if (prior?.status === 'installed' && fs.existsSync(ASAR_PATH)) {
    const bundle = inspectBundle(prior);
    if (bundle.matchesPrior) {
      return updateInstalled(prior);
    }
    if (bundle.cleanOfficial) {
      // Antigravity 覆盖更新后客户端已变为干净新版；若残留旧版 agy-kit-payload.js 则先移除，
      // 避免把历史载荷当成客户端原装文件写入新版基线备份。
      if (!prior.hadPayload && fs.existsSync(PAYLOAD_DEST)) {
        fs.rmSync(PAYLOAD_DEST, { force: true });
      }
    } else {
      throw new Error('安装后的客户端文件已变化且完整性校验未通过；请先检查或重装 Antigravity 后再试。');
    }
  }

  const originalHeaderHash = getHeaderHash(ASAR_PATH);
  const declaredHash = getDeclaredAsarHash(INFO_PLIST);
  if (declaredHash !== originalHeaderHash) {
    throw new Error(`当前 app.asar 与 Info.plist 完整性哈希不匹配，拒绝安装（plist=${declaredHash}，asar=${originalHeaderHash}）。`);
  }

  const backupId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${originalHeaderHash.slice(0, 12)}`;
  const backupDir = path.join(STATE_DIR, 'backups', backupId);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const asarBackup = path.join(backupDir, 'app.asar');
  const plistBackup = path.join(backupDir, 'Info.plist');
  const unpackedBackup = path.join(backupDir, 'app.asar.unpacked');
  const payloadBackup = path.join(backupDir, 'agy-kit-payload.js');
  fs.copyFileSync(ASAR_PATH, asarBackup);
  fs.copyFileSync(INFO_PLIST, plistBackup);
  copyDirectory(`${ASAR_PATH}.unpacked`, unpackedBackup);
  const hadPayload = fs.existsSync(PAYLOAD_DEST);
  if (hadPayload) fs.copyFileSync(PAYLOAD_DEST, payloadBackup);
  fs.chmodSync(asarBackup, 0o600);
  fs.chmodSync(plistBackup, 0o600);

  const state = {
    status: 'preparing',
    appBundle: APP_BUNDLE,
    asarBackup,
    plistBackup,
    unpackedBackup,
    payloadBackup: hadPayload ? payloadBackup : null,
    payloadSha256: hadPayload ? sha256(payloadBackup) : null,
    hadPayload,
    asarSha256: sha256(asarBackup),
    plistSha256: sha256(plistBackup),
    unpackedSha256: hashDirectory(unpackedBackup),
    createdAt: new Date().toISOString()
  };
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeState(state);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-kit-install-'));
  const extracted = path.join(workDir, 'app');
  const stagedAsar = path.join(workDir, 'app.asar');
  const stagedPlist = path.join(workDir, 'Info.plist');
  const payloadTemp = `${PAYLOAD_DEST}.tmp`;
  let modified = false;
  try {
    const originalHeader = readHeader(ASAR_PATH).header;
    extractAll(ASAR_PATH, extracted);
    if (!patchMain(path.join(extracted, 'dist', 'main.js'))) {
      throw new Error('主进程中已存在 agy-kit 启动钩子；请检查安装状态后再操作。');
    }
    packDirectory(extracted, stagedAsar, { referenceHeader: originalHeader });
    fs.copyFileSync(INFO_PLIST, stagedPlist);
    setIntegrityHash(stagedPlist, getHeaderHash(stagedAsar));

    fs.writeFileSync(payloadTemp, getRendererSource());
    fs.chmodSync(payloadTemp, 0o644);
    fs.renameSync(stagedAsar, ASAR_PATH);
    modified = true;
    if (fs.existsSync(`${stagedAsar}.unpacked`)) {
      fs.rmSync(`${ASAR_PATH}.unpacked`, { recursive: true, force: true });
      fs.renameSync(`${stagedAsar}.unpacked`, `${ASAR_PATH}.unpacked`);
    } else {
      fs.rmSync(`${ASAR_PATH}.unpacked`, { recursive: true, force: true });
    }
    fs.renameSync(stagedPlist, INFO_PLIST);
    fs.renameSync(payloadTemp, PAYLOAD_DEST);
    signApp();

    state.status = 'installed';
    state.installedHeaderHash = getHeaderHash(ASAR_PATH);
    state.installedPlistSha256 = sha256(INFO_PLIST);
    state.installedPayloadSha256 = sha256(PAYLOAD_DEST);
    state.installedStartupHookSha256 = startupHookSha256();
    writeState(state);
    return { alreadyInstalled: false, stateFile: STATE_FILE };
  } catch (error) {
    fs.rmSync(PAYLOAD_DEST, { force: true });
    fs.rmSync(payloadTemp, { force: true });
    if (hadPayload) fs.copyFileSync(payloadBackup, PAYLOAD_DEST);
    if (modified) {
      fs.copyFileSync(asarBackup, ASAR_PATH);
      fs.copyFileSync(plistBackup, INFO_PLIST);
      copyDirectory(unpackedBackup, `${ASAR_PATH}.unpacked`);
      try { signApp(); } catch (rollbackError) {
        error.message += `；回滚后重签失败：${rollbackError.message}`;
      }
      state.status = 'rolled-back';
    } else {
      state.status = 'failed-before-write';
    }
    writeState(state);
    throw error;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function restorePersistent() {
  if (platform !== 'darwin') throw new Error('持久安装恢复目前只支持 macOS。');
  assertAppClosed();
  const state = getPreviousState();
  if (!state || !['installed', 'preparing', 'rolled-back'].includes(state.status)) throw new Error('没有找到可恢复的 agy-kit 安装记录。');
  if (state.appBundle !== APP_BUNDLE) throw new Error('安装记录指向其他客户端路径，拒绝恢复。');
  for (const backup of [state.asarBackup, state.plistBackup, state.unpackedBackup, ...(state.hadPayload ? [state.payloadBackup] : [])]) {
    const relative = path.relative(path.join(STATE_DIR, 'backups'), backup || '');
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('安装记录中的备份路径无效，拒绝恢复。');
  }
  if (!fs.existsSync(state.asarBackup) || !fs.existsSync(state.plistBackup) || !fs.existsSync(state.unpackedBackup)) throw new Error('安装备份缺失，未改动 Antigravity。');
  if (sha256(state.asarBackup) !== state.asarSha256 || sha256(state.plistBackup) !== state.plistSha256 || hashDirectory(state.unpackedBackup) !== state.unpackedSha256) {
    throw new Error('安装备份校验失败，未改动 Antigravity。');
  }
  if (state.hadPayload && (!fs.existsSync(state.payloadBackup) || sha256(state.payloadBackup) !== state.payloadSha256)) {
    throw new Error('Payload 安装前备份校验失败，未改动 Antigravity。');
  }
  if (state.status === 'installed' && (getHeaderHash(ASAR_PATH) !== state.installedHeaderHash || sha256(INFO_PLIST) !== state.installedPlistSha256)) {
    const bundle = inspectBundle(state);
    if (bundle.cleanOfficial) {
      throw new Error('检测到 Antigravity 已更新为新版干净客户端，无需恢复旧版备份；如需继续使用请直接运行 node cli.js install。');
    }
    throw new Error('Antigravity 文件在安装后又发生变化；为避免覆盖客户端更新，拒绝自动恢复。');
  }

  const currentAsar = `${ASAR_PATH}.agy-kit-restore.tmp`;
  const currentPlist = `${INFO_PLIST}.agy-kit-restore.tmp`;
  const currentUnpacked = `${ASAR_PATH}.agy-kit-unpacked-restore.tmp`;
  const currentPayload = `${PAYLOAD_DEST}.agy-kit-restore.tmp`;
  const currentHadPayload = fs.existsSync(PAYLOAD_DEST);
  fs.copyFileSync(ASAR_PATH, currentAsar);
  fs.copyFileSync(INFO_PLIST, currentPlist);
  copyDirectory(`${ASAR_PATH}.unpacked`, currentUnpacked);
  if (currentHadPayload) fs.copyFileSync(PAYLOAD_DEST, currentPayload);
  try {
    fs.copyFileSync(state.asarBackup, ASAR_PATH);
    fs.copyFileSync(state.plistBackup, INFO_PLIST);
    copyDirectory(state.unpackedBackup, `${ASAR_PATH}.unpacked`);
    if (state.hadPayload) fs.copyFileSync(state.payloadBackup, PAYLOAD_DEST);
    else fs.rmSync(PAYLOAD_DEST, { force: true });
    signApp();
    state.status = 'restored';
    writeState(state);
  } catch (error) {
    fs.copyFileSync(currentAsar, ASAR_PATH);
    fs.copyFileSync(currentPlist, INFO_PLIST);
    copyDirectory(currentUnpacked, `${ASAR_PATH}.unpacked`);
    if (currentHadPayload) fs.copyFileSync(currentPayload, PAYLOAD_DEST);
    else fs.rmSync(PAYLOAD_DEST, { force: true });
    try { signApp(); } catch (rollbackError) {
      error.message += `；恢复回滚后重签失败：${rollbackError.message}`;
    }
    throw error;
  } finally {
    fs.rmSync(currentAsar, { force: true });
    fs.rmSync(currentPlist, { force: true });
    fs.rmSync(currentUnpacked, { recursive: true, force: true });
    fs.rmSync(currentPayload, { force: true });
  }
}

  return { installPersistent, restorePersistent, getPreviousState, getInstallStatus };
}

module.exports = { ...createPersistence(), patchMain, createPersistence };
