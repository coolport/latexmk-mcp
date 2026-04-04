# latexmk-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that exposes the [`latexmk`](https://personal.psu.edu/~jcc8/software/latexmk/) LaTeX build tool as MCP tools — letting any MCP-compatible AI assistant compile, check, clean, and inspect LaTeX documents.

---

## Prerequisites

- **Node.js** 18+
- **latexmk** installed and on `$PATH` (usually ships with TeX Live or MiKTeX)
- A TeX distribution with your required engines (`pdflatex`, `xelatex`, `lualatex`, …)

```bash
# Debian/Ubuntu
sudo apt install latexmk texlive-full

# macOS (Homebrew + MacTeX)
brew install --cask mactex

# Arch Linux
sudo pacman -S texlive-most
```

---

## Installation & Build

```bash
git clone <this-repo>
cd latexmk-mcp
npm install
npm run build          # outputs to dist/
```

---

## Running

```bash
# Direct
node dist/index.js

# Via npm
npm start

# During development (no build step)
npm run dev
```

The server communicates over **stdio** (standard MCP transport).

---

## Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "latexmk": {
      "command": "node",
      "args": ["/absolute/path/to/latexmk-mcp/dist/index.js"]
    }
  }
}
```

---

## Tools

### `latexmk_compile`
Full compile of a LaTeX document with configurable engine, output format, bibliography processor, and latexmk flags.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `tex_content` | string | — | Raw LaTeX source (mutually exclusive with `file_path`) |
| `file_path` | string | — | Path to existing `.tex` file |
| `output_format` | `pdf\|dvi\|ps\|xdv` | `pdf` | Target format |
| `engine` | `pdflatex\|xelatex\|lualatex\|latex\|pdftex` | `pdflatex` | TeX engine |
| `bibtex` | `bibtex\|biber\|none` | `none` | Bibliography processor |
| `shell_escape` | boolean | `false` | Enable `--shell-escape` |
| `synctex` | boolean | `false` | Generate SyncTeX data |
| `extra_args` | string[] | `[]` | Extra latexmk CLI flags |
| `working_dir` | string | temp dir | Build directory |
| `return_pdf` | boolean | `false` | Return compiled PDF as base64 when building PDF output |

**Returns:** `success`, `exit_code`, `output_file`, `page_count`, structured `errors[]`, structured `warnings[]`, `missing_packages[]`, `install_hints[]`, `working_dir`, `stdout`, `stderr`, and optional `pdf_base64`.

---

### `latexmk_draft_compile`
Fast single-pass compile (no reruns, no bibliography) — ideal for quick syntax/error checks while editing.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `tex_content` | string | — | Raw LaTeX source |
| `file_path` | string | — | Path to `.tex` file |
| `engine` | string | `pdflatex` | TeX engine |
| `working_dir` | string | temp dir | Build directory |

**Returns:** `success`, structured `errors[]`, structured `warnings[]`, `missing_packages[]`, `install_hints[]`, `stdout`, `stderr`.

---

### `latexmk_clean`
Remove build artifacts using `latexmk -c` (auxiliaries only) or `latexmk -C` (auxiliaries + output files).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `working_dir` | string | **required** | Directory to clean |
| `job_name` | string | — | Clean a specific job only |
| `clean_all` | boolean | `false` | `-C` instead of `-c` |

---

### `latexmk_check`
Detect whether `latexmk` is installed and which TeX engines are available on the system.

**Returns:** `latexmk_available`, `latexmk_version`, `latexmk_path`, `engines_available` map.

---

### `latexmk_list_dependencies`
List all file dependencies of a document (included `.tex` files, `.bib` files, packages, images…) via `latexmk -deps`.

| Parameter | Type | Description |
|---|---|---|
| `tex_content` | string | Raw LaTeX source |
| `file_path` | string | Path to `.tex` file |
| `working_dir` | string | Working directory |

**Returns:** `dependencies[]` (deduplicated list of file paths).

---

### `latexmk_watch_start` / `latexmk_watch_stop` / `latexmk_watch_list`
Manage background `latexmk -pvc` watch sessions. Start returns a `session_id`; stop terminates it; list shows active sessions with PID, job name, and start time.

---

### `latexmk_write_config` / `latexmk_read_config`
Write or inspect `.latexmkrc` files. The write tool can set engine, output mode, shell escape, extra `pdflatex` args, and custom Perl rules.

---

### `latexmk_list_citations`
Extract citation keys from LaTeX source and optionally compare them to a `.bib` file.

**Returns:** `cited_keys[]`, `cited_count`, and when `bib_path` is provided, `bib_entries[]`, `missing_from_bib[]`, and `unused_in_bib[]`.

---

## Development

```bash
npm run dev       # run with tsx (no build needed)
npm run build     # compile TypeScript → dist/
npm start         # run compiled output
```

---

## License

MIT
