import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildArgs, parseBuildOptions } from '../scripts/build.mjs';
import { parseReleaseArgs, updateVersionContents } from '../scripts/release.mjs';
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

test('version release synchronizes npm, Cargo, README and visible app/site version references', () => {
  const contents = {
    'package.json': '{"name":"varswitch","version":"3.2.7"}\n',
    'package-lock.json': '{"version":"3.2.7","packages":{"":{"version":"3.2.7"}}}\n',
    'src-tauri/tauri.conf.json': '{"version":"3.2.7"}\n',
    'src-tauri/Cargo.toml': '[package]\nname = "varswitch"\nversion = "3.2.7"\n\n[dependencies]\n',
    'src-tauri/Cargo.lock': '[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "varswitch"\nversion = "3.2.7"\n',
    'README.md': '当前应用版本：`3.1.17`。\n',
    'public/index.html': 'VarSwitch <span>v3.1.21</span>',
    'varswitch-download-site/index.html': 'VarSwitch_3.1.16_x64-setup.exe VarSwitch v3.1.16 当前版本 v3.1.16 <strong>v3.1.16</strong>\n<span>当前版本</span>',
  };
  const updated = updateVersionContents(contents, '3.3.0');
  assert.equal(JSON.parse(updated['package.json']).version, '3.3.0');
  assert.equal(JSON.parse(updated['package-lock.json']).packages[''].version, '3.3.0');
  assert.match(updated['src-tauri/Cargo.toml'], /version = "3\.3\.0"/);
  assert.match(updated['src-tauri/Cargo.lock'], /name = "varswitch"\nversion = "3\.3\.0"/);
  assert.match(updated['README.md'], /`3\.3\.0`/);
  assert.match(updated['public/index.html'], /v3\.3\.0/);
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
  assert.match(updated, /VarSwitch_3\.2\.8_x64-setup\.exe/);
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
  assert.match(build, /read -r version/);
  assert.match(build, /npm run release -- --version "\$version"/);
  assert.match(deploy, /read -r version/);
  assert.match(deploy, /npm run release:sync -- --tag "\$tag"/);
  assert.match(deploy, /npm run site:deploy/);
});
