# 以下内容直接追加到 ~/.claude/settings.json
#
# 方式一：只使用 Hook（轻量，无需安装 MCP SDK）
# ──────────────────────────────────────────────────────────────
# 将以下 JSON 块合并到你的 settings.json 的顶层
#
# {
#   "hooks": {
#     "Stop": [
#       {
#         "name": "memory-consistency",
#         "command": "node /absolute/path/to/memory-enhancer-plugin/hooks/stop-hook.js",
#         "activeForm": "Memory consistency check"
#       }
#     ],
#     "SessionEnd": [
#       {
#         "name": "memory-backup",
#         "command": "node /absolute/path/to/memory-enhancer-plugin/hooks/session-end-hook.js",
#         "activeForm": "Memory backup"
#       }
#     ]
#   }
# }

# ──────────────────────────────────────────────────────────────
# 方式二：Hook + MCP Server（推荐，需要安装 MCP SDK）
# ──────────────────────────────────────────────────────────────
# npm install -g @modelcontextprotocol/sdk
#
# {
#   "mcpServers": {
#     "memory-enhancer": {
#       "type": "stdio",
#       "command": "node",
#       "args": ["/absolute/path/to/memory-enhancer-plugin/mcpServers/index.js"]
#     }
#   },
#   "hooks": {
#     "Stop": [
#       {
#         "name": "memory-consistency",
#         "command": "node /absolute/path/to/memory-enhancer-plugin/hooks/stop-hook.js",
#         "activeForm": "Memory consistency check"
#       }
#     ],
#     "SessionEnd": [
#       {
#         "name": "memory-backup",
#         "command": "node /absolute/path/to/memory-enhancer-plugin/hooks/session-end-hook.js",
#         "activeForm": "Memory backup"
#       }
#     ]
#   }
# }

# ⚠️ 注意：将插件目录放到合适位置后，将上方 JSON 中的
# /absolute/path/to/memory-enhancer-plugin
# 替换为实际路径，例如：
#   macOS:  /Users/你的用户名/.../memory-enhancer-plugin
#   Linux:  /home/你的用户名/.../memory-enhancer-plugin
#   Windows: C:\Users\你的用户名\...\memory-enhancer-plugin
