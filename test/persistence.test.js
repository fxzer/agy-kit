'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { packDirectory, getHeaderHash, readAsarFile } = require('../src/asar-engine');
const { createPersistence } = require('../src/persistence');

function buildAppBundle(root, versionTag, mainMarker = '') {
  const appBundle = path.join(root, 'Antigravity.app');
  const resources = path.join(appBundle, 'Contents', 'Resources');
  const plistPath = path.join(appBundle, 'Contents', 'Info.plist');
  const asarPath = path.join(resources, 'app.asar');
  const source = path.join(root, `src-${versionTag}`);
  const mainPath = path.join(source, 'dist', 'main.js');
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(
    mainPath,
    `const electron_1 = require("electron");\n// ${versionTag}\n${mainMarker}const gotTheLock = electron_1.app.requestSingleInstanceLock();\n`
  );
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"antigravity","main":"dist/main.js"}');
  packDirectory(source, asarPath);
  const hash = getHeaderHash(asarPath);
  fs.writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>${versionTag}</string>
  <key>ElectronAsarIntegrity</key>
  <dict>
    <key>Resources/app.asar</key>
    <dict>
      <key>algorithm</key>
      <string>SHA256</string>
      <key>hash</key>
      <string>${hash}</string>
    </dict>
  </dict>
</dict>
</plist>
`
  );
  return { appBundle, asarPath, plistPath, payloadPath: path.join(resources, 'agy-kit-payload.js'), hash };
}

test('客户端更新覆盖 app.asar 后可直接重新 install 且不会把旧 payload 当成原装文件', { skip: process.platform !== 'darwin' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-kit-persist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const bundle = buildAppBundle(root, '2.31.0');
  const persistence = createPersistence({
    appBundle: bundle.appBundle,
    stateDir,
    platform: 'darwin',
    assertAppClosed() {},
    signApp() {},
    getRendererSource: () => '// payload v1\n'
  });

  const first = persistence.installPersistent();
  assert.equal(first.alreadyInstalled, false);
  assert.equal(persistence.getInstallStatus().state, 'installed');
  assert.equal(persistence.installPersistent().alreadyInstalled, true);

  // 模拟 Antigravity 升级到 2.33.0，且 Resources 中残留了旧版 payload 文件
  const v2 = buildAppBundle(root, '2.33.0');
  assert.notEqual(v2.hash, bundle.hash);
  assert.equal(persistence.getInstallStatus().state, 'app-updated');

  assert.throws(
    () => persistence.restorePersistent(),
    /无需恢复旧版备份.*node cli\.js install/
  );

  const reinstall = persistence.installPersistent();
  assert.equal(reinstall.alreadyInstalled, false);
  assert.equal(persistence.getInstallStatus().state, 'installed');
  assert.equal(persistence.getPreviousState().hadPayload, false);
  assert.match(readAsarFile(bundle.asarPath, 'dist/main.js').toString('utf8'), /2\.33\.0/);

  // 基于新版 2.33.0 基线执行 restore，应能无损恢复到 2.33.0 原装文件并移除 payload
  persistence.restorePersistent();
  assert.equal(persistence.getInstallStatus().state, 'restored');
  assert.equal(getHeaderHash(bundle.asarPath), v2.hash);
  assert.equal(fs.existsSync(bundle.payloadPath), false);
});

test('完整性哈希被破坏或带钩子篡改时拒绝重新 install', { skip: process.platform !== 'darwin' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-kit-persist-tamper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const bundle = buildAppBundle(root, '2.31.0');
  const persistence = createPersistence({
    appBundle: bundle.appBundle,
    stateDir,
    platform: 'darwin',
    assertAppClosed() {},
    signApp() {},
    getRendererSource: () => '// payload v1\n'
  });

  persistence.installPersistent();

  // 篡改 payload（钩子还在，文件已变）应拒绝
  fs.writeFileSync(bundle.payloadPath, '// tampered\n');
  assert.equal(persistence.getInstallStatus().state, 'changed');
  assert.throws(() => persistence.installPersistent(), /完整性校验未通过/);

  // 无钩子但 Info.plist 声明的哈希与 app.asar 不匹配也应拒绝
  buildAppBundle(root, '2.33.0');
  execFileSync('/usr/libexec/PlistBuddy', [
    '-c', 'Set :ElectronAsarIntegrity:Resources/app.asar:hash deadbeef',
    bundle.plistPath
  ]);
  assert.equal(persistence.getInstallStatus().state, 'changed');
  assert.throws(() => persistence.installPersistent(), /完整性校验未通过/);
});
