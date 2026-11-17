'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const preamble = Buffer.alloc(16);
    fs.readSync(fd, preamble, 0, 16, 0);
    const jsonSize = preamble.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    const padding = (4 - (jsonSize % 4)) % 4;
    return { header: JSON.parse(json.toString('utf8')), baseOffset: 16 + jsonSize + padding };
  } finally {
    fs.closeSync(fd);
  }
}

function extractAll(archivePath, outputDir) {
  const { header, baseOffset } = readHeader(archivePath);
  const fd = fs.openSync(archivePath, 'r');
  try {
    function walk(node, destination, relative) {
      fs.mkdirSync(destination, { recursive: true });
      for (const [name, entry] of Object.entries(node.files || {})) {
        const rel = relative ? `${relative}/${name}` : name;
        const target = path.join(destination, name);
        if (entry.link) throw new Error(`ASAR symbolic links are not supported: ${rel}`);
        if (entry.files) {
          walk(entry, target, rel);
        } else if (entry.unpacked) {
          const source = path.join(`${archivePath}.unpacked`, rel);
          if (!fs.existsSync(source)) throw new Error(`Missing unpacked ASAR file: ${rel}`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target);
        } else {
          const data = Buffer.alloc(entry.size);
          fs.readSync(fd, data, 0, entry.size, baseOffset + Number(entry.offset));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, data);
        }
      }
    }
    walk(header, outputDir, '');
  } finally {
    fs.closeSync(fd);
  }
}

function fileIntegrity(data) {
  const blockSize = 4 * 1024 * 1024;
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += blockSize) {
    blocks.push(crypto.createHash('sha256').update(data.subarray(offset, offset + blockSize)).digest('hex'));
  }
  if (blocks.length === 0) blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(data).digest('hex'),
    blockSize,
    blocks
  };
}

function getReferenceNode(header, relative) {
  if (!header) return null;
  let current = header;
  for (const part of relative.split('/')) {
    current = current?.files?.[part];
    if (!current) return null;
  }
  return current;
}

function packDirectory(sourceDir, archivePath, options = {}) {
  let offset = 0;
  const packedFiles = [];
  const unpackedFiles = [];

  function build(directory, relative = '') {
    const files = {};
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const source = path.join(directory, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Cannot package ASAR symbolic link: ${rel}`);
      if (entry.isDirectory()) {
        const node = { files: build(source, rel) };
        const reference = getReferenceNode(options.referenceHeader, rel);
        if (reference?.unpacked) node.unpacked = true;
        files[entry.name] = node;
      } else if (entry.isFile()) {
        const data = fs.readFileSync(source);
        const integrity = fileIntegrity(data);
        const reference = getReferenceNode(options.referenceHeader, rel);
        if (reference?.unpacked) {
          unpackedFiles.push({ data, rel });
          files[entry.name] = { size: data.length, unpacked: true, integrity };
        } else {
          files[entry.name] = {
            size: data.length,
            offset: String(offset),
            integrity,
            ...(reference?.executable ? { executable: true } : {})
          };
          packedFiles.push(data);
          offset += data.length;
        }
      }
    }
    return files;
  }

  const header = { files: build(sourceDir) };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padding = (4 - (json.length % 4)) % 4;
  const preamble = Buffer.alloc(16 + json.length + padding);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(8 + json.length + padding, 4);
  preamble.writeUInt32LE(4 + json.length + padding, 8);
  preamble.writeUInt32LE(json.length, 12);
  json.copy(preamble, 16);

  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, preamble);
  const fd = fs.openSync(archivePath, 'a');
  try {
    for (const data of packedFiles) fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }

  const unpackedRoot = `${archivePath}.unpacked`;
  for (const item of unpackedFiles) {
    const target = path.join(unpackedRoot, item.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, item.data);
  }
}

function getHeaderHash(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const preamble = Buffer.alloc(16);
    fs.readSync(fd, preamble, 0, 16, 0);
    const jsonSize = preamble.readUInt32LE(12);
    const rawHeader = Buffer.alloc(jsonSize);
    fs.readSync(fd, rawHeader, 0, jsonSize, 16);
    return crypto.createHash('sha256').update(rawHeader).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readHeader, extractAll, packDirectory, getHeaderHash };
