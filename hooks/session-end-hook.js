#!/usr/bin/env node
/**
 * memory-enhancer: SessionEnd Hook
 *
 * 触发时机: 会话结束时 (SessionEnd hook)
 * 职责:
 *   1. 备份 MEMORY.md 到 .backup/ 目录
 *   2. 清理过旧的 hook_log（保留最近 1000 条）
 *
 * 使用方式: 在 ~/.claude/settings.json 中配置
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── 配置 ────────────────────────────────────────────────────────────────────

const BACKUP_DIR = '.backup';
const MAX_LOG_LINES = 1000;  // 超过此行数时截断日志
const MAX_BACKUP_COUNT = 30;   // 最多保留的备份份数

// ─── 主逻辑 ──────────────────────────────────────────────────────────────────

function main() {
  const cwd = process.env.CLAUDE_HOOK_CWD || process.cwd();
  const memoryDir = findMemoryDir(cwd);

  if (!memoryDir) {
    process.exit(0);
  }

  const indexPath = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) {
    process.exit(0);
  }

  const backupPath = path.join(memoryDir, BACKUP_DIR);

  // ── 1. 备份 MEMORY.md ──
  try {
    if (!fs.existsSync(backupPath)) {
      fs.mkdirSync(backupPath, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(backupPath, `MEMORY_${timestamp}.md`);

    fs.copyFileSync(indexPath, backupFile);
    console.log(`Memory backed up: ${path.basename(backupFile)}`);
  } catch (e) {
    console.error(`Backup failed: ${e.message}`);
  }

  // ── 2. 轮转日志 ──
  rotateLog(path.join(memoryDir, '.hook_log.jsonl'));

  // ── 3. 清理旧备份 ──
  cleanupOldBackups(backupPath);
}

// ─── 日志轮转 ────────────────────────────────────────────────────────────────

function rotateLog(logPath) {
  if (!fs.existsSync(logPath)) return;

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');

    if (lines.length <= MAX_LOG_LINES) return;

    // 保留最近 MAX_LOG_LINES 条
    const kept = lines.slice(-MAX_LOG_LINES);
    fs.writeFileSync(logPath, kept.join('\n') + '\n', 'utf-8');

    console.log(`Log rotated: ${lines.length} → ${kept.length} lines`);
  } catch (e) {
    // 忽略
  }
}

// ─── 备份清理 ────────────────────────────────────────────────────────────────

function cleanupOldBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return;

  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('MEMORY_') && f.endsWith('.md'))
      .map(f => ({
        name: f,
        path: path.join(backupDir, f),
        mtime: fs.statSync(path.join(backupDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    // 删除超出上限的旧备份
    let removed = 0;
    for (let i = MAX_BACKUP_COUNT; i < files.length; i++) {
      fs.unlinkSync(files[i].path);
      removed++;
    }

    if (removed > 0) {
      console.log(`Removed ${removed} old backups`);
    }
  } catch {
    // 忽略
  }
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function findMemoryDir(cwd) {
  // 1. 向上查找项目内的 .claude/memory
  let dir = cwd;
  const root = path.parse(dir).root;

  for (let i = 0; i < 12; i++) {
    const memDir = path.join(dir, '.claude', 'memory');
    if (fs.existsSync(memDir)) return memDir;
    const parent = path.dirname(dir);
    if (parent === dir || parent === root) break;
    dir = parent;
  }

  // 2. 查找 ~/.claude/projects/<encoded-path>/memory
  const home = process.env.HOME || '';
  const encodedPath = cwd.replace(/\//g, '-').replace(/-+$/, '');
  const projectMem = path.join(home, '.claude', 'projects', encodedPath, 'memory');
  if (fs.existsSync(projectMem)) return projectMem;

  return null;
}

main();
