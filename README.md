# ue-codegraph-mcp

**MCP server for indexing and querying Unreal Engine C++ codebases.**

Indexes your UE project's `Source/` directory into a local SQLite database and exposes 15 MCP tools so Claude Code can answer questions about call graphs, class structure, `#include` dependencies, and Blueprint-exposed symbols — without reading raw files every time.

---

## Features

- **Call graph analysis** — find all callers of a function, trace call chains from A → B
- **Class analysis** — methods, fields, base classes, UE macros (`UCLASS`, `UPROPERTY`, `UFUNCTION`)
- **Blueprint exposure** — list all `BlueprintCallable` functions and `BlueprintReadWrite` properties
- **`#include` dependency graph** — what a file includes, and what includes it (transitive support)
- **Symbol search** — FTS5 full-text search across 40k+ symbols with prefix matching
- **Incremental indexing** — re-indexes only changed files (hash + mtime based)
- **Standalone CLI** — use `ue-graph` commands directly from the terminal without Claude

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| **Node.js** | **22 LTS** | `node --version` |
| npm | 9+ | `npm --version` |
| Claude Code | latest | `claude --version` |

> **Node.js 22 LTS is required.** Odd-numbered "Current" releases (v23, v25, etc.) are incompatible with tree-sitter's native bindings and will fail to parse files.

---

## Installation

### 1. Install Node.js 22 LTS

Download from https://nodejs.org (click the **LTS** tab) or use winget:

```powershell
winget install OpenJS.NodeJS.LTS
```

### 2. Run `setup.bat`

```powershell
cd C:\path\to\ue-codegraph-mcp
.\setup.bat
```

`setup.bat` will:
1. Verify Node.js 22 LTS
2. Install `node-gyp` globally (needed for native module builds)
3. Run `npm install` (builds tree-sitter and better-sqlite3 from source)
4. Run `npm link` to register the `ue-graph` CLI globally
5. Optionally index your project and generate `mcp.json`

> If the native build fails, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **C++ build tools** workload, then re-run `setup.bat`.

### 3. Index your project

```powershell
ue-graph index "G:\YourProject\Source" my-project
```

Output:
```
Indexing G:\YourProject\Source as "my-project" (project)...

Done!
  Files:   1784  (new: 1784, changed: 0)
  Symbols: 45623
  Macros:  3210
  Calls:   28450
  Includes: 9120
  Time: 32.5s
```

### 4. Register with Claude Code

```powershell
claude mcp add -s user ue-codegraph node "C:\path\to\ue-codegraph-mcp\build\index.js"
```

Verify with `claude mcp list`. Then start Claude Code in your project directory and run `/mcp` to confirm the server is connected.

---

## Usage in Claude Code

Once registered, Claude automatically uses the MCP tools when you ask natural-language questions:

```
"Find everything that calls SetHP"
"Trace the call chain from DamageMyPlayer to ApplyDamage"
"Analyze the UAMirLuaManager class"
"Which files include AMirCharacter.h?"
"Show all BlueprintCallable functions in UAMirAbilityComponent"
```

---

## CLI Commands

Use `ue-graph` directly from the terminal without Claude Code.

### Index management

```powershell
ue-graph index <path> [name]     # Index a codebase
ue-graph status                  # Show indexed codebases and stats
ue-graph reindex <file_path>     # Re-index a single file after changes
ue-graph delete <id|name|all>    # Remove a codebase from the index
```

### Call graph

```powershell
ue-graph callers SetHP                       # Who calls SetHP?
ue-graph callees BeginPlay                   # What does BeginPlay call?
ue-graph chain DamageMyPlayer SetHP          # Call path from A to B
```

### Class analysis

```powershell
ue-graph analyze UAMirLuaManager             # Methods, fields, UE macros
ue-graph hierarchy AAMirCharacter            # Inheritance tree (up + down)
ue-graph blueprint UAMirLuaManager           # Full Blueprint interface
```

### Search

```powershell
ue-graph search "SetHP"                      # FTS symbol search
ue-graph code "CL2LG_MY_CHARACTER_SPAWN_REQ" # Code text pattern search
ue-graph refs DamageMyPlayer                 # Where is this symbol used?
```

### UE Macros

```powershell
ue-graph macros UFUNCTION                    # All UFUNCTION macros
ue-graph macros UFUNCTION BlueprintCallable  # Filter by specifier
ue-graph deps "G:\...\MyActor.h"            # #include dependency graph
```

---

## MCP Tools Reference

| Tool | Description |
|---|---|
| `init_codebase` | Index a UE source directory |
| `get_index_status` | Show registered codebases and stats |
| `reindex_file` | Re-index a single file |
| `find_callers` | Find all callers of a function |
| `find_callees` | Find all functions called by a function |
| `find_call_chain` | Shortest call path from function A to B |
| `get_file_dependencies` | `#include` graph (includes + included-by) |
| `analyze_class` | Class methods, fields, UE macros, base classes |
| `get_class_hierarchy` | Ancestor and descendant class tree |
| `find_ue_macros` | Search UE macros by type and specifier |
| `get_macro_specifiers` | Get specifiers for a specific symbol's macro |
| `find_blueprint_exposed` | All `BlueprintCallable`/`BlueprintReadWrite` symbols |
| `get_blueprint_interface` | Full Blueprint interface of a class |
| `search_symbols` | FTS5 symbol search |
| `search_code` | Code text pattern search |
| `find_references` | Cross-reference lookup |

---

## Known Limitations

| Issue | Workaround |
|---|---|
| `analyze_class` may fail on 3000+ line headers (forward declarations) | Use Grep + Read instead |
| Parent class lookup broken when `GENERATED_BODY()` is the only inheritance hint | Use `grep 'class Foo.*public'` |
| `find_callees` can mix results when multiple classes share the same method name | Use unique function names or `find_callers` |

---

## Troubleshooting

**All files fail with `Invalid argument` during indexing**
→ Wrong Node.js version. Install Node.js 22 LTS, delete `node_modules/`, re-run `setup.bat`.

**Native build errors (`node-gyp`, `better-sqlite3`)**
→ Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload), then re-run `setup.bat`.

**MCP server not visible in Claude Code**
→ Confirm the path in `claude mcp list` is an absolute path. Restart Claude Code and run `/mcp`.

---

## License

MIT
