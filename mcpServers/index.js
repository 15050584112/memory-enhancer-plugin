#!/usr/bin/env node
/**
 * memory-enhancer: Zero-dependency MCP Server
 *
 * MCP stdio 协议本质是 JSON-RPC over stdin/stdout，无需任何 SDK。
 * 零外部依赖，npm install 后直接可用。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ═══════════════════════════════════════════════════════════════════════════════
// MCP JSON-RPC Transport (零依赖实现)
// ═══════════════════════════════════════════════════════════════════════════════

let requestId = 0;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Definitions
// ═══════════════════════════════════════════════════════════════════════════════

const TOOLS = [
  {
    name: 'memory_index_consistency',
    description: '检查 MEMORY.md 索引与实际文件的一致性，自动修复孤儿索引',
    inputSchema: {
      type: 'object',
      properties: {
        memoryDir: { type: 'string', description: '记忆目录路径，默认自动检测' },
        autoFix: { type: 'boolean', description: '是否自动修复（默认 true）' },
        maxAutoFix: { type: 'number', description: '最多修复数量（默认 20）' },
      },
    },
  },
  {
    name: 'memory_quality_check',
    description: '检查所有记忆文件的 description 质量，返回改进建议',
    inputSchema: {
      type: 'object',
      properties: {
        memoryDir: { type: 'string', description: '记忆目录路径，默认自动检测' },
        minDescriptionLength: { type: 'number', description: 'description 最小字符数（默认 15）' },
      },
    },
  },
  {
    name: 'memory_audit',
    description: '写入检索审计日志，记录 Sonnet 筛选结果，用于复盘和召回率分析',
    inputSchema: {
      type: 'object',
      properties: {
        memoryDir: { type: 'string', description: '记忆目录路径' },
        query: { type: 'string', description: '触发检索的用户查询' },
        selected: { type: 'array', items: { type: 'string' }, description: '选中的文件列表' },
        rejected: {
          type: 'array',
          items: { type: 'object', properties: { file: { type: 'string' }, reason: { type: 'string' } } },
          description: '拒绝的文件及原因',
        },
      },
    },
  },
  {
    name: 'memory_search',
    description: '关键词搜索记忆文件（纯正则匹配，无 embedding），作为 Sonnet 筛选的兜底',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（空格或逗号分隔）' },
        memoryDir: { type: 'string', description: '记忆目录路径' },
        maxResults: { type: 'number', description: '最多返回数（默认 10）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_stats',
    description: '记忆系统统计：文件数、类型分布、索引行数、健康度',
    inputSchema: {
      type: 'object',
      properties: {
        memoryDir: { type: 'string', description: '记忆目录路径' },
      },
    },
  },
  {
    name: 'memory_backup',
    description: '手动触发 MEMORY.md 备份到 .backup/ 目录',
    inputSchema: {
      type: 'object',
      properties: {
        memoryDir: { type: 'string', description: '记忆目录路径' },
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// JSON-RPC Method Handlers
// ═══════════════════════════════════════════════════════════════════════════════

const handlers = {
  initialize() {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'memory-enhancer', version: '1.1.0' },
    };
  },

  'tools/list'() {
    return { tools: TOOLS };
  },

  'tools/call'(params) {
    const { name, arguments: args = {} } = params;
    switch (name) {
      case 'memory_index_consistency': return memoryIndexConsistency(args);
      case 'memory_quality_check': return memoryQualityCheck(args);
      case 'memory_audit': return memoryAudit(args);
      case 'memory_search': return memorySearch(args);
      case 'memory_stats': return memoryStats(args);
      case 'memory_backup': return memoryBackup(args);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Main Loop — 逐行读取 stdin，分发 JSON-RPC
// ═══════════════════════════════════════════════════════════════════════════════

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  const { id, method, params } = msg;
  if (!method) return;

  const handler = handlers[method];
  if (!handler) {
    if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
    return;
  }

  try {
    const result = handler(params);
    if (id !== undefined) reply(id, result);
  } catch (e) {
    if (id !== undefined) replyError(id, -32603, e.message);
  }
});

rl.on('close', () => process.exit(0));

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Implementations
// ═══════════════════════════════════════════════════════════════════════════════

function resolveDir(argDir) {
  if (argDir && fs.existsSync(argDir)) return argDir;
  return findMemoryDir(process.cwd());
}

function memoryIndexConsistency(args) {
  const { autoFix = true, maxAutoFix = 20 } = args;
  const memoryDir = resolveDir(args.memoryDir);
  if (!memoryDir) return err('Memory directory not found');

  const indexPath = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) return err('MEMORY.md not found');

  const index = fs.readFileSync(indexPath, 'utf-8');
  const indexed = new Set([...index.matchAll(/\[.*?\]\(([^)]+\.md)\)/g)].map(m => m[1]));

  const allFiles = []; scanDir(memoryDir, allFiles);
  const orphans = allFiles.filter(f => { const b = path.basename(f); return b !== 'MEMORY.md' && !indexed.has(b); });

  let fixed = 0; const fixedList = [], skipped = [];
  if (orphans.length > 0 && autoFix) {
    const nearLimit = index.split('\n').length > 180;
    for (const p of orphans) {
      if (fixed >= maxAutoFix || nearLimit) { skipped.push(path.basename(p)); continue; }
      const bn = path.basename(p);
      const c = fs.readFileSync(p, 'utf-8');
      const title = c.match(/^name:\s*(.+)$/m)?.[1]?.trim() || bn.replace('.md', '');
      const type = c.match(/^type:\s*(.+)$/m)?.[1]?.trim() || 'unknown';
      fs.appendFileSync(indexPath, `\n- [${title}](${bn}) — auto-recovered (${type})`);
      fixedList.push(bn); fixed++;
    }
  } else { orphans.forEach(p => skipped.push(path.basename(p))); }

  auditLog(memoryDir, { type: 'consistency_check', orphansFound: orphans.length, fixed, fixedList, skipped });

  const lines = [`## 索引一致性检查`, `- 索引中已有: ${indexed.size} 个`, `- 扫描到文件: ${allFiles.length} 个`, `- 孤儿文件: ${orphans.length} 个`];
  if (fixed > 0) lines.push(`- **已修复: ${fixed} 个**\n  ${fixedList.map(f => '- ' + f).join('\n  ')}`);
  if (skipped.length > 0) lines.push(`- 已跳过: ${skipped.length} 个`);
  if (orphans.length === 0) lines.push('- ✅ 一致性完好');
  return ok(lines.join('\n'));
}

function memoryQualityCheck(args) {
  const { minDescriptionLength = 15 } = args;
  const memoryDir = resolveDir(args.memoryDir);
  if (!memoryDir) return err('Memory directory not found');

  const allFiles = []; scanDir(memoryDir, allFiles);
  const issues = [];

  for (const file of allFiles) {
    const bn = path.basename(file);
    if (bn === 'MEMORY.md' || bn.startsWith('.')) continue;
    try {
      const c = fs.readFileSync(file, 'utf-8');
      const desc = c.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
      const type = c.match(/^type:\s*(.+)$/m)?.[1]?.trim();
      const name = c.match(/^name:\s*(.+)$/m)?.[1]?.trim();
      const probs = [];
      if (desc.length < minDescriptionLength) probs.push(`description 太短 (${desc.length} chars): "${desc || '(empty)'}"`);
      if (/^(TODO|N\/A|TBD|placeholder)$/i.test(desc)) probs.push(`占位符: "${desc}"`);
      if (!type) probs.push('缺少 type 字段');
      if (!name) probs.push('缺少 name 字段');
      if (probs.length > 0) issues.push({ file: bn, type: type || 'MISSING', name: name || bn, probs });
    } catch { /* skip */ }
  }

  auditLog(memoryDir, { type: 'quality_check', total: allFiles.length, issues: issues.length });

  const lines = [`## 记忆质量检查`, `- 检查: ${allFiles.length} 个文件`, `- 有问题: ${issues.length} 个`];
  for (const i of issues) {
    lines.push(`\n**${i.file}** (${i.type})`);
    for (const p of i.probs) lines.push(`  - ${p}`);
  }
  if (issues.length === 0) lines.push('\n✅ 所有记忆文件质量良好');
  return ok(lines.join('\n'));
}

function memoryAudit(args) {
  const { query = '', selected = [], rejected = [] } = args;
  const memoryDir = resolveDir(args.memoryDir);
  if (!memoryDir) return err('Memory directory not found');
  auditLog(memoryDir, { type: 'retrieval_audit', query, selected, rejected, timestamp: new Date().toISOString() });
  return ok(`Audit logged: query="${query}", selected=${selected.length}, rejected=${rejected.length}`);
}

function memorySearch(args) {
  const { query, maxResults = 10 } = args;
  if (!query) return err('query is required');
  const memoryDir = resolveDir(args.memoryDir);
  if (!memoryDir) return err('Memory directory not found');

  const terms = query.split(/[,，\s]+/).filter(Boolean);
  const allFiles = []; scanDir(memoryDir, allFiles);
  const results = [];

  for (const file of allFiles) {
    const bn = path.basename(file);
    if (bn === 'MEMORY.md' || bn.startsWith('.')) continue;
    try {
      const c = fs.readFileSync(file, 'utf-8');
      let score = 0;
      for (const t of terms) {
        const re = new RegExp(t, 'gi');
        if (bn.match(re)) score += 3;
        const desc = c.match(/^description:\s*(.+)$/m)?.[1] || '';
        if (desc.match(re)) score += 5;
        const tags = c.match(/^tags:\s*\[(.*?)\]/m)?.[1] || '';
        if (tags.match(re)) score += 4;
        const body = c.replace(/^---[\s\S]*?---\n?/, '');
        if (body.match(re)) score += 1;
      }
      if (score > 0) results.push({ file: bn, score });
    } catch { /* skip */ }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, maxResults);
  const lines = [`## 搜索: "${query}"`, `找到 ${results.length} 个匹配`];
  for (const r of top) lines.push(`  ${'★'.repeat(Math.min(r.score, 5))} ${r.file} (score: ${r.score})`);
  if (top.length === 0) lines.push('未找到结果');
  return ok(lines.join('\n'));
}

function memoryStats(args) {
  const memoryDir = resolveDir(args.memoryDir);
  if (!memoryDir) return err('Memory directory not found');

  const allFiles = []; scanDir(memoryDir, allFiles);
  const types = {};
  let totalSize = 0;

  for (const file of allFiles) {
    const bn = path.basename(file);
    if (bn === 'MEMORY.md' || bn.startsWith('.')) continue;
    try {
      const c = fs.readFileSync(file, 'utf-8');
      const t = c.match(/^type:\s*(.+)$/m)?.[1]?.trim() || 'unknown';
      types[t] = (types[t] || 0) + 1;
      totalSize += c.length;
    } catch { types.unknown = (types.unknown || 0) + 1; }
  }

  const indexPath = path.join(memoryDir, 'MEMORY.md');
  let indexLines = 0;
  if (fs.existsSync(indexPath)) indexLines = fs.readFileSync(indexPath, 'utf-8').split('\n').length;

  const logPath = path.join(memoryDir, '.hook_log.jsonl');
  let logLines = 0;
  if (fs.existsSync(logPath)) logLines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').length;

  const backupDir = path.join(memoryDir, '.backup');
  let backups = 0;
  if (fs.existsSync(backupDir)) backups = fs.readdirSync(backupDir).filter(f => f.startsWith('MEMORY_')).length;

  const lines = [
    '## 记忆系统统计', '',
    '### 文件', `- 总文件: ${allFiles.length}`, `- MEMORY.md: ${indexLines} 行`, '',
    '### 按类型',
  ];
  for (const [t, c] of Object.entries(types)) lines.push(`  ${t.padEnd(12)} ${'█'.repeat(Math.min(c, 20))} ${c}`);
  lines.push('', '### 健康度');
  lines.push(`- 截断风险: ${indexLines > 180 ? '⚠️ 接近上限' : indexLines > 150 ? '🔶 需关注' : '✅ 安全'}`);
  lines.push(`- 审计日志: ${logLines} 条`);
  lines.push(`- 备份: ${backups} 份`);
  lines.push(`- 总占用: ${(totalSize / 1024).toFixed(1)} KB`);
  return ok(lines.join('\n'));
}

function memoryBackup(args) {
  const memoryDir = resolveDir(args.memoryDir);
  if (!memoryDir) return err('Memory directory not found');

  const indexPath = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) return err('MEMORY.md not found');

  const backupDir = path.join(memoryDir, '.backup');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFile = path.join(backupDir, `MEMORY_${ts}.md`);
  fs.copyFileSync(indexPath, backupFile);

  // 清理旧备份
  try {
    const files = fs.readdirSync(backupDir).filter(f => f.startsWith('MEMORY_'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = 30; i < files.length; i++) fs.unlinkSync(path.join(backupDir, files[i].name));
  } catch { /* ignore */ }

  return ok(`✅ 已备份: ${path.basename(backupFile)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function ok(text) { return { content: [{ type: 'text', text }], isError: false }; }
function err(text) { return { content: [{ type: 'text', text }], isError: true }; }

function findMemoryDir(cwd) {
  // 1. 向上查找项目内的 .claude/memory
  let dir = cwd;
  const root = path.parse(dir).root;
  for (let i = 0; i < 12; i++) {
    const m = path.join(dir, '.claude', 'memory');
    if (fs.existsSync(m)) return m;
    const p = path.dirname(dir);
    if (p === dir || p === root) break;
    dir = p;
  }

  // 2. 查找 ~/.claude/projects/<encoded-path>/memory
  const home = process.env.HOME || '';
  const encodedPath = '-' + cwd.replace(/\//g, '-').replace(/-+$/, '');
  const projectMem = path.join(home, '.claude', 'projects', encodedPath, 'memory');
  if (fs.existsSync(projectMem)) return projectMem;

  return null;
}

function scanDir(dir, results) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scanDir(full, results);
    else if (e.name.endsWith('.md')) results.push(full);
  }
}

function auditLog(memoryDir, entry) {
  try {
    entry.timestamp = entry.timestamp || new Date().toISOString();
    fs.appendFileSync(path.join(memoryDir, '.hook_log.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* ignore */ }
}
