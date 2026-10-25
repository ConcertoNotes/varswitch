#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILES = [
  'package.json',
  'package-lock.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'README.md',
  'public/index.html',
  'public/changelog.json',
  'varswitch-download-site/index.html',
];

export function parseReleaseArgs(args) {
  const options = { version: '', includeWorktree: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--version') options.version = args[++i] || '';
    else if (args[i] === '--include-worktree') options.includeWorktree = true;
    else if (args[i] === '--interactive') options.interactive = true;
    else if (args[i] === '--notes-file') {
      options.notesFile = args[++i];
      if (!options.notesFile) throw new Error('--notes-file 需要一个更新说明文件路径');
    }
    else if (args[i] === '--help' || args[i] === '-h') options.help = true;
    else throw new Error(`未知参数: ${args[i]}`);
  }
  if (!options.help && !(options.interactive && !options.version) && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)) {
    throw new Error('请提供正式版本号，例如 npm run release -- --version 3.2.8');
  }
  return options;
}

export async function promptReleaseOptions(options, { input = process.stdin, output = process.stdout } = {}) {
  // TTY 模式由 readline 管理 UTF-8 字符宽度、退格、光标移动和 Ctrl+U。
  // 缺少 output 会退回管道模式，由系统回显中文，产生删不干净的残影。
  const terminal = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY), crlfDelay: Infinity });
  terminal.on('SIGINT', () => terminal.close());
  const lines = terminal[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    if (terminal.terminal && !terminal.closed) {
      terminal.setPrompt(prompt);
      terminal.prompt();
    } else {
      output.write(prompt);
    }
    const line = await lines.next();
    if (line.done) throw new Error('输入已结束，已取消发布。');
    return line.value;
  };
  try {
    const version = options.version || (await ask('请输入发布版本号（例如 3.2.8）：')).trim();
    parseReleaseArgs(['--version', version]);
    let notes;
    if (!options.notesFile) {
      output.write('请输入本次修改和变化（支持多行，单独输入 . 后回车结束）：\n');
      const changes = [];
      while (true) {
        const line = await ask('> ');
        if (line.trim() === '.') break;
        changes.push(line);
      }
      notes = changes.join('\n').trim();
      if (!notes) throw new Error('更新说明不能为空，已取消发布。');
    }
    return { ...options, version, notes };
  } finally {
    terminal.close();
  }
}

export function readReleaseNotes(tag, root = ROOT) {
  const version = tag.replace(/^v/, '');
  parseReleaseArgs(['--version', version]);
  const file = path.join(root, 'release-notes', `v${version}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
}

export function releaseBody(notes, existing) {
  if (!notes) return existing;
  const prefix = `## 本次修改和变化\n\n${notes}\n\n`;
  return existing.startsWith(prefix) ? existing : `${prefix}${existing}`;
}

export function checkRemoteTag(result, tag) {
  if (result.error) throw result.error;
  if (result.status === 0 && result.stdout.trim()) throw new Error(`远端标签 ${tag} 已存在。`);
  // git ls-remote --exit-code: 2 means no matching ref, which is expected for a new release.
  if (result.status !== 0 && result.status !== 2) {
    throw new Error(`无法检查远端标签（退出码 ${result.status}），尚未提交或推送。请检查 origin 网络和权限。\n${result.stderr?.trim() || ''}`);
  }
}

export function updateChangelog(contents, version, notes, date = new Date().toISOString().slice(0, 10)) {
  const data = JSON.parse(contents);
  const items = notes.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((text) => ({ type: 'improve', text: text.replace(/^[-*]\s+/, '') }));
  if (!items.length) throw new Error('更新说明不能为空');
  data.releases = [{ version, date, items }, ...(data.releases || []).filter((entry) => entry.version !== version)];
  data._comment = '发布脚本自动写入，随安装包提供；当前版本首次启动时展示一次。';
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function updateVersionContents(contents, version, notes = '') {
  const updated = { ...contents };
  if (notes) updated['public/changelog.json'] = updateChangelog(updated['public/changelog.json'], version, notes);
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
  let options = parseReleaseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法: npm run release -- --interactive [--include-worktree]\n或: npm run release -- --version 3.2.8 --notes-file changes.md [--include-worktree]\n\n交互输入版本号和多行更新说明，同步版本、运行测试、提交并推送标签。更新说明保存到 release-notes/v版本号.md，并显示在 GitHub Release 与应用更新提示中。--include-worktree 会先列出并确认提交当前全部工作区改动。GitHub Actions 随后构建 Windows 与两种 macOS 安装包。');
    return;
  }
  if (options.interactive) options = await promptReleaseOptions(options);
  const notes = (options.notesFile
    ? fs.readFileSync(path.resolve(ROOT, options.notesFile), 'utf8')
    : options.notes ?? readReleaseNotes(`v${options.version}`)).trim();
  if (!notes) throw new Error('请填写本次修改和变化：使用 --interactive 交互输入，或 --notes-file 指定更新说明文件。');
  console.log(`\n发布版本：${options.version}\n本次修改和变化：\n${notes}\n`);

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
  checkRemoteTag(remoteTag, tag);

  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')).version;
  if (current === options.version) throw new Error(`当前版本已经是 ${options.version}。`);
  const originals = Object.fromEntries(VERSION_FILES.map((file) => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));
  const updated = updateVersionContents(originals, options.version, notes);
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

  const notesFile = `release-notes/${tag}.md`;
  fs.mkdirSync(path.join(ROOT, 'release-notes'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, notesFile), `${notes}\n`);
  console.log('[3/4] 提交版本号并创建发布标签...');
  if (options.includeWorktree) command(['add', '-A']);
  else command(['add', '--', ...VERSION_FILES, notesFile]);
  command(['commit', '-m', `chore: release ${tag}`]);
  console.log(`[4/4] 推送 ${branch} 与 ${tag}，GitHub Actions 将构建 Windows 和 macOS...`);
  command(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  command(['tag', '-a', tag, '-m', `VarSwitch ${tag}`]);
  command(['push', 'origin', tag]);
  console.log(`发布成功：代码和标签 ${tag} 已推送到 GitHub。`);
  console.log(`GitHub Actions 已触发构建（安装包尚需等待）：https://github.com/ConcertoNotes/varswitch/actions`);
  console.log(`构建及草稿 Release 全部成功后，在 Mac 上运行 npm run release:sync -- --tag ${tag}，再 npm run site:deploy。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[release] ${error.message}`); process.exitCode = 1; });
}

export { VERSION_FILES };
