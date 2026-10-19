const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadHandler(invoke) {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  const start = source.indexOf("async function handleCodexAccountLogin()");
  assert.notEqual(start, -1, "账号登录处理函数必须存在");
  const end = source.indexOf("\nasync function ", start + 1);
  const button = { disabled: false };
  const events = [];
  const context = vm.createContext({
    $: () => button,
    currentLang: "zh",
    invoke,
    setButtonBusy: (node, busy) => { node.disabled = busy; events.push(["busy", busy]); },
    showToast: (message, type) => events.push([type, message]),
    loadCodexProfiles: async () => events.push(["profiles"]),
    loadCodexStatus: async () => events.push(["status"]),
  });
  vm.runInContext(source.slice(start, end), context);
  return { run: () => context.handleCodexAccountLogin(), button, events };
}

test("账号登录成功后刷新档案与状态，并提示在 Codex 中登录", async () => {
  const calls = [];
  const handler = loadHandler(async (command) => calls.push(command));
  await handler.run();
  assert.deepEqual(calls, ["switch_codex_to_account_login"]);
  assert.equal(handler.button.disabled, false);
  assert.ok(handler.events.some(([name]) => name === "profiles"));
  assert.ok(handler.events.some(([name]) => name === "status"));
  assert.ok(handler.events.some(([name, text]) => name === "success" && text.includes("Codex") && text.includes("登录")));
});

test("账号登录失败显示错误、恢复按钮且不刷新成功状态", async () => {
  const handler = loadHandler(async () => { throw new Error("配置文件不可写"); });
  await handler.run();
  assert.equal(handler.button.disabled, false);
  assert.ok(handler.events.some(([name, text]) => name === "error" && text.includes("配置文件不可写")));
  assert.equal(handler.events.some(([name]) => name === "success" || name === "profiles"), false);
});

test("账号登录进行中忽略重复点击", async () => {
  let finish;
  let calls = 0;
  const handler = loadHandler(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const pending = handler.run();
  await handler.run();
  assert.equal(calls, 1);
  finish();
  await pending;
});
