#!/usr/bin/env node
/**
 * agy-kit CLI 统一管理终端
 * (c) 2026 fxze - MIT License
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const child_process = require('child_process');
const persistence = require('./src/persistence');

const ASAR_PATH = '/Applications/Antigravity.app/Contents/Resources/app.asar';
const APP_BUNDLE = '/Applications/Antigravity.app';
const PAYLOAD_FILE = path.join(__dirname, 'src', 'payload.js');

function getDevToolsPort() {
  const appData = path.join(os.homedir(), 'Library/Application Support/Antigravity');
  const portFile = path.join(appData, 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) return null;
  return Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
}

async function getActivePages(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/list`, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function evaluate(ws, id, expression) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP evaluate timed out')), 5000);
    const onMessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== id) return;
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      if (message.error) return reject(new Error(message.error.message));
      const result = message.result?.result;
      if (message.result?.exceptionDetails) {
        return reject(new Error(message.result.exceptionDetails.text || 'JavaScript evaluation failed'));
      }
      resolve(result?.value);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true }
    }));
  });
}

async function waitForCapsule(ws) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await evaluate(ws, 2, `JSON.stringify({
      instance: !!(window[Symbol.for('agy.kit')]?.instance || window.__AGY_KIT_INSTANCE__),
      capsule: !!document.querySelector('#agy-kit-capsule-root'),
      footer: !!(document.querySelector('.agy-composer-footer') || document.querySelector('[class*="composer-footer"]'))
    })`);
    const parsed = JSON.parse(state || '{}');
    if (parsed.capsule) return parsed;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return JSON.parse(await evaluate(ws, 2, `JSON.stringify({
    instance: !!(window[Symbol.for('agy.kit')]?.instance || window.__AGY_KIT_INSTANCE__),
    capsule: !!document.querySelector('#agy-kit-capsule-root'),
    footer: !!(document.querySelector('.agy-composer-footer') || document.querySelector('[class*="composer-footer"]'))
  })`) || '{}');
}

async function liveInject() {
  console.log('⚡ [agy-kit] 正在连接 Antigravity 活跃窗口执行热载入...');
  const port = getDevToolsPort();
  if (!port) {
    console.error('❌ 未检测到运行中的 Antigravity 调试端口，请先启动 Antigravity 客户端。');
    process.exit(1);
  }

  const pages = await getActivePages(port);
  const targets = pages.filter(p => p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(p.url));
  if (targets.length === 0) {
    console.error('❌ 未找到有效的 Antigravity 主渲染窗口。');
    process.exit(1);
  }

  const bridge = await require('./src/backend-service').ensureDaemon();
  bridge.settings = require('./src/settings-store').read();
  const payloadSource = `window.__AGY_KIT_BRIDGE_CONFIG__ = ${JSON.stringify(bridge)};\n` + require('./src/renderer-source')();
  let verified = 0;
  let pending = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      await evaluate(ws, 1, payloadSource);
      const state = await waitForCapsule(ws);
      ws.close();
      if (state.capsule) {
        verified++;
        console.log(`✅ 已注入并确认胶囊已显示: ${target.title || target.url}`);
      } else if (state.instance && !state.footer) {
        pending++;
        console.warn(`⚠️ 插件实例已启动，但页面尚无底栏，稍后会自动等待挂载: ${target.title || target.url}`);
      } else {
        throw new Error('插件实例已注入，但 5 秒内未发现底栏胶囊');
      }
    } catch (e) {
      failed++;
      console.warn(`⚠️ 注入窗口 ${target.url} 失败:`, e.message);
    }
  }

  if (verified || pending) {
    console.log(`✨ [agy-kit] 注入结束：${verified} 个窗口已确认显示，${pending} 个窗口等待底栏，${failed} 个窗口失败。`);
  } else {
    console.error('❌ [agy-kit] 未有窗口确认插件运行成功。');
    process.exitCode = 1;
  }
}

function checkStatus() {
  console.log('🔍 [agy-kit] 正在巡检客户端与插件状态:');
  const port = getDevToolsPort();
  console.log(`  - 宿主路径: ${ASAR_PATH} (${fs.existsSync(ASAR_PATH) ? '存在' : '缺失'})`);
  console.log(`  - CDP 调试端口: ${port || '未开启/未运行'}`);
  console.log(`  - 本地 Payload: ${PAYLOAD_FILE} (${fs.existsSync(PAYLOAD_FILE) ? '就绪' : '缺失'})`);
  const installStatus = persistence.getInstallStatus();
  const installState = installStatus.prior;
  console.log(`  - 持久安装: ${installStatus.label}`);
  if (installStatus.zhTitlePatch) console.log(`  - 中文会话标题补丁: ${installStatus.zhTitlePatch.label}`);
  const managedBackup = installState?.asarBackup && fs.existsSync(installState.asarBackup);
  console.log(`  - 本次安装回滚备份: ${managedBackup ? '存在' : '无（当前未安装或状态文件缺失）'}`);
  const legacyBackup = `${ASAR_PATH}.orig.bak`;
  if (fs.existsSync(legacyBackup)) console.log('  - 旧版 .orig.bak: 存在（未作为本次安装回滚源）');
}

const action = process.argv[2] || 'live';

switch (action) {
  case 'live':
    liveInject().catch(err => {
      console.error('❌ 发生异常:', err);
      process.exit(1);
    });
    break;
  case 'install':
    try {
      const result = persistence.installPersistent();
      console.log(result.alreadyInstalled ? '✅ agy-kit 已持久安装。' : '✅ 持久安装完成，请重新启动 Antigravity。');
      if (result.zhTitlePatch?.patched) {
        console.log('✅ 中文会话标题补丁已写入 language_server（新会话将直接生成中文标题）。');
      } else if (result.zhTitlePatch?.skipped && result.zhTitlePatch.reason) {
        console.warn(`⚠️ 中文会话标题补丁未应用：${result.zhTitlePatch.reason}`);
      }
    } catch (err) {
      console.error('❌ 持久安装失败:', err.message);
      process.exitCode = 1;
    }
    break;
  case 'restore':
    try {
      persistence.restorePersistent();
      console.log('✅ 已恢复安装前的 Antigravity 文件并完成重签。');
    } catch (err) {
      console.error('❌ 恢复失败:', err.message);
      process.exitCode = 1;
    }
    break;
  case 'status':
  case 'check':
    checkStatus();
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(`
agy-kit: Next-Gen UI & Telemetry Suite for Google Antigravity 2.x
用法: node cli.js [命令]

可用命令:
  live              向当前运行中的 Antigravity 窗口热挂载 agy-kit
  install           持久安装启动钩子（需先退出 Antigravity）
  restore           恢复安装前备份（需先退出 Antigravity）
  status / check   查看当前客户端环境与插件运行状态
  help             查看帮助
`);
    break;
  default:
    console.log(`未知命令 "${action}"，运行 node cli.js --help 查看可用命令。`);
    break;
}
