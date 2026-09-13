#!/usr/bin/env node
/**
 * 清理 Next.js 开发编译缓存。
 *
 * Turbopack 的 dev 缓存不会自动裁剪：热重载越频繁，.next/dev 越大，
 * 并堆积同一模块的多份哈希 chunk。陈旧 chunk 会让浏览器报
 * "No link element found for chunk ..."。
 *
 * 只删开发缓存，保留构建输出（standalone / server / static）。
 * 服务运行中拒绝执行：删除被持有的文件会导致编译错误。
 */
import { execSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.env.DEERHUX_DESIGN_PREVIEW === '1' ? '.next-design-preview' : '.next';

/** 开发缓存目录：可安全删除，重启后自动重建。 */
const targets = [
  join(projectDir, distDir, 'dev'),
  join(projectDir, distDir, 'cache', 'turbopack'),
  join(projectDir, distDir, 'cache', 'webpack'),
];

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

function dirSize(target) {
  if (!existsSync(target)) return 0;
  try {
    const output = execSync(`du -sk ${JSON.stringify(target)}`, { encoding: 'utf8' });
    return Number.parseInt(output, 10) * 1024;
  } catch {
    return 0;
  }
}

/**
 * 检测开发服务是否在运行。
 * 用端口监听判断比 lsof +D 遍历目录可靠：编译目录文件数以千计，
 * 遍历可能超时并返回误导性的「未被持有」结论。
 */
function devServerRunning() {
  const port = process.env.DEERHUX_DEV_PORT ?? '30141';
  try {
    const output = execSync(`lsof -nP -i :${port} -sTCP:LISTEN`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return output.trim().length > 0;
  } catch {
    // lsof 无匹配时以非零码退出。
    return false;
  }
}

if (devServerRunning()) {
  console.error(
    `开发服务正在运行（端口 ${process.env.DEERHUX_DEV_PORT ?? '30141'}），先停止它再清理。\n` +
      `运行中的服务持有 ${distDir} 下的文件，删除会导致编译错误。`,
  );
  process.exit(1);
}

let freed = 0;
const removed = [];
for (const target of targets) {
  const size = dirSize(target);
  if (size === 0) continue;
  rmSync(target, { recursive: true, force: true });
  freed += size;
  removed.push(`${distDir}/${target.slice(join(projectDir, distDir).length + 1)} (${humanSize(size)})`);
}

if (removed.length === 0) {
  console.log('没有需要清理的开发缓存。');
} else {
  console.log(`已清理 ${removed.length} 项，释放 ${humanSize(freed)}：`);
  for (const item of removed) console.log(`  - ${item}`);
  console.log('下次 npm run dev 会重新编译；浏览器请硬刷新（Cmd+Shift+R）。');
}

// 报告剩余体积，便于判断是否还有异常膨胀。
const total = dirSize(join(projectDir, distDir));
if (total > 0) console.log(`${distDir} 当前体积：${humanSize(total)}`);
