#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseNotes } from './release.mjs';

const DOWNLOAD_DOMAIN = 'https://download.varswitch.strova.top';

export function createManifest(tag, assetDirectory, publishedAt = new Date().toISOString(), notes = readReleaseNotes(tag)) {
  const version = tag.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`非法发布标签: ${tag}`);
  const targets = [
    ['windows-x86_64', `VarSwitch_${version}_x64-setup.exe`],
    ['darwin-aarch64', `VarSwitch_${version}_aarch64.app.tar.gz`],
    ['darwin-x86_64', `VarSwitch_${version}_x64.app.tar.gz`],
  ];
  const platforms = {};
  for (const [platform, updater] of targets) {
    const updaterFile = path.join(assetDirectory, updater);
    const signatureFile = path.join(assetDirectory, `${updater}.sig`);
    if (!fs.statSync(updaterFile).isFile()) throw new Error(`缺少更新包 ${updaterFile}`);
    const signature = fs.readFileSync(signatureFile, 'utf8').trim();
    if (!signature) throw new Error(`${signatureFile} 中的更新签名为空`);
    platforms[platform] = {
      signature,
      url: `${DOWNLOAD_DOMAIN}/releases/${updater}`,
    };
  }
  return {
    version,
    notes: notes || `VarSwitch update ${version}`,
    pub_date: publishedAt.replace(/\.\d+Z$/, 'Z'),
    platforms,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , tag, assetDirectory] = process.argv;
    if (!tag || !assetDirectory) throw new Error('用法: node scripts/create-updater-manifest.mjs v3.2.8 <GitHub-release-download-dir>');
    console.log(JSON.stringify(createManifest(tag, assetDirectory), null, 2));
  } catch (error) {
    console.error(`[manifest] ${error.message}`);
    process.exitCode = 1;
  }
}
