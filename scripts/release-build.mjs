#!/usr/bin/env node
// tauri-action 使用此入口：校验必须在 action 上传任何产物之前完成。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLE_CREDENTIALS = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];

export function checkMacCredentials(env) {
  const missing = APPLE_CREDENTIALS.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`macOS 正式签名缺少凭据: ${missing.join(', ')}。请按 README 配置完整的 GitHub Actions secrets。`);
  if (!env.APPLE_SIGNING_IDENTITY.startsWith('Developer ID Application:')) {
    throw new Error('APPLE_SIGNING_IDENTITY 必须是 Developer ID Application 证书名称，不能使用临时签名或 Apple Development 证书。');
  }
}

export function macSigningMode(env) {
  const configured = APPLE_CREDENTIALS.some((name) => env[name]?.trim() && !(name === 'APPLE_SIGNING_IDENTITY' && env[name] === '-'));
  if (!configured) return 'adhoc';
  // 部分凭据缺失通常是配置错误，不能静默退回临时签名。
  checkMacCredentials(env);
  return 'notarized';
}

export function macBuildEnvironment(env) {
  const result = { ...env };
  if (macSigningMode(env) === 'adhoc') {
    // 空字符串也会被 Tauri 当作已提供的公证凭据，必须移除而非设为空。
    for (const name of APPLE_CREDENTIALS) delete result[name];
    result.APPLE_SIGNING_IDENTITY = '-';
  }
  return result;
}

function run(command, args, capture = false, env = process.env) {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // 不回显命令参数，避免未来新增工具参数时泄露凭据。
    throw new Error(`${path.basename(command)} 校验/构建失败（退出码 ${result.status}）${capture ? `\n${result.stdout || ''}${result.stderr || ''}` : ''}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

export function verifyApp(app, teamId, execute = run, mode = 'notarized') {
  execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const signature = execute('/usr/bin/codesign', ['--display', '--verbose=4', app], true);
  if (mode === 'adhoc') {
    if (!signature.includes('Signature=adhoc')) throw new Error('无证书构建必须具有有效的临时签名。');
    return;
  }
  if (!signature.includes('Authority=Developer ID Application:') || !signature.split('\n').includes(`TeamIdentifier=${teamId}`) || !/flags=.*\bruntime\b/.test(signature)) {
    throw new Error('macOS App 缺少正确的 Developer ID 签名、Team ID 或 Hardened Runtime。');
  }
  execute('/usr/bin/xcrun', ['stapler', 'validate', app]);
  execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
}

export function verifyMacArtifacts(args, env = process.env) {
  const mode = macSigningMode(env);
  const targetIndex = args.indexOf('--target');
  const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
  if (!['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target)) throw new Error('macOS 发布必须显式指定 --target aarch64-apple-darwin 或 x86_64-apple-darwin。');
  const bundle = path.join(ROOT, 'src-tauri/target', target, 'release/bundle');
  const app = path.join(bundle, 'macos/VarSwitch.app');
  const updater = path.join(bundle, 'macos/VarSwitch.app.tar.gz');
  for (const file of [app, updater, `${updater}.sig`]) {
    if (!fs.existsSync(file)) throw new Error(`缺少发布产物: ${file}`);
  }
  if (!fs.readFileSync(`${updater}.sig`, 'utf8').trim()) throw new Error('更新包签名为空。');
  verifyApp(app, env.APPLE_TEAM_ID, run, mode);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'varswitch-release-'));
  try {
    const extracted = path.join(scratch, 'updater');
    fs.mkdirSync(extracted);
    run('/usr/bin/tar', ['-xzf', updater, '-C', extracted]);
    verifyApp(path.join(extracted, 'VarSwitch.app'), env.APPLE_TEAM_ID, run, mode);

    const dmgDir = path.join(bundle, 'dmg');
    const dmgs = fs.readdirSync(dmgDir).filter((name) => name.endsWith('.dmg'));
    if (dmgs.length !== 1) throw new Error('macOS 发布必须且只能生成一个 DMG，请清理旧产物后重试。');
    const dmg = path.join(dmgDir, dmgs[0]);
    run('/usr/bin/hdiutil', ['verify', dmg]);
    const mount = path.join(scratch, 'mounted');
    fs.mkdirSync(mount);
    run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
    try {
      verifyApp(path.join(mount, 'VarSwitch.app'), env.APPLE_TEAM_ID, run, mode);
    } finally {
      run('/usr/bin/hdiutil', ['detach', mount]);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log(mode === 'notarized'
    ? 'macOS App、DMG 与自动更新包的 Apple 签名、公证票据及 Gatekeeper 校验通过。'
    : 'macOS App、DMG 与自动更新包的临时签名和完整性校验通过；未经过 Apple 公证，首次打开需要手动放行。');
}

function main() {
  const args = process.argv.slice(2);
  const env = process.platform === 'darwin' && args[0] === 'build' ? macBuildEnvironment(process.env) : process.env;
  const cli = path.join(ROOT, 'node_modules/@tauri-apps/cli/tauri.js');
  run(process.execPath, [cli, ...args], false, env);
  if (process.platform === 'darwin' && args[0] === 'build') verifyMacArtifacts(args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
