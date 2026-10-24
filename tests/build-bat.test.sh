#!/usr/bin/env bash
set -euo pipefail

grep -Fq 'npm run dev -- %*' dev.bat || {
  echo "dev.bat must forward to the cross-platform development command" >&2
  exit 1
}

grep -Fq 'npm run release -- --interactive --include-worktree %*' build.bat || {
  echo "build.bat must prompt for a version and changes via the cross-platform release command" >&2
  exit 1
}

node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.scripts.dev, 'node scripts/dev.mjs');
assert.equal(pkg.scripts.build, 'node scripts/build.mjs');
assert.match(pkg.scripts['site:deploy'], /vercel deploy --prod/);
JS

node -e 'const c=require("./src-tauri/tauri.conf.json"); if(c.bundle?.windows?.nsis?.compression!=="zlib") process.exit(1)' || {
  echo "missing: configures low-memory NSIS zlib compression" >&2
  exit 1
}
