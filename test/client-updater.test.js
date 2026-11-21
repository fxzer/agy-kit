'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const updater = require('../src/client-updater');

test('parseManifest 准确解析 YAML 清单中的版本、URL、sha512 与大小', () => {
  const yaml = `
version: 2.34.0
files:
  - url: https://storage.googleapis.com/antigravity-public/antigravity-hub/2.34.0-5887025308631040/darwin-arm/Antigravity.zip
    sha512: 4mY3QkbpWxuru5gPvJrabdr3tMH/mnQDtallcA5m6bZQ6g3AClqU5N6gryt0eml7mrLtm7Vkb+iIQdDRB3wCFw==
    size: 211599326
path: Antigravity.zip
sha512: 4mY3QkbpWxuru5gPvJrabdr3tMH/mnQDtallcA5m6bZQ6g3AClqU5N6gryt0eml7mrLtm7Vkb+iIQdDRB3wCFw==
`;
  const result = updater.parseManifest(yaml);
  assert.equal(result.version, '2.34.0');
  assert.equal(result.url, 'https://storage.googleapis.com/antigravity-public/antigravity-hub/2.34.0-5887025308631040/darwin-arm/Antigravity.zip');
  assert.equal(result.sha512, '4mY3QkbpWxuru5gPvJrabdr3tMH/mnQDtallcA5m6bZQ6g3AClqU5N6gryt0eml7mrLtm7Vkb+iIQdDRB3wCFw==');
  assert.equal(result.size, 211599326);
});

test('compareVersions 正确对比语义化版本高低', () => {
  assert.equal(updater.compareVersions('2.34.0', '2.33.0'), 1);
  assert.equal(updater.compareVersions('2.33.0', '2.34.0'), -1);
  assert.equal(updater.compareVersions('2.33.1', '2.33.0'), 1);
  assert.equal(updater.compareVersions('2.33.0', '2.33.0'), 0);
  assert.equal(updater.compareVersions('2.33', '2.33.0'), 0);
});

test('getManifestUrl 根据系统架构生成正确的 URL', () => {
  const armUrl = updater.getManifestUrl({ arch: 'arm64' });
  assert.match(armUrl, /latest-arm64-mac\.yml$/);
  const x64Url = updater.getManifestUrl({ arch: 'x64' });
  assert.match(x64Url, /latest-x64-mac\.yml$/);
});

test('verifySha512 与 checkCachedPackage 正确校验与命中本地缓存', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-kit-test-cache-'));
  try {
    const pendingDir = path.join(tmpDir, 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const dummyZip = path.join(pendingDir, 'Antigravity.zip');
    const content = Buffer.from('test-dummy-zip-content');
    fs.writeFileSync(dummyZip, content);

    const actualSha512 = crypto.createHash('sha512').update(content).digest('base64');
    assert.equal(updater.verifySha512(dummyZip, actualSha512), true);
    assert.equal(updater.verifySha512(dummyZip, 'wrong-sha512'), false);

    const found = updater.checkCachedPackage({
      cacheDir: tmpDir,
      expectedSha512: actualSha512
    });
    assert.equal(found, dummyZip);

    const mismatch = updater.checkCachedPackage({
      cacheDir: tmpDir,
      expectedSha512: 'wrong-sha512'
    });
    assert.equal(mismatch, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
