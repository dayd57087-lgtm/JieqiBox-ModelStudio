/*
 * 悬浮窗采集 · 前端逻辑单测
 *
 * 用假 DOM + 假原生桥，把「开始采集 → 已就绪 → 再点一次才开拍」这条
 * 最容易写错的链路真的跑一遍。
 *
 * 用法：python3 tools/extract_capture.py && node tools/test_capture.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BLOCK = path.join(__dirname, '_capture_block.js');

// ---------------------------------------------------------------- 假 DOM
function makeEl(id) {
  return {
    id: id,
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    click() { (this._handlers.click || []).forEach(f => f()); },
    get children() { return []; },
  };
}

const IDS = [
  'capCard', 'capBadge', 'capStatus', 'capOverlayState', 'candCard', 'candCount',
  'candProgress', 'btnCapPermission', 'btnCapStart', 'btnCapStop', 'btnCapOverlay',
  'btnCandImport', 'btnCandClear', 'scanCard', 'scanGrid',
];
const els = {};
IDS.forEach(i => { els[i] = makeEl(i); });

const document = {
  getElementById: id => els[id] || null,
  createElement: () => makeEl('dyn'),
  querySelectorAll: () => [],
  addEventListener: () => {},
};

// ---------------------------------------------------------------- 假原生桥
const native = {
  running: false,
  armed: false,
  overlays: true,
  perm: true,
  candidates: 0,
  calls: [],
};
const Capture = {
  isSupported: () => true,
  hasPermission: () => native.perm,
  requestPermission() { native.perm = true; native.calls.push('requestPermission'); },
  isCapturing: () => native.running,
  isArmed: () => native.armed,
  setArmed(on) { native.armed = on; native.calls.push('setArmed:' + on); return true; },
  capturedCount: () => 0,
  canDrawOverlays: () => native.overlays,
  start(scale, gap, stable) {
    native.running = true;
    native.armed = false;
    native.calls.push(`start:${scale},${gap},${stable}`);
    return true;
  },
  stop() { native.running = false; native.armed = false; native.calls.push('stop'); return true; },
  candidateCount: () => native.candidates,
  openOverlaySettings() { native.calls.push('openOverlaySettings'); },
};

const toasts = [];
const window = { Capture: Capture, onCapturePermission: null, onCaptureState: null };
const Evolve = {
  snapshotParams: () => ({ capIntervalSec: 5, capStableFrames: 3, capDupTolerance: 2 }),
};

const sandbox = {
  window, document, console,
  Evolve,
  toast: (m) => toasts.push(m),
  $: id => els[id] || null,
  escapeHtml: s => String(s),
  confirm: () => true,
  log: () => {},
  samples: [],
  model: null,
  savedModels: [],
  inSize: 32,
};
sandbox.globalThis = sandbox;

// ---------------------------------------------------------------- 跑
const ctx = vm.createContext(sandbox);
const code = fs.readFileSync(BLOCK, 'utf8');
try {
  vm.runInContext(code, ctx, { filename: 'capture_block.js' });
} catch (e) {
  console.error('✗ 采集代码加载失败：', e.message);
  process.exit(1);
}

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const refreshCapture = sandbox.refreshCapture;
const btnStart = els.btnCapStart;

console.log('\n[1] 未授权时不该能开始');
native.running = false; native.perm = false;
refreshCapture();
check('开始采集按钮禁用', btnStart.disabled === true);
Capture.requestPermission();
window.onCapturePermission(true, '');
check('授权后按钮可用', btnStart.disabled === false);

console.log('\n[2] 第一次点「开始采集」：只架窗口，不采');
btnStart.click();
check('调用了原生 start', native.calls.includes('start:0.5,5000,3'),
      JSON.stringify(native.calls));
check('原生没被置成开拍', native.armed === false);
check('提示讲了要再点一次悬浮窗',
      toasts.some(t => t.indexOf('悬浮窗上的「开始」') >= 0), JSON.stringify(toasts));
check('按钮文案仍是「开始采集」', btnStart.textContent === '开始采集',
      btnStart.textContent);

console.log('\n[3] 已就绪状态：必须明确说「还没开拍」');
refreshCapture();
const ready = els.capStatus.innerHTML;
check('状态写着已就绪、还没开拍', ready.indexOf('已就绪') >= 0 && ready.indexOf('还没开拍') >= 0,
      ready);
check('状态里没有「● 采集中」', ready.indexOf('采集中') < 0, ready);
check('停止按钮出现', els.btnCapStop.hidden === false);

console.log('\n[4] 第二次点「开始采集」= 开拍');
btnStart.click();
check('原生被置成开拍', native.armed === true);
check('按钮文案变成「暂停采集」', btnStart.textContent === '暂停采集', btnStart.textContent);
refreshCapture();
check('状态变成「● 采集中」', els.capStatus.innerHTML.indexOf('采集中') >= 0,
      els.capStatus.innerHTML);

console.log('\n[5] 再点一次 = 暂停，不会把服务关掉');
btnStart.click();
check('原生退回未开拍', native.armed === false);
check('服务还在跑（暂停 ≠ 停止）', native.running === true);
refreshCapture();
check('状态回到「已就绪，还没开拍」',
      els.capStatus.innerHTML.indexOf('还没开拍') >= 0, els.capStatus.innerHTML);
check('按钮文案回到「开始采集」', btnStart.textContent === '开始采集', btnStart.textContent);

console.log('\n[6] 停止：完全关闭');
els.btnCapStop.click();
check('调用了原生 stop', native.calls.includes('stop'));
check('服务已停', native.running === false);
refreshCapture();
check('状态显示已停止', els.capStatus.innerHTML.indexOf('已停止') >= 0,
      els.capStatus.innerHTML);

console.log('\n[7] 老原生桥（没有 isArmed/setArmed）不该崩');
const savedIsArmed = Capture.isArmed, savedSetArmed = Capture.setArmed;
delete Capture.isArmed; delete Capture.setArmed;
native.running = true;
let threw = null;
try { refreshCapture(); } catch (e) { threw = e; }
check('refreshCapture 不抛异常', threw === null, threw && threw.message);
btnStart.click();
check('缺 setArmed 时给出提示而不是崩',
      toasts.some(t => t.indexOf('不支持开始/暂停') >= 0), JSON.stringify(toasts.slice(-2)));
Capture.isArmed = savedIsArmed; Capture.setArmed = savedSetArmed;
native.running = false;

console.log('\n[8] 浏览器里（没有原生桥）');
delete window.Capture;
sandbox.window.Capture = undefined;
try { refreshCapture(); } catch (e) { failed++; console.log('  ✗ 抛异常 ' + e.message); }
if (!failed) console.log('  ✓ 优雅降级为「需要 Android」');

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
