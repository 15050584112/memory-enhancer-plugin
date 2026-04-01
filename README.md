# memory-enhancer

增强 Claude Code 记忆系统：索引一致性检查、description 质量验证、检索审计日志。

**零外部依赖** — MCP Server 使用原生 Node.js 实现 JSON-RPC over stdio，无需任何 SDK。

## 安装

```bash
npm install -g memory-enhancer
```

## 配置

编辑 `~/.claude/settings.json`，添加：

```json
{
  "mcpServers": {
    "memory-enhancer": {
      "type": "stdio",
      "command": "memory-enhancer"
    }
  },
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "memory-enhancer-stop"
      }]
    }],
    "SessionEnd": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "memory-enhancer-session-end"
      }]
    }]
  }
}
```

重启 Claude Code 生效。

## 使用

### 自动运行（Stop Hook）

无需任何操作。每次 Claude 回复结束后自动：
1. 检查孤儿索引并修复
2. 检查 description 质量
3. 写入审计日志

### 主动调用

在 Claude Code 中直接说：

```
@mcp/memory-enhancer memory_index_consistency
@mcp/memory-enhancer memory_quality_check
@mcp/memory-enhancer memory_stats
@mcp/memory-enhancer memory_search:query=用户偏好
@mcp/memory-enhancer memory_backup
```

## 工具一览

| 工具 | 说明 |
|------|------|
| `memory_index_consistency` | 检查并自动修复孤儿索引 |
| `memory_quality_check` | description 质量检查 + 改进建议 |
| `memory_audit` | 写入检索审计日志 |
| `memory_search` | 关键词搜索（无 embedding） |
| `memory_stats` | 文件数、类型分布、健康度 |
| `memory_backup` | 手动触发 MEMORY.md 备份 |

## 文件结构

```
memory-enhancer/
├── manifest.json
├── package.json
├── mcpServers/
│   └── index.js      ← MCP Server（零依赖原生实现）
└── hooks/
    ├── stop-hook.js      ← Stop Hook
    └── session-end-hook.js ← SessionEnd Hook
```

## 卸载

从 `settings.json` 删除对应条目即可。
