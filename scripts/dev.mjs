#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = path.join(ROOT, 'node_modules/@tauri-apps/cli/tauri.js');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function parseArgs(args) {
  const options = { install: 'auto', fresh: true, tauri: [] };
  for (const arg of args) {
    if (arg === '--skip-install') options.install = 'skip';
    else if (arg === '--install') options.install = 'force';
    else if (arg === '--fast') options.fresh = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else options.tauri.push(arg);
  }
  return options;
}

function stopOldApp() {
  if (process.platform === 'win32') {
    run('taskkill', ['/f', '/im', 'varswitch.exe'], { stdio: 'ignore' });
  } else {
    run('pkill', ['-x', 'varswitch'], { stdio: 'ignore' });
  }
}

function startDev(options) {
  if (options.help) {
    console.log('用法: npm run dev [-- --skip-install|--install] [--fast] [tauri-dev-args]');
    return;
  }
  const tempDir = path.join(ROOT, 'src-tauri/target/dev-temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const env = { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir };

  const hasTauri = fs.existsSync(TAURI);
  if (options.install === 'force' || (!hasTauri && options.install !== 'skip')) {
    const installStatus = run('npm', ['ci'], { shell: process.platform === 'win32' });
    if (installStatus !== 0) return installStatus;
  } else if (!hasTauri) {
    throw new Error('找不到 Tauri CLI，请先运行 npm ci，或去掉 --skip-install。');
  }

  if (options.fresh) {
    console.log('[1/2] 关闭旧进程并重新编译 VarSwitch 主程序...');
    stopOldApp();
    const cargo = run('cargo', ['clean', '-p', 'varswitch', '--manifest-path', path.join(ROOT, 'src-tauri/Cargo.toml')], { stdio: 'ignore' });
    if (cargo !== 0) console.warn('无法清理 Rust 主程序缓存，将继续使用 Tauri 开发模式。');
  }

  console.log('[2/2] 启动 Tauri 开发模式...');
  const child = spawn(process.execPath, [TAURI, 'dev', ...options.tauri], { cwd: ROOT, env, stdio: 'inherit' });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    startDev(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`[dev] ${error.message}`);
    process.exitCode = 1;
  }
}

export { parseArgs };
