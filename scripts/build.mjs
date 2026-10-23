#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { macBuildEnvironment } from './release-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = path.join(ROOT, 'node_modules/@tauri-apps/cli/tauri.js');
const DEFAULT_BUNDLES = {
  darwin: 'app,dmg',
  win32: 'nsis',
  linux: 'appimage,deb',
};

export function parseBuildOptions(args) {
  const options = { install: 'auto', tauri: [] };
  for (const arg of args) {
    if (arg === '--skip-install') options.install = 'skip';
    else if (arg === '--install') options.install = 'force';
    else if (arg === '--no-pause') continue;
    else options.tauri.push(arg);
  }
  return options;
}

export function buildArgs(platform, args) {
  const result = [...args];
  if (!result.includes('--bundles') && !result.includes('-b')) {
    result.push('--bundles', DEFAULT_BUNDLES[platform] || 'all');
  }
  if (platform === 'darwin' && !result.includes('--config')) {
    result.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  }
  return result;
}

function main() {
  const options = parseBuildOptions(process.argv.slice(2));
  const hasTauri = fs.existsSync(TAURI);
  if (options.install === 'force' || (!hasTauri && options.install !== 'skip')) {
    const install = spawnSync('npm', ['ci'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (install.error) throw install.error;
    if (install.status !== 0) throw new Error('依赖安装失败');
  } else if (!hasTauri) {
    throw new Error('找不到 Tauri CLI，请先运行 npm ci，或去掉 --skip-install。');
  }
  const args = buildArgs(process.platform, options.tauri);
  const env = process.platform === 'darwin' ? macBuildEnvironment(process.env) : process.env;
  const result = spawnSync(process.execPath, [TAURI, 'build', ...args], { cwd: ROOT, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0 && !args.includes('--help') && !args.includes('-h')) {
    console.log(`构建完成：${path.join(ROOT, 'src-tauri/target/release/bundle')}`);
    if (process.platform === 'darwin') console.log('本地 macOS 包不包含自动更新签名；正式三平台发布请运行 npm run release。');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`[build] ${error.message}`); process.exitCode = 1; }
}
