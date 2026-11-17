// 此文件作为主进程源码片段插入，utils_1 来自 Antigravity 主进程。
(function () {
  const fs = require('fs');
  const path = require('path');
  const electron = require('electron');
  const app = electron.app;
  const attached = new WeakSet();
  function attach(window) {
    if (!window || window.isDestroyed?.()) return;
    const contents = utils_1.getHubWebContents(window);
    if (!contents || contents.isDestroyed?.() || attached.has(contents)) return;
    attached.add(contents);
    async function inject() {
      if (contents.isDestroyed() || !/^https:\/\/127\.0\.0\.1:\d+\//.test(contents.getURL())) return;
      try {
        const payload = fs.readFileSync(path.join(process.resourcesPath, 'agy-kit-payload.js'), 'utf8');
        let config = null;
        try {
          const service = path.join(require('os').homedir(), '.gemini', 'agy-kit', 'runtime', 'src', 'backend-service.js');
          config = (await require(service).start()).config;
        } catch (error) {
          console.warn('[agy-kit] local reports unavailable:', error.message);
        }
        if (!contents.isDestroyed()) await contents.executeJavaScript('window.__AGY_KIT_BRIDGE_CONFIG__ = ' + JSON.stringify(config) + ';\n' + payload);
      } catch (error) {
        console.warn('[agy-kit] startup injection failed:', error.message);
      }
    }
    contents.on('did-finish-load', inject);
    if (!contents.isLoading()) inject();
  }
  // 事件驱动挂载已有与新建窗口（含 WebContentsView），不在主进程常驻轮询。
  function scanWindows() {
    for (const window of utils_1.getHubWindows()) attach(window);
  }
  scanWindows();
  app.whenReady?.().then(scanWindows);
  app.on?.('browser-window-created', (_event, window) => attach(window));
  app.on?.('web-contents-created', (_event, contents) => {
    contents?.once?.('did-finish-load', scanWindows);
  });
})();
