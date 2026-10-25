(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VarSwitchChangelog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SEEN_KEY = "varswitch_changelog_seen_version";

  async function showOnStartup({ getVersion, loadChangelog, storage, show }) {
    const version = String(await getVersion()).replace(/^v/, "");
    if (!version) return false;
    let seen = null;
    try { seen = storage.getItem(SEEN_KEY); } catch (_) { /* 仍展示日志 */ }
    if (seen === version) return false;
    const data = await loadChangelog();
    // 仅展示当前安装版本，不能把远端新版本或旧日志误当成本次更新。
    const release = data.releases?.find((entry) => entry.version === version);
    if (!release || !Array.isArray(release.items) || !release.items.length) return false;
    const displayed = await show(release);
    if (!displayed) return false;
    try { storage.setItem(SEEN_KEY, version); } catch (_) { /* 不阻断启动 */ }
    return true;
  }

  return { SEEN_KEY, showOnStartup };
});
