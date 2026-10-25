const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { SEEN_KEY, showOnStartup } = require('./changelog.js');

function fixture() {
  const values = new Map();
  const displayed = [];
  const options = {
    getVersion: async () => '3.2.9',
    loadChangelog: async () => ({ releases: [
      { version: '3.2.8', items: [{ text: '旧日志' }] },
      { version: '3.2.9', items: [{ text: '本次修复' }] },
    ] }),
    storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    show: async (release) => { displayed.push(release); return true; },
  };
  return { values, displayed, options };
}

test('升级后首次启动展示当前安装版本的离线日志，下一次启动不重复弹出', async () => {
  const { options, values, displayed } = fixture();
  values.set(SEEN_KEY, '3.2.8');
  assert.equal(await showOnStartup(options), true);
  assert.equal(displayed[0].version, '3.2.9');
  assert.equal(values.get(SEEN_KEY), '3.2.9');
  options.loadChangelog = () => { throw new Error('已读版本不必读取'); };
  assert.equal(await showOnStartup(options), false);
  assert.equal(displayed.length, 1);
});

test('关闭日志后才标记已读，避免日志被遮挡或启动中断后永久丢失', async () => {
  const { options, values } = fixture();
  let dismiss;
  options.show = () => new Promise((resolve) => { dismiss = resolve; });
  const pending = showOnStartup(options);
  await new Promise(setImmediate);
  assert.equal(values.has(SEEN_KEY), false);
  dismiss(true);
  await pending;
  assert.equal(values.get(SEEN_KEY), '3.2.9');
});

test('缺失当前版本、读取失败或未展示时不会标记已读，后续可以重试', async () => {
  for (const loadChangelog of [
    async () => ({ releases: [{ version: '3.3.0', items: [{ text: '远端版本' }] }] }),
    async () => ({ releases: [{ version: '3.2.9', items: [] }] }),
    async () => { throw new Error('文件读取失败'); },
  ]) {
    const { options, values, displayed } = fixture();
    await showOnStartup({ ...options, loadChangelog }).catch(() => {});
    assert.equal(values.has(SEEN_KEY), false);
    assert.equal(displayed.length, 0);
    assert.equal(await showOnStartup(options), true);
  }
  const { options, values } = fixture();
  assert.equal(await showOnStartup({ ...options, show: async () => false }), false);
  assert.equal(values.has(SEEN_KEY), false);
});

test('存储不可用时仍展示当前版本日志', async () => {
  const { options, displayed } = fixture();
  options.storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(await showOnStartup(options), true);
  assert.equal(displayed.length, 1);
});

test('真实启动处理先渲染安全文本，关闭更新日志后才打开使用指南', async () => {
  const { options, values } = fixture();
  const elements = new Map();
  function element(id) {
    const classes = new Set();
    const handlers = {};
    const node = {
      textContent: '', children: [], handlers,
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      replaceChildren() { this.children = []; },
      appendChild(child) { this.children.push(child); },
      setAttribute() {}, focus() { document.activeElement = node; },
      addEventListener(name, handler) { handlers[name] = handler; },
      removeEventListener(name) { delete handlers[name]; },
    };
    elements.set(id, node);
    return node;
  }
  const document = {
    activeElement: { focus() {} },
    createElement: () => element('li'),
    addEventListener() {}, removeEventListener() {},
  };
  ['changelogOverlay', 'changelogItems', 'changelogTitle', 'changelogVersion', 'changelogConfirm', 'changelogClose'].forEach(element);
  let guideCalls = 0;
  const context = vm.createContext({
    currentLang: 'zh', document, localStorage: options.storage, console,
    $: (id) => elements.get(id),
    window: { VarSwitchChangelog: require('./changelog.js'), __TAURI__: { app: { getVersion: options.getVersion } } },
    fetch: async (url) => {
      assert.equal(url, 'changelog.json');
      return { ok: true, json: async () => ({ releases: [
        { version: '3.2.9', items: [{ text: '<img onerror=alert(1)>' }] },
      ] }) };
    },
    maybeOpenUsageGuide: async () => { guideCalls += 1; },
  });
  const source = fs.readFileSync(require.resolve('./app.js'), 'utf8');
  const start = source.indexOf('function showChangelogDialog(');
  const end = source.indexOf('\nasync function checkForUpdates()', start);
  vm.runInContext(source.slice(start, end), context);
  const pending = context.showStartupDialogs();
  await new Promise(setImmediate);
  const overlay = elements.get('changelogOverlay');
  assert.equal(overlay.classList.contains('open'), true);
  assert.equal(elements.get('changelogItems').children[0].textContent, '<img onerror=alert(1)>');
  assert.equal(guideCalls, 0);
  overlay.handlers.click({ target: { closest: () => elements.get('changelogConfirm') } });
  await pending;
  assert.equal(overlay.classList.contains('open'), false);
  assert.equal(values.get(SEEN_KEY), '3.2.9');
  assert.equal(guideCalls, 1);
});
