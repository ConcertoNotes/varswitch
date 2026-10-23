const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function handler(response) {
  const source = fs.readFileSync(require.resolve('./app.js'), 'utf8');
  const start = source.indexOf('async function handleSwitch(id)');
  const end = source.indexOf('\nasync function handleCancelSwitch()', start);
  const calls = [];
  const toasts = [];
  const context = vm.createContext({
    profiles: [{ id: 'profile-1', name: 'New profile' }],
    isSwitchingProfile: false,
    progressUnlisten: null,
    $: () => ({}),
    t: (key, args) => `${key}:${JSON.stringify(args || {})}`,
    invoke: async (command) => { calls.push(command); return response(); },
    listen: async () => () => calls.push('unlisten'),
    waitForNextPaint: async () => {},
    showSwitchOverlay: () => {},
    updateSwitchProgress: () => {},
    completeSwitchOverlay: () => {},
    hideSwitchOverlay: () => calls.push('hide'),
    showToast: (text, type) => toasts.push([text, type]),
    loadProfiles: async () => calls.push('profiles'),
    loadStatus: async () => calls.push('status'),
    setTimeout: (callback) => callback(),
  });
  vm.runInContext(source.slice(start, end), context);
  return { run: () => context.handleSwitch('profile-1'), context, calls, toasts };
}

test('后端回滚失败切换后，界面显示恢复结果且不重复发起恢复', async () => {
  const h = handler(() => ({ success: false, rolledBack: true, cancelled: false, errors: ['read only'] }));
  await h.run();
  assert.equal(h.calls.filter((command) => command === 'switch_profile').length, 1);
  assert.equal(h.calls.includes('restore_config'), false);
  assert.ok(h.toasts.some(([text, type]) => text.includes('switchRolledBack') && text.includes('read only') && type === 'error'));
  assert.equal(h.context.isSwitchingProfile, false);
  assert.ok(h.calls.includes('profiles') && h.calls.includes('status') && h.calls.includes('unlisten'));
});

test('取消切换时只在后端已成功恢复后提示已恢复', async () => {
  for (const rolledBack of [true, false]) {
    const h = handler(() => ({ success: false, cancelled: true, rolledBack, errors: ['rollback error'] }));
    await h.run();
    assert.ok(h.toasts[0][0].includes(rolledBack ? 'cancelledRestored' : 'cancelRestoreFailed'));
    assert.equal(h.calls.includes('restore_config'), false);
  }
});

test('切换异常会显示后端错误、清理进度并刷新实际状态', async () => {
  const h = handler(() => { throw new Error('restore failed'); });
  await h.run();
  assert.ok(h.toasts.some(([text, type]) => text.includes('restore failed') && type === 'error'));
  assert.equal(h.context.isSwitchingProfile, false);
  assert.ok(h.calls.includes('hide') && h.calls.includes('profiles') && h.calls.includes('status'));
});
