#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILES = [
  'package.json',
  'package-lock.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'README.md',
  'public/index.html',
  'varswitch-download-site/index.html',
];

export function parseReleaseArgs(args) {
  const options = { version: '', includeWorktree: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--version') options.version = args[++i] || '';
    else if (args[i] === '--include-worktree') options.includeWorktree = true;
    else if (args[i] === '--help' || args[i] === '-h') options.help = true;
    else throw new Error(`未知参数: ${args[i]}`);
  }
  if (!options.help && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)) {
    throw new Error('请提供正式版本号，例如 npm run release -- --version 3.2.8');
  }
  return options;
}

export function updateVersionContents(contents, version) {
  const updated = { ...contents };
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const data = JSON.parse(updated[file]);
    if (file === 'package-lock.json') {
      data.version = version;
      if (data.packages?.['']) data.packages[''].version = version;
    } else {
      data.version = version;
    }
    updated[file] = `${JSON.stringify(data, null, 2)}\n`;
  }

  for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const blocks = updated[file].split(/(?=^\[\[package\]\]\s*$)/m);
    let matches = 0;
    updated[file] = blocks.map((block) => {
      if (!/^name\s*=\s*"varswitch"\s*$/m.test(block)) return block;
      matches += 1;
      return block.replace(/^(version\s*=\s*")[^"]+("\s*)$/m, `$1${version}$2`);
    }).join('');
    if (matches !== 1) throw new Error(`${file} 中应恰好有一个 varswitch 包定义，实际找到 ${matches} 个`);
  }

  updated['README.md'] = updated['README.md'].replace(/(当前应用版本：`)\d+\.\d+\.\d+(`)/, `$1${version}$2`);
  for (const file of ['public/index.html', 'varswitch-download-site/index.html']) {
    updated[file] = updated[file]
      .replace(/(VarSwitch <span>v)\d+\.\d+\.\d+(<\/span>)/g, `$1${version}$2`)
      .replace(/(当前版本 v)\d+\.\d+\.\d+/g, `$1${version}`)
      .replace(/(<strong>v)\d+\.\d+\.\d+(\s*<\/strong>\s*<span>当前版本<\/span>)/g, `$1${version}$2`)
      .replace(/VarSwitch_\d+\.\d+\.\d+/g, `VarSwitch_${version}`)
      .replace(/(VarSwitch v)\d+\.\d+\.\d+/g, `$1${version}`);
  }
  return updated;
}

function command(args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args[0]} 失败（退出码 ${result.status}）${capture ? `\n${result.stderr}` : ''}`);
  }
  return result;
}

function runNpmScript(name) {
  if (process.env.npm_execpath) {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', name], { cwd: ROOT, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm run ${name} 失败`);
    return;
  }
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', name], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm run ${name} 失败`);
}

async function confirmWorktree(status) {
  console.log('发布提交将包含当前工作区的所有改动：');
  console.log(status);
  const readline = await import('node:readline/promises');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question('确认把以上改动一并提交并发布？输入 yes 继续：');
    if (answer.trim().toLowerCase() !== 'yes') throw new Error('已取消发布，没有提交当前改动。');
  } finally {
    terminal.close();
  }
}

async function main() {
  const options = parseReleaseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法: npm run release -- --version 3.2.8 [--include-worktree]\n\n同步版本、运行测试、提交并推送标签。--include-worktree 会先列出并确认提交当前全部工作区改动。GitHub Actions 随后构建 Windows 与两种 macOS 安装包。');
    return;
  }

  const branchResult = command(['branch', '--show-current'], { capture: true });
  const branch = branchResult.stdout.trim();
  if (!branch) throw new Error('当前为 detached HEAD；请先切换到要发布的分支。');
  const status = command(['status', '--short'], { capture: true }).stdout.trim();
  if (status && !options.includeWorktree) throw new Error('工作区有未提交改动。先提交改动，或使用 --include-worktree 在确认后将它们一并发布。');
  if (status) await confirmWorktree(status);

  const tag = `v${options.version}`;
  if (command(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { allowFailure: true }).status === 0) {
    throw new Error(`本地标签 ${tag} 已存在。`);
  }
  const remoteTag = command(['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], { capture: true, allowFailure: true });
  if (remoteTag.status === 0 && remoteTag.stdout.trim()) throw new Error(`远端标签 ${tag} 已存在。`);
  if (remoteTag.status > 1) throw new Error('无法检查远端标签，请确认 origin 网络和权限正常。');

  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')).version;
  if (current === options.version) throw new Error(`当前版本已经是 ${options.version}。`);
  const originals = Object.fromEntries(VERSION_FILES.map((file) => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));
  const updated = updateVersionContents(originals, options.version);
  try {
    for (const file of VERSION_FILES) fs.writeFileSync(path.join(ROOT, file), updated[file]);
    console.log(`[1/4] 版本号已同步为 ${options.version}，运行前端测试...`);
    runNpmScript('test');
    console.log('[2/4] 运行 Rust 测试...');
    const cargo = spawnSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib'], { cwd: ROOT, stdio: 'inherit' });
    if (cargo.error) throw cargo.error;
    if (cargo.status !== 0) throw new Error('Rust 测试失败，未创建发布提交。');
  } catch (error) {
    for (const file of VERSION_FILES) fs.writeFileSync(path.join(ROOT, file), originals[file]);
    throw error;
  }

  console.log('[3/4] 提交版本号并创建发布标签...');
  if (options.includeWorktree) command(['add', '-A']);
  else command(['add', '--', ...VERSION_FILES]);
  command(['commit', '-m', `chore: release ${tag}`]);
  console.log(`[4/4] 推送 ${branch} 与 ${tag}，GitHub Actions 将构建 Windows 和 macOS...`);
  command(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  command(['tag', '-a', tag, '-m', `VarSwitch ${tag}`]);
  command(['push', 'origin', tag]);
  console.log(`发布构建已触发：https://github.com/ConcertoNotes/varswitch/actions`);
  console.log(`构建及草稿 Release 全部成功后，在 Mac 上运行 npm run release:sync -- --tag ${tag}，再 npm run site:deploy。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[release] ${error.message}`); process.exitCode = 1; });
}

export { VERSION_FILES };
