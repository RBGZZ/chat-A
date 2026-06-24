/**
 * desktop 构建脚本(esbuild):把 TS 源打成 Electron 可直接加载的产物。
 *   - main.ts    → dist/main.cjs      (Electron 主进程,Node 平台,CJS;electron/naudiodon 外置)
 *   - preload.ts → dist/preload.cjs   (preload 安全桥,CJS;electron 外置)
 *   - renderer/renderer.ts → dist/renderer/renderer.js (浏览器 IIFE)
 *   - 复制 renderer/index.html、styles.css → dist/renderer/
 *
 * @chat-a/* 工作区 TS 源被 bundle 进产物(主进程 in-process 复用既有装配)。
 * electron / naudiodon 标记为 external:electron 由运行时提供;naudiodon 经动态 import 运行时按需加载
 * (装不上时 NodeAudioDevice.init() 抛错 → 优雅降级,见 README)。
 */
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const src = join(root, 'src');

const external = ['electron', 'naudiodon', 'better-sqlite3'];

async function run() {
  await mkdir(join(dist, 'renderer'), { recursive: true });

  // 主进程(Node 平台,ESM)。用 ESM 以正确保留依赖里的 `import.meta.url`
  // (gateway/providers 用 createRequire(import.meta.url) 动态加载 ws 等;CJS 输出会把它置空)。
  // Electron ≥28 支持 ESM 主进程(.mjs)。
  await build({
    entryPoints: [join(src, 'main.ts')],
    outfile: join(dist, 'main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    sourcemap: true,
    logLevel: 'info',
    // ESM 输出里 __dirname/require 不存在:注入基于 import.meta.url 的兼容定义。
    // createRequire 定义的 require 让 esbuild 的 __require 垫片回落到真 require——否则 bundled CJS 依赖
    // (如 yaml 内部 `require('process')`)在 ESM 产物里抛「Dynamic require of X is not supported」。
    banner: {
      js: "import { fileURLToPath as __f } from 'node:url'; import { dirname as __d } from 'node:path'; import { createRequire as __cr } from 'node:module'; const __filename = __f(import.meta.url); const __dirname = __d(__filename); const require = __cr(import.meta.url);",
    },
  });

  // preload(Node 平台,CJS;sandbox 下 preload 须 CJS)。
  await build({
    entryPoints: [join(src, 'preload.ts')],
    outfile: join(dist, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external,
    sourcemap: true,
    logLevel: 'info',
  });

  // 渲染层(浏览器 IIFE)。
  await build({
    entryPoints: [join(src, 'renderer', 'renderer.ts')],
    outfile: join(dist, 'renderer', 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    sourcemap: true,
    logLevel: 'info',
  });

  // 复制静态资源。
  await copyFile(join(src, 'renderer', 'index.html'), join(dist, 'renderer', 'index.html'));
  await copyFile(join(src, 'renderer', 'styles.css'), join(dist, 'renderer', 'styles.css'));

  console.log('[desktop] 构建完成 → dist/');
}

run().catch((err) => {
  console.error('[desktop] 构建失败:', err);
  process.exit(1);
});
