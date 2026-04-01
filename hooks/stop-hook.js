#!/usr/bin/env node
/**
 * memory-enhancer: Stop Hook
 *
 * 触发时机: 每轮 Claude 回复结束时 (Stop hook)
 * 职责:
 *   1. 检查孤儿索引 — 有 .md 文件但不在 MEMORY.md 中 → 自动补全
 *   2. 写入一致性审计日志
 *   3. 基础 description 质量检查（仅记录，不自动修复）
 *
 * 使用方式: 在 ~/.claude/settings.json 中配置
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── 配置 ────────────────────────────────────────────────────────────────────

const MAX_ORPHANS_AUTO_FIX = 10;  // 超过此数量不再自动修复，避免误操作
const LOG_FILE = '.hook_log.jsonl';
const QUALITY_THRESHOLD = 15;     // description 少于 15 字符标记为"可疑"

// ─── 主逻辑 ──────────────────────────────────────────────────────────────────

function main() {
  // 从环境变量获取 cwd（Claude Code Stop hook 会注入 HOOK_CWD）
  const cwd = process.env.CLAUDE_HOOK_CWD || process.cwd();
  const memoryDir = findMemoryDir(cwd);

  if (!memoryDir) {
    // 未找到记忆目录，正常退出
    process.exit(0);
  }

  const indexPath = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) {
    process.exit(0);
  }

  // ── 1. 一致性检查 ──
  const result = checkIndexConsistency(memoryDir, indexPath);

  // ── 2. 质量检查（只记录，不修复）──
  const qualityIssues = checkDescriptionQuality(memoryDir);

  // ── 3. 写审计日志 ──
  writeAuditLog(memoryDir, {
    orphansFound: result.orphans.length,
    orphansFixed: result.fixedCount,
    skippedOrphans: result.skipped,
    qualityIssues: qualityIssues.length,
    timestamp: new Date().toISOString(),
    cwd,
  });

  // 输出人类可读摘要（Claude Code 会显示在 activeForm 中）
  if (result.fixedCount > 0) {
    console.log(`Fixed ${result.fixedCount} orphan memory entries`);
  }
  if (qualityIssues.length > 0) {
    console.log(`Found ${qualityIssues.length} low-quality descriptions`);
  }
  if (result.fixedCount === 0 && qualityIssues.length === 0) {
    console.log('Memory consistency OK');
  }
}

// ─── 一致性检查 ───────────────────────────────────────────────────────────────

/**
 * 检查 MEMORY.md 索引与实际文件的一致性
 * 1. 从 MEMORY.md 中提取所有 [title](filename.md) 指针
 * 2. 扫描 memoryDir 下所有 .md 文件
 * 3. 找出孤儿文件（文件存在但索引中没有）
 * 4. 自动补全孤儿索引（上限 MAX_ORPHANS_AUTO_FIX）
 */
function checkIndexConsistency(memoryDir, indexPath) {
  const index = fs.readFileSync(indexPath, 'utf-8');

  // 从 MEMORY.md 提取所有索引指针（格式: - [Title](filename.md) — description）
  const indexedFiles = new Set(
    [...index.matchAll(/\[.*?\]\(([^)]+\.md)\)/g)]
      .map(m => m[1])
  );

  // 扫描所有 .md 文件（递归，排除 MEMORY.md）
  const allFiles = [];
  scanDirectory(memoryDir, allFiles);

  const orphans = allFiles.filter(f => {
    const bn = path.basename(f);
    return bn !== 'MEMORY.md' && !indexedFiles.has(bn);
  });

  let fixedCount = 0;
  let skipped = 0;

  if (orphans.length > 0) {
    // 读取当前 MEMORY.md 行数
    const currentLines = index.split('\n').length;

    // 如果索引已接近上限，不再添加（防止超过 200 行截断）
    const nearLimit = currentLines > 180;

    for (const orphanPath of orphans) {
      const bn = path.basename(orphanPath);

      if (fixedCount >= MAX_ORPHANS_AUTO_FIX) {
        skipped = orphans.length - fixedCount;
        break;
      }

      if (nearLimit) {
        skipped = orphans.length - fixedCount;
        break;
      }

      const content = fs.readFileSync(orphanPath, 'utf-8');

      // 从 frontmatter 提取 name 字段作为标题
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const title = nameMatch
        ? nameMatch[1].trim()
        : bn.replace('.md', '');

      // 从 frontmatter 提取 type 字段
      const typeMatch = content.match(/^type:\s*(.+)$/m);
      const type = typeMatch ? typeMatch[1].trim() : 'unknown';

      // 构建索引行
      const indexLine = `\n- [${title}](${bn}) — auto-recovered (${type})`;

      fs.appendFileSync(indexPath, indexLine, 'utf-8');
      fixedCount++;
    }
  }

  return { orphans, fixedCount, skipped };
}

// ─── 质量检查 ────────────────────────────────────────────────────────────────

/**
 * 检查所有记忆文件的 description 质量
 * 仅记录问题，不自动修复
 */
function checkDescriptionQuality(memoryDir) {
  const allFiles = [];
  scanDirectory(memoryDir, allFiles);

  const issues = [];

  for (const file of allFiles) {
    const bn = path.basename(file);
    if (bn === 'MEMORY.md' || bn === LOG_FILE || bn.startsWith('.')) {
      continue;
    }

    try {
      const content = fs.readFileSync(file, 'utf-8');

      // 提取 description
      const descMatch = content.match(/^description:\s*(.+)$/m);
      const description = descMatch ? descMatch[1].trim() : '';

      // 提取 type
      const typeMatch = content.match(/^type:\s*(.+)$/m);
      const type = typeMatch ? typeMatch[1].trim() : null;

      // 检查项
      const fileIssues = [];

      if (description.length < QUALITY_THRESHOLD) {
        fileIssues.push(`description too short (${description.length} chars): "${description}"`);
      }

      // 占位符检测
      if (/^(TODO|N\/A|TBD|placeholder|xxxx|xxx)$/i.test(description)) {
        fileIssues.push(`placeholder description: "${description}"`);
      }

      // 无 type
      if (!type) {
        fileIssues.push('missing type field');
      }

      if (fileIssues.length > 0) {
        issues.push({
          file: bn,
          path: file,
          issues: fileIssues,
        });
      }
    } catch {
      // 忽略读取失败的文件
    }
  }

  return issues;
}

// ─── 审计日志 ──────────────────────────────────────────────────────────────

function writeAuditLog(memoryDir, data) {
  const logPath = path.join(memoryDir, LOG_FILE);
  const entry = JSON.stringify(data);

  try {
    fs.appendFileSync(logPath, entry + '\n', 'utf-8');
  } catch {
    // 日志写入失败不影响主流程
  }
}

// ─── 工具函数 ──────────────────────────────────────────────���─────────────────

/**
 * 向上查找最近的 .claude/memory 目录
 */
function findMemoryDir(cwd) {
  let dir = cwd;
  const root = path.parse(dir).root;

  for (let i = 0; i < 12; i++) {
    const memDir = path.join(dir, '.claude', 'memory');
    if (fs.existsSync(memDir)) {
      return memDir;
    }
    const parent = path.dirname(dir);
    if (parent === dir || parent === root) break;
    dir = parent;
  }

  // 备用：直接查 HOME 下的标准路径
  const homeMem = path.join(
    process.env.HOME || '',
    '.claude',
    'projects',
    sanitizeGitRoot(cwd),
    'memory'
  );
  if (fs.existsSync(homeMem)) return homeMem;

  return null;
}

/**
 * 简化版 git root 检测（用于标准记忆路径）
 */
function sanitizeGitRoot(cwd) {
  let dir = cwd;
  const root = path.parse(dir).root;

  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir
        .replace(/[^a-zA-Z0-9_\-.+]/g, '_')
        .replace(/^_+/, '')
        .replace(/_+$/, '');
    }
    const parent = path.dirname(dir);
    if (parent === dir || parent === root) break;
    dir = parent;
  }

  return cwd.replace(/[^a-zA-Z0-9_\-.+]/g, '_').replace(/_+$/, '');
}

/**
 * 递归扫描目录，收集所有 .md 文件路径
 */
function scanDirectory(dir, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // 跳过隐藏文件/目录

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      scanDirectory(full, results);
    } else if (entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

main();
