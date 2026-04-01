#!/usr/bin/env node
/**
 * memory-enhancer: MCP Server
 *
 * 提供增强记忆管理的工具集，供 Claude Code 主模型调用
 *
 * 暴露工具:
 *   memory_index_consistency  — 索引一致性检查与修复
 *   memory_quality_check     — description 质量检查与改进建议
 *   memory_audit             — 检索审计日志写入
 *   memory_search            — 关键词搜索（无 embedding）
 *   memory_stats             — 记忆统计概览
 *   memory_sync              — 跨项目记忆同步（可选）
 *
 * 使用方式: 在 ~/.claude/settings.json 中配置 mcpServers
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── MCP SDK ─────────────────────────────────────────────────────────────────
//
// SDK v1.29.0 bug workaround: root export paths (./dist/cjs/index.js) are missing
// from the npm package. Use explicit subpath exports instead.
//
// npm install @modelcontextprotocol/sdk
// (local install in plugin dir, or global install)
//
const sdkRoot = () => {
  // Try local node_modules relative to this file
  const localPath = path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk');
  if (fs.existsSync(path.join(localPath, 'package.json'))) return localPath;
  // Fall back to global/parent resolution
  return '@modelcontextprotocol/sdk';
};

let Server, StdioServerTransport;
try {
  Server = require(path.join(sdkRoot(), 'dist', 'cjs', 'server', 'index.js')).Server;
  ({ StdioServerTransport } = require(path.join(sdkRoot(), 'dist', 'cjs', 'server', 'stdio.js')));
} catch (e) {
  console.error(
    'Error loading MCP SDK: ' + e.message + '\n' +
    'Install it with: npm install @modelcontextprotocol/sdk\n' +
    '(run this inside the memory-enhancer-plugin directory or globally)'
  );
  process.exit(1);
}

const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require(path.join(sdkRoot(), 'dist', 'cjs', 'types.js'));

// ─── 常量 ────────────────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'memory_index_consistency',
    description: '检查 MEMORY.md 索引与实际文件的一致性，自动修复孤儿索引。可在 Stop Hook 中自动调用。',
    inputSchema: {
      type: 'object',
      properties: {
        memoryDir: {
          type: 'string',
          description: '记忆目录路径，默认自动检测',
        },
        autoFix: {
          type: 'boolean',
          description: '是否自动修复孤儿索引（默认 true）',
          default: true,
        },
        maxAutoFix: {
          type: 'number',
          description: '最多自动修复的孤儿数量（默认 20）',
          default: 20,
        },
      },
    },
  },
  {
    name: 'memory_quality_check',
    description: '检查所有记忆文件的 description 质量（长度、格式、占位符），返回改进建议。可用于手动检查或定期审计。',
    inputSchema: {
      type: 'object',
      properties: {
        memoryDir: {
          type: 'string',
          description: '记忆目录路径，默认自动检测',
        },
        minDescriptionLength: {
          type: 'number',
          description: 'description 最小字符数（默认 15）',
          default: 15,
        },
        autoFix: {
          type: 'boolean',
          description: '是否自动修复（仅修复有明确规则的，如占位符）',
          default: false,
        },
      },
    },
  },
  {
    name: 'memory_audit',
    description: '写入检索审计日志，记录每次 Sonnet 筛选的结果，用于事后复盘和召回率分析。',
    inputSchema: {
      type: 'object',
      properties: {
        memoryDir: {
          type: 'string',
          description: '记忆目录路径',
        },
        query: {
          type: 'string',
          description: '触发检索的用户查询',
        },
        selected: {
          type: 'array',
          description: 'Sonnet 选中的记忆文件列表',
          items: { type: 'string' },
        },
        rejected: {
          type: 'array',
          description: 'Sonnet 拒绝的记忆文件及原因',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
        model: {
          type: 'string',
          description: '使用的模型名称',
          default: 'sonnet',
        },
      },
    },
  },
  {
    name: 'memory_search',
    description: '在记忆目录中执行关键词搜索（无 embedding，纯 grep + 正则匹配）。作为 Sonnet 筛选的兜底或补充。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词（支持多个，用空格或逗号分隔）',
        },
        memoryDir: {
          type: 'string',
          description: '记忆目录路径',
        },
        maxResults: {
          type: 'number',
          description: '最多返回结果数（默认 10）',
          default: 10,
        },
        fields: {
          type: 'array',
          description: '搜索哪些字段',
          items: { type: 'string' },
          default: ['name', 'description', 'tags', 'content'],
        },
      },
    },
  },
  {
    name: 'memory_stats',
    description: '返回记忆系统统计：文件总数、各类型分布、索引行数、审计日志摘要。用于了解记忆系统健康度。',
    inputSchema: {
      type: 'object',
      properties: {
        memoryDir: {
          type: 'string',
          description: '记忆目录路径',
        },
      },
    },
  },
  {
    name: 'memory_backup',
    description: '手动触发一次 MEMORY.md 备份到 .backup/ 目录。',
    inputSchema: {
      type: 'object',
      properties: {
        memoryDir: {
          type: 'string',
          description: '记忆目录路径',
        },
      },
    },
  },
];

// ─── 服务器初始化 ───────────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'memory-enhancer',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── 工具处理器 ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOL_DEFINITIONS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'memory_index_consistency':
        return memoryIndexConsistency(args);
      case 'memory_quality_check':
        return memoryQualityCheck(args);
      case 'memory_audit':
        return memoryAudit(args);
      case 'memory_search':
        return memorySearch(args);
      case 'memory_stats':
        return memoryStats(args);
      case 'memory_backup':
        return memoryBackup(args);
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
});

// ─── 工具实现 ──────────────────────────────────────────────────────────────

function resolveMemoryDir(argDir, cwd) {
  if (argDir && fs.existsSync(argDir)) return argDir;
  return findMemoryDir(cwd || process.cwd());
}

/**
 * memory_index_consistency
 */
function memoryIndexConsistency(args) {
  const { autoFix = true, maxAutoFix = 20 } = args;
  const memoryDir = resolveMemoryDir(args.memoryDir);

  if (!memoryDir) {
    return { content: [{ type: 'text', text: 'Memory directory not found.' }] };
  }

  const indexPath = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) {
    return { content: [{ type: 'text', text: 'MEMORY.md not found.' }] };
  }

  const index = fs.readFileSync(indexPath, 'utf-8');

  // 提取索引中已有的文件名
  const indexedFiles = new Set(
    [...index.matchAll(/\[.*?\]\(([^)]+\.md)\)/g)]
      .map(m => m[1])
  );

  // 扫描所有 .md 文件
  const allFiles = [];
  scanDirectory(memoryDir, allFiles);

  // 找出孤儿文件
  const orphans = allFiles.filter(f => {
    const bn = path.basename(f);
    return bn !== 'MEMORY.md' && !indexedFiles.has(bn);
  });

  let fixedCount = 0;
  const fixedFiles = [];
  const skippedFiles = [];

  if (orphans.length > 0 && autoFix) {
    const currentLines = index.split('\n').length;
    const nearLimit = currentLines > 180;

    for (const orphanPath of orphans) {
      if (fixedCount >= maxAutoFix) {
        skippedFiles.push(path.basename(orphanPath));
        continue;
      }
      if (nearLimit) {
        skippedFiles.push(path.basename(orphanPath));
        continue;
      }

      const bn = path.basename(orphanPath);
      const content = fs.readFileSync(orphanPath, 'utf-8');

      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const title = nameMatch ? nameMatch[1].trim() : bn.replace('.md', '');

      const typeMatch = content.match(/^type:\s*(.+)$/m);
      const type = typeMatch ? typeMatch[1].trim() : 'unknown';

      const indexLine = `\n- [${title}](${bn}) — auto-recovered (${type})`;
      fs.appendFileSync(indexPath, indexLine, 'utf-8');

      fixedFiles.push(bn);
      fixedCount++;
    }
  } else {
    for (const orphanPath of orphans) {
      skippedFiles.push(path.basename(orphanPath));
    }
  }

  // 写审计日志
  writeAuditEntry(memoryDir, {
    type: 'consistency_check',
    orphansFound: orphans.length,
    fixed: fixedCount,
    fixedFiles,
    skippedFiles,
    timestamp: new Date().toISOString(),
  });

  const lines = [];
  lines.push(`## 索引一致性检查结果`);
  lines.push(`- 索引中已有: ${indexedFiles.size} 个文件`);
  lines.push(`- 扫描到文件: ${allFiles.length} 个`);
  lines.push(`- 孤儿文件: ${orphans.length} 个`);

  if (fixedCount > 0) {
    lines.push(`- **已修复: ${fixedCount} 个**`);
    lines.push(`  ${fixedFiles.map(f => `- ${f}`).join('\n  ')}`);
  }
  if (skippedFiles.length > 0) {
    lines.push(`- 已跳过: ${skippedFiles.length} 个（autoFix=false 或达到上限）`);
    lines.push(`  ${skippedFiles.map(f => `- ${f}`).join('\n  ')}`);
  }
  if (orphans.length === 0) {
    lines.push(`- 状态: ✅ 一致性完好，无需修复`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * memory_quality_check
 */
function memoryQualityCheck(args) {
  const { autoFix = false, minDescriptionLength = 15 } = args;
  const memoryDir = resolveMemoryDir(args.memoryDir);

  if (!memoryDir) {
    return { content: [{ type: 'text', text: 'Memory directory not found.' }] };
  }

  const allFiles = [];
  scanDirectory(memoryDir, allFiles);

  const issues = [];
  const good = [];

  for (const file of allFiles) {
    const bn = path.basename(file);
    if (bn === 'MEMORY.md' || bn.startsWith('.')) continue;

    try {
      const content = fs.readFileSync(file, 'utf-8');
      const descMatch = content.match(/^description:\s*>\s*\n?([\s\S]*?)(?=^---|\n[a-z-]+:|$)/m);
      const descLineMatch = content.match(/^description:\s*(.+)$/m);
      const description = descMatch ? descMatch[1].trim() : (descLineMatch ? descLineMatch[1].trim() : '');

      const typeMatch = content.match(/^type:\s*(.+)$/m);
      const type = typeMatch ? typeMatch[1].trim() : null;

      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const name = nameMatch ? nameMatch[1].trim() : bn;

      const fileIssues = [];

      // 检查 description 长度
      if (description.length < minDescriptionLength) {
        fileIssues.push(`description 太短（${description.length} < ${minDescriptionLength} 字符）: "${description || '(empty)'}"`);
      }

      // 占位符检测
      const placeholders = ['TODO', 'N/A', 'TBD', 'placeholder', 'xxxx', 'xxx', 'N/A'];
      if (placeholders.some(p => description.toUpperCase().includes(p))) {
        fileIssues.push(`包含占位符: "${description}"`);
        if (autoFix) {
          // 不自动修复占位符，需要人工判断
        }
      }

      // 无 type
      if (!type) {
        fileIssues.push('缺少 type 字段（应为 user/feedback/project/reference）');
      }

      // 无 name
      if (!name || name === bn) {
        fileIssues.push('name 字段缺失或只是文件名');
      }

      if (fileIssues.length > 0) {
        issues.push({ file: bn, path: file, name, type: type || 'MISSING', issues: fileIssues });
      } else {
        good.push(bn);
      }
    } catch {
      // 忽略
    }
  }

  const lines = [];
  lines.push(`## 记忆质量检查结果`);
  lines.push(`- 检查文件: ${allFiles.length} 个（不含 MEMORY.md 和隐藏文件）`);
  lines.push(`- 合格: ${good.length} 个`);
  lines.push(`- 有问题: ${issues.length} 个`);

  if (issues.length > 0) {
    lines.push(`\n### 问题详情`);
    for (const issue of issues) {
      lines.push(`\n**${issue.file}** (${issue.type})`);
      lines.push(`  名称: ${issue.name}`);
      for (const prob of issue.issues) {
        lines.push(`  - ${prob}`);
        // 提供改进建议
        if (prob.includes('太短')) {
          lines.push(`    💡 建议: description 应描述一个完整的事实，而非短词。例如`);
          lines.push(`       ❌ BAD: "用户偏好"`);
          lines.push(`       ✅ GOOD: "this user prefers terse responses with no trailing summaries"`);
        }
        if (prob.includes('占位符')) {
          lines.push(`    💡 建议: 用一句完整的话描述记忆内容，不要留 TODO`);
        }
        if (prob.includes('type')) {
          lines.push(`    💡 建议: 添加 type 字段，如 type: feedback`);
        }
      }
    }
  }

  if (issues.length === 0) {
    lines.push(`\n✅ 所有记忆文件质量良好`);
  }

  // 写审计日志
  writeAuditEntry(memoryDir, {
    type: 'quality_check',
    total: allFiles.length,
    good: good.length,
    issues: issues.length,
    timestamp: new Date().toISOString(),
  });

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * memory_audit
 */
function memoryAudit(args) {
  const { query, selected = [], rejected = [], model = 'sonnet' } = args;
  const memoryDir = resolveMemoryDir(args.memoryDir);

  if (!memoryDir) {
    return { content: [{ type: 'text', text: 'Memory directory not found.' }] };
  }

  const entry = {
    type: 'retrieval_audit',
    timestamp: new Date().toISOString(),
    query: query || '',
    selected,
    rejected,
    model,
  };

  writeAuditEntry(memoryDir, entry);

  return {
    content: [{
      type: 'text',
      text: `Audit logged: query="${query}", selected=${selected.length}, rejected=${rejected.length}`,
    }],
  };
}

/**
 * memory_search
 */
function memorySearch(args) {
  const { query, maxResults = 10, fields = ['name', 'description', 'tags', 'content'] } = args;
  const memoryDir = resolveMemoryDir(args.memoryDir);

  if (!memoryDir) {
    return { content: [{ type: 'text', text: 'Memory directory not found.' }] };
  }
  if (!query) {
    return { content: [{ type: 'text', text: 'query is required' }], isError: true };
  }

  // 解析查询词
  const terms = query.split(/[,，\s]+/).filter(Boolean);

  const allFiles = [];
  scanDirectory(memoryDir, allFiles);

  const results = [];

  for (const file of allFiles) {
    const bn = path.basename(file);
    if (bn === 'MEMORY.md' || bn.startsWith('.')) continue;

    try {
      const content = fs.readFileSync(file, 'utf-8');
      let score = 0;
      const matchedFields = [];

      for (const term of terms) {
        const re = new RegExp(term, 'gi');

        if (fields.includes('name') && bn.match(re)) {
          score += 3; matchedFields.push('name');
        }
        if (fields.includes('description')) {
          const desc = content.match(/^description:\s*(.+)$/m)?.[1] || '';
          if (desc.match(re)) { score += 5; matchedFields.push('description'); }
        }
        if (fields.includes('tags')) {
          const tags = content.match(/^tags:\s*\[(.*?)\]/m)?.[1] || '';
          if (tags.match(re)) { score += 4; matchedFields.push('tags'); }
        }
        if (fields.includes('content')) {
          const body = content.replace(/^---[\s\S]*?---\n?/, ''); // 去掉 frontmatter
          if (body.match(re)) { score += 1; matchedFields.push('content'); }
        }
      }

      if (score > 0) {
        results.push({ file: bn, path: file, score, matchedFields, size: content.length });
      }
    } catch {
      // 忽略
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, maxResults);

  const lines = [];
  lines.push(`## 搜索结果: "${query}"`);
  lines.push(`- 找到 ${results.length} 个匹配（显示前 ${top.length} 个）`);

  if (top.length > 0) {
    lines.push('\n```');
    for (const r of top) {
      lines.push(`${'⭐'.repeat(Math.min(r.score, 5))} ${r.file}`);
      lines.push(`   匹配字段: ${r.matchedFields.join(', ')} | 大小: ${r.size} bytes`);
    }
    lines.push('```');
  } else {
    lines.push('未找到匹配结果');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * memory_stats
 */
function memoryStats(args) {
  const memoryDir = resolveMemoryDir(args.memoryDir);

  if (!memoryDir) {
    return { content: [{ type: 'text', text: 'Memory directory not found.' }] };
  }

  const allFiles = [];
  scanDirectory(memoryDir, allFiles);

  // 按类型统计
  const typeCount = {};
  const sizeTotal = { total: 0 };

  for (const file of allFiles) {
    const bn = path.basename(file);
    if (bn === 'MEMORY.md' || bn.startsWith('.')) continue;

    try {
      const content = fs.readFileSync(file, 'utf-8');
      const typeMatch = content.match(/^type:\s*(.+)$/m);
      const type = typeMatch ? typeMatch[1].trim() : 'unknown';
      typeCount[type] = (typeCount[type] || 0) + 1;
      sizeTotal.total += content.length;
    } catch {
      typeCount.unknown = (typeCount.unknown || 0) + 1;
    }
  }

  // MEMORY.md 信息
  const indexPath = path.join(memoryDir, 'MEMORY.md');
  let indexLines = 0, indexBytes = 0;
  if (fs.existsSync(indexPath)) {
    const index = fs.readFileSync(indexPath, 'utf-8');
    indexLines = index.split('\n').length;
    indexBytes = index.length;
  }

  // 审计日志摘要
  const logPath = path.join(memoryDir, '.hook_log.jsonl');
  let logLines = 0;
  if (fs.existsSync(logPath)) {
    logLines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').length;
  }

  // 备份数量
  const backupPath = path.join(memoryDir, '.backup');
  let backupCount = 0;
  if (fs.existsSync(backupPath)) {
    backupCount = fs.readdirSync(backupPath).filter(f => f.startsWith('MEMORY_')).length;
  }

  const lines = [];
  lines.push(`## 记忆系统统计`);
  lines.push('');
  lines.push(`### 文件统计`);
  lines.push(`- 总文件数: ${allFiles.filter(f => !path.basename(f).startsWith('.')).length}`);
  lines.push(`- MEMORY.md: ${indexLines} 行, ${indexBytes} bytes`);
  lines.push('');
  lines.push(`### 按类型分布`);
  for (const [type, count] of Object.entries(typeCount)) {
    const bar = '█'.repeat(count) + '░'.repeat(Math.max(0, 20 - count));
    lines.push(`  ${type.padEnd(12)} ${bar} ${count}`);
  }
  lines.push('');
  lines.push(`### 健康度`);
  lines.push(`- 审计日志: ${logLines} 条`);
  lines.push(`- MEMORY.md 截断风险: ${indexLines > 180 ? '⚠️ 接近上限（>180行）' : indexLines > 150 ? '🔶 需关注（>150行）' : '✅ 安全'}`);
  lines.push(`- 备份数: ${backupCount} 个`);
  lines.push(`- 总占用: ${(sizeTotal.total / 1024).toFixed(1)} KB`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * memory_backup
 */
function memoryBackup(args) {
  const memoryDir = resolveMemoryDir(args.memoryDir);

  if (!memoryDir) {
    return { content: [{ type: 'text', text: 'Memory directory not found.' }] };
  }

  const indexPath = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) {
    return { content: [{ type: 'text', text: 'MEMORY.md not found.' }] };
  }

  const backupDir = path.join(memoryDir, '.backup');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFile = path.join(backupDir, `MEMORY_${timestamp}.md`);

  fs.copyFileSync(indexPath, backupFile);

  // 清理超过 30 份的旧备份
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('MEMORY_'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    for (let i = 30; i < files.length; i++) {
      fs.unlinkSync(path.join(backupDir, files[i].name));
    }
  } catch {
    // 忽略清理错误
  }

  return { content: [{ type: 'text', text: `✅ MEMORY.md 已备份: ${path.basename(backupFile)}` }] };
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function findMemoryDir(cwd) {
  let dir = cwd || process.cwd();
  const root = path.parse(dir).root;

  for (let i = 0; i < 12; i++) {
    const memDir = path.join(dir, '.claude', 'memory');
    if (fs.existsSync(memDir)) return memDir;
    const parent = path.dirname(dir);
    if (parent === dir || parent === root) break;
    dir = parent;
  }

  return null;
}

function scanDirectory(dir, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(full, results);
    } else if (entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
}

function writeAuditEntry(memoryDir, entry) {
  try {
    const logPath = path.join(memoryDir, '.hook_log.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // 日志失败不影响主流程
  }
}

// ─── 启动 ───────────────────────────────────────────────────────────────────

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
