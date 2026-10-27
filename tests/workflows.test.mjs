import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable, Writable, PassThrough } from 'node:stream';
import { buildArgs, parseBuildOptions } from '../scripts/build.mjs';
import { parseReleaseArgs, promptReleaseOptions, checkRemoteTag, readReleaseNotes, releaseBody, updateChangelog, updateVersionContents } from '../scripts/release.mjs';
import { createManifest } from '../scripts/create-updater-manifest.mjs';
import { normalizeUpdaterManifest, updateDownloadPage } from '../sync-mac-release.mjs';

test('native build chooses the platform bundle and keeps local Mac builds out of updater signing', () => {
  assert.deepEqual(parseBuildOptions(['--skip-install', '--bundles', 'dmg']), {
    install: 'skip', tauri: ['--bundles', 'dmg'],
  });
  assert.deepEqual(buildArgs('darwin', []), [
    '--bundles', 'app,dmg',
    '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
  ]);
  assert.deepEqual(buildArgs('win32', []), ['--bundles', 'nsis']);
  assert.deepEqual(buildArgs('darwin', ['--bundles', 'app']), ['--bundles', 'app', '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } })]);
  assert.deepEqual(buildArgs('win32', ['-b', 'msi']), ['-b', 'msi']);
});

test('release requires an explicit semantic version', () => {
  assert.deepEqual(parseReleaseArgs(['--version', '4.0.0']), { version: '4.0.0', includeWorktree: false });
  assert.deepEqual(parseReleaseArgs(['--version', '4.0.0', '--include-worktree']), { version: '4.0.0', includeWorktree: true });
  assert.throws(() => parseReleaseArgs([]), /正式版本号/);
  assert.throws(() => parseReleaseArgs(['--version', 'latest']), /正式版本号/);
});

test('interactive release collects a version and multiline changes without losing buffered lines', async () => {
  const output = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const options = await promptReleaseOptions(parseReleaseArgs(['--interactive', '--include-worktree']), {
    input: Readable.from(['3.2.8\n修复 Mac 切换\n- 改善发布流程\n.\n']), output,
  });
  assert.equal(options.version, '3.2.8');
  assert.equal(options.notes, '修复 Mac 切换\n- 改善发布流程');
  assert.equal(options.includeWorktree, true);
  for (const text of ['3.2.8\n.\n', '3.2.8\n未完成的说明\n', 'bad-version\n']) {
    await assert.rejects(promptReleaseOptions(parseReleaseArgs(['--interactive']), {
      input: Readable.from([text]), output,
    }), /不能为空|已取消|正式版本号/);
  }
  assert.equal(parseReleaseArgs(['--version', '3.2.8', '--notes-file', 'changes.md']).notesFile, 'changes.md');
  assert.throws(() => parseReleaseArgs(['--version', '3.2.8', '--notes-file']), /文件路径/);
});

test('TTY release input edits Chinese with backspace, arrow keys and Ctrl+U', async () => {
  const originalTerm = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  const input = new PassThrough();
  input.isTTY = true;
  const modes = [];
  input.setRawMode = (mode) => { modes.push(mode); };
  const output = new Writable({ write(chunk, encoding, callback) { callback(); } });
  output.isTTY = true;
  output.columns = 40;
  const result = promptReleaseOptions(parseReleaseArgs(['--interactive']), { input, output });
  if (originalTerm === undefined) delete process.env.TERM;
  else process.env.TERM = originalTerm;
  // readline 收到的是终端按键序列，中文不能按 UTF-8 字节删除。
  setImmediate(() => input.write('3.2.9\r修复错误\x7f\x7f切换\x1b[D\x7f替\r输入错了\x15优化体验\r.\r'));
  const options = await result;
  assert.equal(options.notes, '修复替换\n优化体验');
  assert.equal(modes[0], true);
  assert.equal(modes.at(-1), false);
  input.destroy();
});

test('release bundles the entered changes for the new version without losing old releases', () => {
  const original = JSON.stringify({ releases: [
    { version: '3.2.9', items: [{ text: '旧草稿' }] },
    { version: '3.2.8', items: [{ text: '旧版说明' }] },
  ] });
  const data = JSON.parse(updateChangelog(original, '3.2.9', '- 修复删除\n\n优化弹窗', '2026-10-25'));
  assert.equal(data.releases.length, 2);
  assert.deepEqual(data.releases[0], { version: '3.2.9', date: '2026-10-25', items: [
    { type: 'improve', text: '修复删除' }, { type: 'improve', text: '优化弹窗' },
  ] });
  assert.equal(data.releases[1].items[0].text, '旧版说明');
  assert.throws(() => updateChangelog(original, '3.2.9', ' \n'), /不能为空/);
});

test('new release accepts Git exit code 2 for an absent remote tag, but rejects an existing tag and connection failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varswitch-remote-tag-'));
  const git = (args, cwd = dir) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  try {
    const bare = path.join(dir, 'remote.git');
    git(['init', '--bare', bare]);
    git(['init', path.join(dir, 'work')]);
    const work = path.join(dir, 'work');
    git(['remote', 'add', 'origin', bare], work);
    const check = () => spawnSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', 'refs/tags/v3.2.8'], { cwd: work, encoding: 'utf8' });
    const missing = check();
    assert.equal(missing.status, 2);
    assert.doesNotThrow(() => checkRemoteTag(missing, 'v3.2.8'));
    git(['-c', 'user.name=Release Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'], work);
    git(['-c', 'tag.gpgsign=false', 'tag', 'v3.2.8'], work);
    git(['push', 'origin', 'refs/tags/v3.2.8'], work);
    assert.throws(() => checkRemoteTag(check(), 'v3.2.8'), /已存在/);
    assert.throws(() => checkRemoteTag({ status: 128, stderr: 'Permission denied' }, 'v3.2.8'), /尚未提交或推送[\s\S]*Permission denied/);
    assert.throws(() => checkRemoteTag({ status: null, error: new Error('git unavailable') }, 'v3.2.8'), /git unavailable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('versioned release notes survive reading and are included once above installation instructions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varswitch-notes-'));
  try {
    fs.mkdirSync(path.join(root, 'release-notes'));
    const notes = '- 修复切换\n- 输入内容保持原样：$1 `test`';
    fs.writeFileSync(path.join(root, 'release-notes/v3.2.8.md'), `${notes}\n`);
    assert.equal(readReleaseNotes('v3.2.8', root), notes);
    assert.equal(readReleaseNotes('v3.2.9', root), '');
    assert.throws(() => readReleaseNotes('../unsafe', root), /正式版本号/);
    const body = releaseBody(notes, '## 下载\n\n安装说明');
    assert.equal(body, `## 本次修改和变化\n\n${notes}\n\n## 下载\n\n安装说明`);
    assert.equal(releaseBody(notes, body), body);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('version release synchronizes npm, Cargo, README and visible app/site version references', () => {
  const contents = {
    'package.json': '{"name":"varswitch","version":"3.2.7"}\n',
    'package-lock.json': '{"version":"3.2.7","packages":{"":{"version":"3.2.7"}}}\n',
    'src-tauri/tauri.conf.json': '{"version":"3.2.7"}\n',
    'src-tauri/Cargo.toml': '[package]\nname = "varswitch"\nversion = "3.2.7"\n\n[dependencies]\n',
    'src-tauri/Cargo.lock': '[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "varswitch"\nversion = "3.2.7"\n',
    'README.md': '当前应用版本：`3.1.17`。\n',
    'public/index.html': 'VarSwitch <span>v3.1.21</span>',
    'public/changelog.json': '{"releases":[]}',
    'varswitch-download-site/index.html': 'VarSwitch_3.1.16_x64-setup.exe VarSwitch v3.1.16 当前版本 v3.1.16 <strong>v3.1.16</strong>\n<span>当前版本</span>',
  };
  const updated = updateVersionContents(contents, '3.3.0', '修复 Mac 切换');
  assert.equal(JSON.parse(updated['package.json']).version, '3.3.0');
  assert.equal(JSON.parse(updated['package-lock.json']).packages[''].version, '3.3.0');
  assert.match(updated['src-tauri/Cargo.toml'], /version = "3\.3\.0"/);
  assert.match(updated['src-tauri/Cargo.lock'], /name = "varswitch"\nversion = "3\.3\.0"/);
  assert.match(updated['README.md'], /`3\.3\.0`/);
  assert.match(updated['public/index.html'], /v3\.3\.0/);
  assert.equal(JSON.parse(updated['public/changelog.json']).releases[0].version, '3.3.0');
  assert.equal(JSON.parse(updated['public/changelog.json']).releases[0].items[0].text, '修复 Mac 切换');
  assert.match(updated['varswitch-download-site/index.html'], /VarSwitch_3\.3\.0_x64-setup\.exe VarSwitch v3\.3\.0 当前版本 v3\.3\.0 <strong>v3\.3\.0<\/strong>\n<span>当前版本<\/span>/);
});

test('updater manifest uses all three signatures and stable download-domain URLs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varswitch-manifest-'));
  try {
    const names = [
      'VarSwitch_3.2.8_x64-setup.exe',
      'VarSwitch_3.2.8_aarch64.app.tar.gz',
      'VarSwitch_3.2.8_x64.app.tar.gz',
    ];
    for (const [index, name] of names.entries()) {
      fs.writeFileSync(path.join(dir, name), 'package');
      fs.writeFileSync(path.join(dir, `${name}.sig`), `signature-${index}\n`);
    }
    const manifest = createManifest('v3.2.8', dir, '2026-10-23T10:00:00.000Z');
    assert.equal(manifest.version, '3.2.8');
    assert.equal(manifest.platforms['windows-x86_64'].signature, 'signature-0');
    assert.equal(manifest.platforms['darwin-aarch64'].url, 'https://download.varswitch.strova.top/releases/VarSwitch_3.2.8_aarch64.app.tar.gz');
    assert.equal(manifest.platforms['darwin-x86_64'].signature, 'signature-2');
    assert.equal(createManifest('v3.2.8', dir, undefined, '修复切换\n新增交互说明').notes, '修复切换\n新增交互说明');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('download-site sync rewrites the three installer links and requires every updater signature', () => {
  const html = '<a href="VarSwitch_3.1.0_x64-setup.exe">VarSwitch_3.1.0_x64-setup.exe</a>' +
    '<a data-mac-download="aarch64" href="old-a.dmg"></a><span data-mac-file="aarch64">old-a.dmg</span>' +
    '<a data-mac-download="x64" href="old-x.dmg"></a><span data-mac-file="x64">old-x.dmg</span>' +
    'VarSwitch v3.1.0 当前版本 v3.1.0 <strong>v3.1.0</strong>\n<span>当前版本</span>';
  const updated = updateDownloadPage(html, '3.2.8', {
    windows: './releases/VarSwitch_3.2.8_x64-setup.exe',
    macos: [
      { arch: 'aarch64', dmgName: 'VarSwitch_3.2.8_aarch64.dmg', pageUrl: './releases/VarSwitch_3.2.8_aarch64.dmg' },
      { arch: 'x64', dmgName: 'VarSwitch_3.2.8_x64.dmg', pageUrl: './releases/VarSwitch_3.2.8_x64.dmg' },
    ],
  });
  assert.match(updated, /href="\.\/releases\/VarSwitch_3\.2\.8_x64-setup\.exe">VarSwitch_3\.2\.8_x64-setup\.exe</);
  const rerun = updateDownloadPage(updated, '3.2.8', {
    windows: './releases/VarSwitch_3.2.8_x64-setup.exe', macos: [],
  });
  assert.equal(rerun, updated);
  assert.match(updateDownloadPage(
    '<a href="./releases/./releases/VarSwitch_3.2.8_x64-setup.exe"></a><span>./releases/VarSwitch_3.2.8_x64-setup.exe</span>',
    '3.2.9', { windows: './releases/VarSwitch_3.2.9_x64-setup.exe', macos: [] },
  ), /^<a href="\.\/releases\/VarSwitch_3\.2\.9_x64-setup\.exe"><\/a><span>VarSwitch_3\.2\.9_x64-setup\.exe<\/span>$/);
  assert.match(updated, /data-mac-download="aarch64" href="\.\/releases\/VarSwitch_3\.2\.8_aarch64\.dmg"/);
  assert.match(updated, /data-mac-file="x64">VarSwitch_3\.2\.8_x64\.dmg/);
  assert.match(updated, /VarSwitch v3\.2\.8/);
  assert.match(updated, /当前版本 v3\.2\.8 <strong>v3\.2\.8<\/strong>\n<span>当前版本<\/span>/);

  const source = { version: '3.2.8', platforms: {
    'windows-x86_64': { signature: 'windows', url: 'old' },
    'darwin-aarch64': { signature: 'arm', url: 'old' },
    'darwin-x86_64': { signature: 'intel', url: 'old' },
  } };
  assert.equal(normalizeUpdaterManifest(source, '3.2.8', {
    'windows-x86_64': 'new-windows', 'darwin-aarch64': 'new-arm', 'darwin-x86_64': 'new-intel',
  }).platforms['darwin-aarch64'].url, 'new-arm');
  assert.throws(() => normalizeUpdaterManifest(source, '3.2.9', {}), /版本/);
  assert.throws(() => normalizeUpdaterManifest({ version: '3.2.8', platforms: {} }, '3.2.8', {}), /缺少/);
});

test('published macOS instructions include scoped signature verification and link to the install steps from FAQ', () => {
  const html = fs.readFileSync('varswitch-download-site/index.html', 'utf8');
  assert.match(html, /codesign --verify --deep --strict \/Applications\/VarSwitch\.app &amp;&amp; xattr -rd com\.apple\.quarantine \/Applications\/VarSwitch\.app/);
  assert.match(html, /签名校验失败时请重新下载，不要跳过检查/);
  assert.match(html, /<a href="#install">下载区<\/a>/);
  assert.doesNotMatch(html, /sudo xattr -rd/);

  const updated = updateDownloadPage(html, '3.2.8', {
    windows: './releases/VarSwitch_3.2.8_x64-setup.exe',
    macos: [
      { arch: 'aarch64', dmgName: 'VarSwitch_3.2.8_aarch64.dmg', pageUrl: './releases/VarSwitch_3.2.8_aarch64.dmg' },
      { arch: 'x64', dmgName: 'VarSwitch_3.2.8_x64.dmg', pageUrl: './releases/VarSwitch_3.2.8_x64.dmg' },
    ],
  });
  assert.doesNotMatch(updated, /3\.1\.16/);
  assert.match(updated, /当前版本 v3\.2\.8/);
  assert.match(updated, /<strong>v3\.2\.8<\/strong>\s*<span>当前版本<\/span>/);
});

test('Mac double-click scripts prompt for a version and route release and deploy steps', () => {
  const build = fs.readFileSync('build.command', 'utf8');
  const deploy = fs.readFileSync('deploy.command', 'utf8');
  assert.match(build, /npm run release -- --interactive --include-worktree/);
  assert.match(build, /exit "\$release_exit"/);
  assert.match(fs.readFileSync('build.bat', 'utf8'), /npm run release -- --interactive --include-worktree %\*/);
  assert.match(deploy, /read -r version/);
  assert.match(deploy, /npm run release:sync -- --tag "\$tag"/);
  assert.match(deploy, /npm run site:deploy/);
});
