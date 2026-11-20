'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packDirectory, getHeaderHash } = require('../src/asar-engine');
const { createPersistence } = require('../src/persistence');
const {
  ORIGINAL_TITLE_PROMPT,
  PATCHED_TITLE_PROMPT,
  ORIGINAL_PROMPT_BUF,
  PATCHED_PROMPT_BUF,
  inspectLanguageServer,
  patchLanguageServer
} = require('../src/zh-title-patch');

function buildBundleWithLs(root, versionTag, lsContent) {
  const appBundle = path.join(root, 'Antigravity.app');
  const resources = path.join(appBundle, 'Contents', 'Resources');
  const plistPath = path.join(appBundle, 'Contents', 'Info.plist');
  const asarPath = path.join(resources, 'app.asar');
  const lsPath = path.join(resources, 'bin', 'language_server');
  const source = path.join(root, `src-${versionTag}`);
  const mainPath = path.join(source, 'dist', 'main.js');
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.mkdirSync(path.dirname(lsPath), { recursive: true });
  fs.writeFileSync(
    mainPath,
    `const electron_1 = require("electron");\n// ${versionTag}\nconst gotTheLock = electron_1.app.requestSingleInstanceLock();\n`
  );
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"antigravity","main":"dist/main.js"}');
  packDirectory(source, asarPath);
  const hash = getHeaderHash(asarPath);
  fs.writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>ElectronAsarIntegrity</key>
  <dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${hash}</string></dict></dict>
</dict></plist>\n`
  );
  if (lsContent !== null) {
    fs.writeFileSync(lsPath, lsContent, { mode: 0o755 });
  }
  return { appBundle, asarPath, plistPath, lsPath };
}

test('中文标题提示词补丁严格等长替换、保留相邻字节、幂等且能防异常匹配', t => {
  assert.equal(ORIGINAL_PROMPT_BUF.length, 626);
  assert.equal(PATCHED_PROMPT_BUF.length, ORIGINAL_PROMPT_BUF.length);
  assert.match(PATCHED_TITLE_PROMPT, /Simplified Chinese \(简体中文\)/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ls-patch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'language_server');
  const head = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0xff]);
  const tail = Buffer.from('Run a Python workflow script', 'utf8');
  const origBuf = Buffer.concat([head, ORIGINAL_PROMPT_BUF, tail]);
  fs.writeFileSync(bin, origBuf, { mode: 0o755 });

  assert.equal(inspectLanguageServer(bin).patchable, true);
  assert.equal(inspectLanguageServer(bin).patched, false);

  const first = patchLanguageServer(bin);
  assert.equal(first.patched, true);
  const after = fs.readFileSync(bin);
  assert.equal(after.length, origBuf.length);
  assert.deepEqual(after.subarray(0, head.length), head);
  assert.deepEqual(after.subarray(head.length + 626), tail);
  assert.equal(inspectLanguageServer(bin).patched, true);
  assert.equal(fs.statSync(bin).mode & 0o777, 0o755);

  // 幂等重复调用
  const second = patchLanguageServer(bin);
  assert.equal(second.patched, false);
  assert.equal(second.alreadyPatched, true);

  // 提示词变动时优雅跳过
  const otherBin = path.join(dir, 'other_ls');
  fs.writeFileSync(otherBin, Buffer.from('some unrelated binary'));
  const skipped = patchLanguageServer(otherBin);
  assert.equal(skipped.skipped, true);

  // 匹配到多处时拒绝修改
  const dupBin = path.join(dir, 'dup_ls');
  fs.writeFileSync(dupBin, Buffer.concat([ORIGINAL_PROMPT_BUF, ORIGINAL_PROMPT_BUF]));
  assert.throws(() => patchLanguageServer(dupBin), /多处标题提示词/);
});

test('persistence 完整支持 language_server 源头补丁的安装、旧版升级、重签、篡改拦截与无损还原', { skip: process.platform !== 'darwin' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-persist-ls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const origLsBuf = Buffer.concat([Buffer.from('HEADER:'), ORIGINAL_PROMPT_BUF, Buffer.from(':TAIL')]);
  const bundle = buildBundleWithLs(root, '2.33.0', origLsBuf);

  let lsSignedCount = 0;
  let appSignedCount = 0;
  const persistence = createPersistence({
    appBundle: bundle.appBundle,
    stateDir,
    platform: 'darwin',
    assertAppClosed() {},
    signApp() { appSignedCount++; },
    signLanguageServer() { lsSignedCount++; },
    getRendererSource: () => '// payload v1\n'
  });

  // 1. 首次安装：备份原装 language_server 并原地打补丁 + 单独重签
  const installed = persistence.installPersistent();
  assert.equal(installed.alreadyInstalled, false);
  assert.equal(installed.zhTitlePatch.patched, true);
  assert.equal(lsSignedCount, 1);
  assert.equal(appSignedCount, 1);
  assert.equal(inspectLanguageServer(bundle.lsPath).patched, true);
  assert.equal(persistence.getInstallStatus().state, 'installed');
  assert.equal(persistence.getInstallStatus().zhTitlePatch.state, 'patched');

  // 二次安装完全幂等
  assert.equal(persistence.installPersistent().alreadyInstalled, true);
  assert.equal(lsSignedCount, 1);

  // 2. 还原：无损恢复原装 language_server 与可执行权限
  persistence.restorePersistent();
  assert.equal(persistence.getInstallStatus().state, 'restored');
  assert.deepEqual(fs.readFileSync(bundle.lsPath), origLsBuf);
  assert.equal(fs.statSync(bundle.lsPath).mode & 0o777, 0o755);

  // 3. 模拟“旧版已安装（当时没打 language_server 补丁）”原地升级
  persistence.installPersistent();
  const stateFile = path.join(stateDir, 'install-state.json');
  const legacyState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  delete legacyState.languageServerBackup;
  delete legacyState.languageServerSha256;
  delete legacyState.installedLanguageServerSha256;
  delete legacyState.languageServerPatched;
  fs.writeFileSync(stateFile, JSON.stringify(legacyState, null, 2));
  fs.writeFileSync(bundle.lsPath, origLsBuf, { mode: 0o755 });

  assert.equal(persistence.getInstallStatus().state, 'installed');
  assert.equal(persistence.getInstallStatus().zhTitlePatch.state, 'unpatched');
  const upgraded = persistence.installPersistent();
  assert.equal(upgraded.alreadyInstalled, false);
  assert.equal(upgraded.zhTitlePatch.patched, true);
  assert.equal(inspectLanguageServer(bundle.lsPath).patched, true);

  // 4. 篡改 language_server 后状态变为 changed 且拒绝覆盖安装
  fs.writeFileSync(bundle.lsPath, Buffer.from('corrupted'));
  assert.equal(persistence.getInstallStatus().state, 'changed');
  assert.throws(() => persistence.installPersistent(), /完整性校验未通过/);
});
