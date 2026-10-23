#!/usr/bin/env node
// 将 GitHub Actions 构建的三平台安装包与 updater 清单同步到静态下载站。

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(ROOT, 'varswitch-download-site');
const RELEASES_DIR = path.join(SITE_DIR, 'releases');
const INDEX_FILE = path.join(SITE_DIR, 'index.html');
const LATEST_FILE = path.join(SITE_DIR, 'latest.json');
const TAURI_CONF = path.join(ROOT, 'src-tauri', 'tauri.conf.json');

const DOWNLOAD_DOMAIN = 'https://download.varswitch.strova.top';
const DEFAULT_REPO = 'ConcertoNotes/varswitch';

// arch 取值与 .github/workflows/build.yml 的 releaseAssetNamePattern 保持一致。
const MAC_TARGETS = [
  { platform: 'darwin-aarch64', arch: 'aarch64' },
  { platform: 'darwin-x86_64', arch: 'x64' },
];

const DOWNLOAD_ATTEMPTS = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = { tag: '', repo: DEFAULT_REPO, host: 'local', token: process.env.GITHUB_TOKEN || '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} 需要一个参数值`);
      i += 1;
      return value;
    };
    if (arg === '--tag') options.tag = next();
    else if (arg === '--repo') options.repo = next();
    else if (arg === '--host') options.host = next();
    else if (arg === '--token') options.token = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!['local', 'github'].includes(options.host)) {
    throw new Error(`--host 只能是 local 或 github，收到: ${options.host}`);
  }
  return options;
}

function resolveToken(token) {
  if (token) return token;
  const gh = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8' });
  if (!gh.error && gh.status === 0 && gh.stdout.trim()) return gh.stdout.trim();
  throw new Error('私有仓库需要 GitHub 读取权限。首次使用请运行 gh auth login，然后重试；也可设置 GITHUB_TOKEN。');
}

function printHelp() {
  console.log(`用法: node sync-mac-release.mjs [选项]

选项:
  --tag <v3.2.8>     要同步的 GitHub Release 标签，默认取 tauri.conf.json 的版本号
  --repo <owner/name> 仓库，默认 ${DEFAULT_REPO}
  --host <local|github>
                     local  下载 Windows、macOS 安装包及 updater 包（默认）
                     github 不下载文件，下载页和 updater 清单直链 GitHub Release
  --token <PAT>      GitHub Token；默认读取 gh auth token 或 GITHUB_TOKEN
  -h, --help         显示帮助

前置条件:
  已推送 tag 且 Release 已发布，三平台构建与 updater 清单完整。`);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function fetchRelease({ repo, tag, token }) {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'varswitch-sync' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (response.status === 404) {
    // 私有仓库对未认证请求同样返回 404，因此这里无法区分「不存在」和「没权限」。
    const hint = token
      ? '请确认 tag 已推送、Actions 构建已完成，且 token 对该仓库有读权限。'
      : `${repo} 是私有仓库时匿名访问也会返回 404，请用 --token 传入有 repo 读权限的 Token 后重试。`;
    throw new Error(`找不到 Release ${tag}（${repo}）。${hint}`);
  }
  if (response.status === 403 && !token) {
    throw new Error('GitHub API 限流。请用 --token 传入一个 Personal Access Token 后重试。');
  }
  if (!response.ok) {
    throw new Error(`读取 Release 失败: HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// 走代理下载 GitHub 资源时连接经常中途断开（Node 报 fetch failed）。
// 一次抖动不该让整轮同步作废，因此这里对网络错误与 5xx 做重试；
// 4xx 是权限或资源问题，重试没有意义，直接抛出。
async function downloadAsset(asset, token) {
  const headers = { Accept: 'application/octet-stream', 'User-Agent': 'varswitch-sync' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const name = asset.label || asset.name;

  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(asset.url, { headers, redirect: 'follow' });
      if (!response.ok) {
        const error = new Error(`下载 ${name} 失败: HTTP ${response.status}`);
        if (response.status >= 400 && response.status < 500) error.fatal = true;
        throw error;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) {
        const waitMs = attempt * 2000;
        console.warn(`  ${name} 第 ${attempt} 次下载失败（${error.message}），${waitMs / 1000}s 后重试`);
        await sleep(waitMs);
      }
    }
  }
  throw new Error(`下载 ${name} 失败，已重试 ${DOWNLOAD_ATTEMPTS} 次: ${lastError.message}`);
}

function findAsset(assets, name) {
  // tauri-action 上传时会把 label 设为原始文件名，GitHub 可能改写 name 字段。
  return assets.find((asset) => asset.label === name || asset.name === name);
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const SITE_ARTIFACT = /^VarSwitch_.+_(?:x64-setup\.exe|aarch64\.(?:dmg|app\.tar\.gz)|x64\.(?:dmg|app\.tar\.gz))$/;

async function pruneOldArtifacts(version) {
  let removed = 0;
  for (const name of await fs.readdir(RELEASES_DIR)) {
    if (SITE_ARTIFACT.test(name) && !name.startsWith(`VarSwitch_${version}_`)) {
      await fs.unlink(path.join(RELEASES_DIR, name));
      removed += 1;
    }
  }
  if (removed > 0) console.log(`已清理 ${removed} 个旧版本安装包与更新包`);
}

function updateDownloadPage(html, version, downloads) {
  html = html
    .replace(/VarSwitch_\d+\.\d+\.\d+_x64-setup\.exe/g, downloads.windows)
    .replace(/(当前版本 v)\d+\.\d+\.\d+/g, `$1${version}`)
    .replace(/(<strong>v)\d+\.\d+\.\d+(\s*<\/strong>\s*<span>当前版本<\/span>)/g, `$1${version}$2`)
    .replace(/(VarSwitch <span>v)\d+\.\d+\.\d+(<\/span>)/g, `$1${version}$2`)
    .replace(/(VarSwitch v)\d+\.\d+\.\d+/g, `$1${version}`);
  for (const entry of downloads.macos) {
    const hrefPattern = new RegExp(`(data-mac-download="${entry.arch}"[^>]*?href=")[^"]*(")`, 'i');
    const filePattern = new RegExp(`(data-mac-file="${entry.arch}"[^>]*>)[^<]*(</)`, 'i');
    if (hrefPattern.test(html)) html = html.replace(hrefPattern, `$1${entry.pageUrl}$2`);
    if (filePattern.test(html)) html = html.replace(filePattern, `$1${entry.dmgName}$2`);
  }
  return html;
}

async function updateIndexHtml(version, downloads) {
  const html = updateDownloadPage(await fs.readFile(INDEX_FILE, 'utf8'), version, downloads);
  await fs.writeFile(INDEX_FILE, html, 'utf8');
  console.log('已更新下载页中的 Windows、Apple 芯片及 Intel 下载链接');
}

function normalizeUpdaterManifest(source, version, updaterUrls) {
  if (source.version !== version) throw new Error(`Release updater 清单版本 ${source.version} 与 ${version} 不一致`);
  const platforms = source.platforms || {};
  for (const platform of ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64']) {
    const entry = platforms[platform];
    if (!entry?.signature?.trim()) throw new Error(`Release updater 清单缺少 ${platform} 签名`);
    if (!updaterUrls[platform]) throw new Error(`缺少 ${platform} 更新包 URL`);
    entry.url = updaterUrls[platform];
  }
  return { ...source, platforms };
}

async function updateLatestJson(manifest) {
  await fs.writeFile(LATEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`已更新 latest.json，包含平台: ${Object.keys(manifest.platforms).join(', ')}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const conf = await readJson(TAURI_CONF);
  const version = conf.version;
  const tag = options.tag || `v${version}`;

  console.log(`仓库:   ${options.repo}`);
  console.log(`标签:   ${tag}`);
  console.log(`版本:   ${version}`);
  console.log(`托管:   ${options.host === 'local' ? '下载站自有域名' : 'GitHub Release'}`);
  console.log('');

  options.token = resolveToken(options.token);
  const release = await fetchRelease({ repo: options.repo, tag, token: options.token });
  if (release.draft) throw new Error(`Release ${tag} 仍是草稿，请等所有平台的构建与校验完成。`);
  const assets = release.assets || [];
  if (assets.length === 0) {
    throw new Error(`Release ${tag} 没有任何资源，构建可能失败了。`);
  }

  const sourceManifestAsset = findAsset(assets, 'latest.json');
  if (!sourceManifestAsset) throw new Error(`Release ${tag} 缺少 latest.json，请确认三平台构建已全部成功。`);
  const sourceManifest = JSON.parse((await downloadAsset(sourceManifestAsset, options.token)).toString('utf8'));
  for (const platform of ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64']) {
    if (!sourceManifest.platforms?.[platform]?.signature) throw new Error(`Release updater 清单缺少 ${platform}，不能发布不完整版本。`);
  }

  await fs.mkdir(RELEASES_DIR, { recursive: true });
  const downloads = {
    version,
    windows: `./releases/VarSwitch_${version}_x64-setup.exe`,
    macos: [],
  };
  const updaterUrls = {};

  const windowsName = `VarSwitch_${version}_x64-setup.exe`;
  const windowsAsset = findAsset(assets, windowsName);
  if (!windowsAsset) throw new Error(`Release ${tag} 缺少 Windows 安装包 ${windowsName}`);
  if (options.host === 'local') {
    const destination = path.join(RELEASES_DIR, windowsName);
    const existing = await fs.stat(destination).catch(() => null);
    if (!existing || existing.size !== windowsAsset.size) {
      const buffer = await downloadAsset(windowsAsset, options.token);
      await fs.writeFile(destination, buffer);
      console.log(`已下载 ${windowsName} (${formatSize(buffer.length)})`);
    } else {
      console.log(`已存在 ${windowsName} (${formatSize(existing.size)})，跳过下载`);
    }
    updaterUrls['windows-x86_64'] = `${DOWNLOAD_DOMAIN}/releases/${windowsName}`;
  } else {
    downloads.windows = windowsAsset.browser_download_url;
    updaterUrls['windows-x86_64'] = sourceManifest.platforms['windows-x86_64'].url;
  }

  for (const target of MAC_TARGETS) {
    const dmgName = `VarSwitch_${version}_${target.arch}.dmg`;
    const updaterName = `VarSwitch_${version}_${target.arch}.app.tar.gz`;
    const dmgAsset = findAsset(assets, dmgName);
    const updaterAsset = findAsset(assets, updaterName);
    if (!dmgAsset || !updaterAsset) throw new Error(`Release ${tag} 缺少 ${target.platform} 安装包或更新包`);

    let pageUrl;
    let updaterUrl;

    if (options.host === 'local') {
      // 落盘一律使用规范名，GitHub 有时会改写资源的 name 字段，
      // 若照抄回来会和页面链接、latest.json 里的 URL 对不上。
      for (const [asset, fileName] of [[dmgAsset, dmgName], [updaterAsset, updaterName]]) {
        const filePath = path.join(RELEASES_DIR, fileName);
        // 上一轮中断后重跑时，已经完整落盘的大文件不必再下一次。
        const existing = await fs.stat(filePath).catch(() => null);
        if (existing && existing.size === asset.size) {
          console.log(`已存在 ${fileName} (${formatSize(existing.size)})，跳过下载`);
          continue;
        }
        const buffer = await downloadAsset(asset, options.token);
        await fs.writeFile(filePath, buffer);
        console.log(`已下载 ${fileName} (${formatSize(buffer.length)})`);
      }
      pageUrl = `./releases/${dmgName}`;
      updaterUrl = `${DOWNLOAD_DOMAIN}/releases/${updaterName}`;
    } else {
      pageUrl = dmgAsset.browser_download_url;
      updaterUrl = updaterAsset.browser_download_url;
      console.log(`已解析 ${dmgName} 的 GitHub 下载地址`);
    }

    downloads.macos.push({ arch: target.arch, dmgName, pageUrl });
    updaterUrls[target.platform] = updaterUrl;
  }

  console.log('');
  const manifest = normalizeUpdaterManifest(sourceManifest, version, updaterUrls);
  await updateLatestJson(manifest);
  await updateIndexHtml(version, downloads);
  await pruneOldArtifacts(version);

  console.log('\n同步完成；在仓库根目录运行 npm run site:deploy 部署下载页和三平台安装包。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\n[error] ${error.message}`);
    process.exitCode = 1;
  });
}

export { normalizeUpdaterManifest, parseArgs, updateDownloadPage };
