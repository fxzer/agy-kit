'use strict';
const fs = require('fs');
const path = require('path');
const FILES = [
  'usage-summary.js',
  'bridge-client.js',
  'reports-panel.js',
  'session-insights.js',
  'telemetry.js',
  'config-style.js',
  'settings-panel.js',
  'native-undo.js',
  'inline-undo.js',
  'folder-status.js',
  'recent-section.js',
  'payload.js'
];
module.exports = function rendererSource() {
  const prologue = `(function(){
  const sym = Symbol.for('agy.kit');
  let ns = window[sym];
  if (!ns) {
    ns = {};
    Object.defineProperty(window, sym, { value: ns, configurable: true });
  }
  ns.instance?.destroy?.();
  ns.instance = null;
  ns.__AGY_KIT_INSTANCE__ = null;
  ns.bridgeClient?.destroy?.();
  window.__AGY_KIT_INSTANCE__?.destroy?.();
  window.__AGY_KIT_INSTANCE__ = null;
  window.__AGY_KIT_BRIDGE_CLIENT__?.destroy?.();
  if (window.__AGY_KIT_BRIDGE_CONFIG__ !== undefined) {
    ns.bridgeConfig = window.__AGY_KIT_BRIDGE_CONFIG__;
    delete window.__AGY_KIT_BRIDGE_CONFIG__;
  }
})();\n`;
  const epilogue = `\n;(function(){
  for (const k of [
    '__AGY_KIT_INSTANCE__', '__AGY_KIT_BRIDGE_CLIENT__', '__AGY_KIT_BRIDGE_CONFIG__',
    '__AGY_KIT_USAGE__', '__AGY_KIT_REPORTS_PANEL__', '__AGY_KIT_INSIGHTS__',
    '__AGY_KIT_TELEMETRY__', '__AGY_KIT_STORE__', '__AGY_KIT_SETTINGS_PANEL__',
    '__AGY_KIT_NATIVE_UNDO__', '__AGY_KIT_INLINE_UNDO__', '__AGY_KIT_FOLDER_STATUS__', '__AGY_KIT_SIDEBAR_API__', '__AGY_KIT_RECENT_SECTION__'
  ]) { try { delete window[k]; } catch {} }
})();`;
  return prologue + FILES.map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n') + epilogue;
};
