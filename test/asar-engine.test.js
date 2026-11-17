'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractAll, packDirectory, readHeader, getHeaderHash } = require('../src/asar-engine');
const { patchMain } = require('../src/persistence');

test('ASAR package round trips and the startup hook is valid and idempotent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-kit-asar-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const mainPath = path.join(source, 'dist', 'main.js');
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.writeFileSync(mainPath, 'const electron_1 = require("electron");\nconst fs = require("fs");\nconst path = require("path");\nconst gotTheLock = electron_1.app.requestSingleInstanceLock();\n');
  fs.writeFileSync(path.join(source, 'package.json'), '{"main":"dist/main.js"}');
  const unpackedSource = path.join(source, 'node_modules', 'chrome-devtools-mcp', 'sample.bin');
  fs.mkdirSync(path.dirname(unpackedSource), { recursive: true });
  fs.writeFileSync(unpackedSource, Buffer.from([0, 1, 2, 3]));

  assert.equal(patchMain(mainPath), true);
  assert.equal(patchMain(mainPath), false);
  execFileSync(process.execPath, ['--check', mainPath]);

  const initialArchive = path.join(root, 'initial.asar');
  packDirectory(source, initialArchive);
  const referenceHeader = readHeader(initialArchive).header;
  referenceHeader.files.dist.files['main.js'].executable = true;
  referenceHeader.files.node_modules.files['chrome-devtools-mcp'].unpacked = true;
  referenceHeader.files.node_modules.files['chrome-devtools-mcp'].files['sample.bin'].unpacked = true;

  const archive = path.join(root, 'app.asar');
  packDirectory(source, archive, { referenceHeader });
  const header = readHeader(archive).header;
  assert.equal(header.files.dist.files['main.js'].executable, true);
  assert.equal(header.files.node_modules.files['chrome-devtools-mcp'].files['sample.bin'].unpacked, true);
  assert.ok(header.files['package.json'].integrity);
  assert.match(getHeaderHash(archive), /^[a-f0-9]{64}$/);
  const output = path.join(root, 'output');
  extractAll(archive, output);
  assert.equal(fs.readFileSync(path.join(output, 'dist', 'main.js'), 'utf8'), fs.readFileSync(mainPath, 'utf8'));
  assert.match(fs.readFileSync(path.join(output, 'dist', 'main.js'), 'utf8'), /AGY_KIT_STARTUP_HOOK/);
});
