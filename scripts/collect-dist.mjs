/**
 * Copies the latest Tauri build into ./dist so the project root only keeps one
 * set of artifacts:
 *   dist/FileDock.exe                    portable single-file build
 *   dist/FileDock_<version>_x64-setup.exe NSIS installer
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'target', 'release');
const out = join(root, 'dist');

if (!existsSync(target)) {
  console.error('未找到 target/release，请先运行 npm run dist');
  process.exit(1);
}

mkdirSync(out, { recursive: true });

const portable = join(target, 'filedock.exe');
if (!existsSync(portable)) {
  console.error('未找到 target/release/filedock.exe');
  process.exit(1);
}
copyFileSync(portable, join(out, 'FileDock.exe'));
console.log('复制 filedock.exe -> dist/FileDock.exe');

const bundle = join(target, 'bundle', 'nsis');
const installers = existsSync(bundle)
  ? readdirSync(bundle).filter((name) => name.toLowerCase().endsWith('.exe'))
  : [];
if (installers.length === 0) {
  console.warn('未找到 NSIS 安装包（target/release/bundle/nsis）');
} else {
  for (const name of installers) {
    copyFileSync(join(bundle, name), join(out, name));
    console.log(`复制 ${name} -> dist/${name}`);
  }
}
