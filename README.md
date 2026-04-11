# latexmk-mcp

A Model Context Protocol server for latexmk that exposes LaTeX compilation, log parsing, dependency inspection, citation checking, and other utilities as MCP tools for any compatible AI agent or client.

![NPM Version](https://img.shields.io/npm/v/latexmk-mcp)
![NPM Downloads](https://img.shields.io/npm/d18m/latexmk-mcp?style=flat&color=%231082c2)
![CI](https://github.com/coolport/latexmk-mcp/actions/workflows/publish.yml/badge.svg)

## Prerequisites

- **Node.js** 18+
- **latexmk** on `$PATH` — bundled with most TeX distributions (TeX Live, MiKTeX)
- A TeX distribution with the engines and packages your project requires

```bash
# Debian/Ubuntu
sudo apt install latexmk texlive-full

# macOS
brew install --cask mactex

# Arch Linux
sudo pacman -S texlive
```

## Usage

Add this to your MCP client configuration:

```json
{
  "mcpServers": {
    "latexmk": {
      "command": "npx",
      "args": ["-y", "latexmk-mcp"]
    }
  }
}
```

The example above applies for clients such as Gemini CLI, Claude Code, etc. Additionally, some tools allow you to add MCP servers imperatively:

```bash
codex mcp add latexmk -- npx -y latexmk-mcp
```

### Global install via npm

Alternatively, you can install the package globally and invoke it directly without `npx`:

```bash
npm install -g latexmk-mcp
which latexmk-mcp  # note the absolute path
```

Then point your MCP client at the local binary using `node`:

```json
{
  "mcpServers": {
    "latexmk": {
      "command": "node",
      "args": ["/absolute/path/to/node/vX.Y.Z/bin/latexmk-mcp"]
    }
  }
}
```

## Development

```bash
bun install
bun test
bun run build
node dist/index.js
```

## Tools

### `latexmk_compile`

Full compile of a LaTeX document with configurable engine, output format, bibliography processor, and latexmk flags.

| Parameter       | Type                                         | Default    | Description                                            |
| --------------- | -------------------------------------------- | ---------- | ------------------------------------------------------ |
| `tex_content`   | string                                       | —          | Raw LaTeX source (mutually exclusive with `file_path`) |
| `file_path`     | string                                       | —          | Path to existing `.tex` file                           |
| `output_format` | `pdf\|dvi\|ps\|xdv`                          | `pdf`      | Target format                                          |
| `engine`        | `pdflatex\|xelatex\|lualatex\|latex\|pdftex` | `pdflatex` | TeX engine                                             |
| `bibtex`        | `bibtex\|biber\|none`                        | `none`     | Bibliography processor                                 |
| `shell_escape`  | boolean                                      | `false`    | Enable `--shell-escape`                                |
| `synctex`       | boolean                                      | `false`    | Generate SyncTeX data                                  |
| `extra_args`    | string[]                                     | `[]`       | Extra latexmk CLI flags                                |
| `working_dir`   | string                                       | temp dir   | Build directory                                        |
| `return_pdf`    | boolean                                      | `false`    | Return compiled PDF as base64 when building PDF output |

**Returns:** `success`, `exit_code`, `output_file`, `page_count`, structured `errors[]`, structured `warnings[]`, `missing_packages[]`, `install_hints[]`, `working_dir`, `stdout`, `stderr`, and optional `pdf_base64`.

### `latexmk_draft_compile`

Fast single-pass compile (no reruns, no bibliography) — ideal for quick syntax/error checks while editing.

| Parameter     | Type   | Default    | Description         |
| ------------- | ------ | ---------- | ------------------- |
| `tex_content` | string | —          | Raw LaTeX source    |
| `file_path`   | string | —          | Path to `.tex` file |
| `engine`      | string | `pdflatex` | TeX engine          |
| `working_dir` | string | temp dir   | Build directory     |

**Returns:** `success`, structured `errors[]`, structured `warnings[]`, `missing_packages[]`, `install_hints[]`, `stdout`, `stderr`.

### `latexmk_clean`

Remove build artifacts using `latexmk -c` (auxiliaries only) or `latexmk -C` (auxiliaries + output files).

| Parameter     | Type    | Default      | Description               |
| ------------- | ------- | ------------ | ------------------------- |
| `working_dir` | string  | **required** | Directory to clean        |
| `job_name`    | string  | —            | Clean a specific job only |
| `clean_all`   | boolean | `false`      | `-C` instead of `-c`      |

### `latexmk_check`

Detect whether `latexmk` is installed and which TeX engines are available on the system.

**Returns:** `latexmk_available`, `latexmk_version`, `latexmk_path`, `engines_available` map.

### `latexmk_list_dependencies`

List all file dependencies of a document (included `.tex` files, `.bib` files, packages, images…) via `latexmk -deps`.

| Parameter     | Type   | Description         |
| ------------- | ------ | ------------------- |
| `tex_content` | string | Raw LaTeX source    |
| `file_path`   | string | Path to `.tex` file |
| `working_dir` | string | Working directory   |

**Returns:** `dependencies[]` (deduplicated list of file paths).

### `latexmk_watch_start` / `latexmk_watch_stop` / `latexmk_watch_list`

Manage background `latexmk -pvc` watch sessions. Start returns a `session_id`; stop terminates it; list shows active sessions with PID, job name, and start time.

### `latexmk_write_config` / `latexmk_read_config`

Write or inspect `.latexmkrc` files. The write tool can set engine, output mode, shell escape, extra `pdflatex` args, and custom Perl rules.

### `latexmk_list_citations`

Extract citation keys from LaTeX source and optionally compare them to a `.bib` file.

**Returns:** `cited_keys[]`, `cited_count`, and when `bib_path` is provided, `bib_entries[]`, `missing_from_bib[]`, and `unused_in_bib[]`.

## License

MIT
