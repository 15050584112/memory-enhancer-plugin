# memory-enhancer 安装指南

## 快速安装（5 分钟）

### 前置依赖

```bash
# 安装 MCP SDK（Node.js）
npm install -g @modelcontextprotocol/sdk

# 验证
node -e "require('@modelcontextprotocol/sdk'); console.log('OK')"
```

### 方式一：Hook 方式（纯配置，无需安装 MCP Server）

编辑 `~/.claude/settings.json`，在 `hooks` 节点添加：

```json
{
  "hooks": {
    "Stop": [
      {
        "name": "memory-consistency",
        "command": "node /absolute/path/to/memory-enhancer-plugin/hooks/stop-hook.js",
        "activeForm": "Memory consistency check"
      }
    ],
    "SessionEnd": [
      {
        "name": "memory-backup",
        "command": "node /absolute/path/to/memory-enhancer-plugin/hooks/session-end-hook.js",
        "activeForm": "Memory backup"
      }
    ]
  }
}
```

重启 Claude Code 生效。

### 方式二：MCP Server 方式（推荐，可主动调用工具）

编辑 `~/.claude/settings.json`：

```json
{
  "mcpServers": {
    "memory-enhancer": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/memory-enhancer-plugin/mcpServers/index.js"]
    }
  },
  "hooks": {
    "Stop": [
      {
        "name": "memory-consistency",
        "command": "node /absolute/path/to/memory-enhancer-plugin/hooks/stop-hook.js",
        "activeForm": "Memory consistency check"
      }
    ]
  }
}
```

### 方式三：Plugin 方式（待 Claude Code 支持第三方插件安装后使用）

```bash
# 将 memory-enhancer-plugin 目录放到插件目录
cp -r memory-enhancer-plugin ~/.claude/plugins/

# 使用 Claude Code 命令安装
/plugin install memory-enhancer
```

---

## 使用方式

### 自动运行（Stop Hook）

无需任何操作。每次 Claude 回复结束后，自动：
1. 检查孤儿索引并修复
2. 检查 description 质量
3. 写入审计日志

### 主动调用（MCP Server）

在 Claude Code 中直接说：

```
@mcp/memory-enhancer memory_index_consistency
@mcp/memory-enhancer memory_quality_check
@mcp/memory-enhancer memory_stats
@mcp/memory-enhancer memory_search:query=用户偏好
@mcp/memory-enhancer memory_backup
```

或使用 `/mcp` 命令交互式调用。

---

## 工具一览

| 工具名 | 说明 |
|--------|------|
| `memory_index_consistency` | 索引一致性检查，自动修复孤儿索引 |
| `memory_quality_check` | 检查 description 质量，提供改进建议 |
| `memory_audit` | 写入检索审计日志 |
| `memory_search` | 关键词搜索（无 embedding） |
| `memory_stats` | 统计：文件数、类型分布、健康度 |
| `memory_backup` | 手动触发 MEMORY.md 备份 |

---

## 文件结构

```
memory-enhancer-plugin/
├── manifest.json              ← 插件元数据
├── README.md                 ← 本文件
├── package.json
├── hooks/
│   ├── stop-hook.js          ← Stop Hook：索引修复 + 质量检查
│   └── session-end-hook.js    ← SessionEnd Hook：备份 + 日志轮转
└── mcpServers/
    └── index.js              ← MCP Server：主动工具集
```

---

## 故障排查

### Hook 未触发

```bash
# 检查配置是否正确
cat ~/.claude/settings.json | python3 -m json.tool | grep -A5 '"hooks"'
```

### MCP Server 报错 "sdk not found"

```bash
# 全局安装
npm install -g @modelcontextprotocol/sdk

# 或本地安装
cd memory-enhancer-plugin
npm install
```

### 找不到记忆目录

Hook 会自动向上查找 `.claude/memory` 目录。如果你的记忆目录在不同路径，可以：

1. 设置 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 环境变量
2. 或在 MCP 调用时传入 `memoryDir` 参数

---

## 卸载

从 `~/.claude/settings.json` 中删除对应的 `hooks` 和 `mcpServers` 条目即可。
