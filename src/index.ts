#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  handleCheck,
  handleClean,
  handleCompile,
  handleDraftCompile,
  handleListCitations,
  handleListDependencies,
  handleReadConfig,
  handleWatchList,
  handleWatchStart,
  handleWatchStop,
  handleWriteConfig,
} from "./handlers.js";

// Tool Definitions

const TOOLS: Tool[] = [
  {
    name: "latexmk_compile",
    description:
      "Compile a LaTeX document using latexmk. Accepts raw LaTeX source or a path to an existing .tex file. Returns structured errors, warnings, missing package hints, page count, and the output file path.",
    inputSchema: {
      type: "object",
      properties: {
        tex_content: {
          type: "string",
          description: "LaTeX source content (mutually exclusive with file_path)",
        },
        file_path: {
          type: "string",
          description: "Absolute path to an existing .tex file (mutually exclusive with tex_content)",
        },
        output_format: {
          type: "string",
          enum: ["pdf", "dvi", "ps", "xdv"],
          default: "pdf",
          description: "Target output format",
        },
        engine: {
          type: "string",
          enum: ["pdflatex", "xelatex", "lualatex", "latex", "pdftex"],
          default: "pdflatex",
          description: "TeX engine to use",
        },
        bibtex: {
          type: "string",
          enum: ["bibtex", "biber", "none"],
          default: "none",
          description: "Bibliography processor",
        },
        shell_escape: {
          type: "boolean",
          default: false,
          description: "Enable --shell-escape",
        },
        synctex: {
          type: "boolean",
          default: false,
          description: "Generate SyncTeX data",
        },
        extra_args: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "Extra latexmk CLI arguments to pass through",
        },
        working_dir: {
          type: "string",
          description: "Working directory. Defaults to a fresh temp directory.",
        },
        return_pdf: {
          type: "boolean",
          default: false,
          description: "Include the compiled PDF as base64 in the response when output_format is pdf.",
        },
      },
      oneOf: [{ required: ["tex_content"] }, { required: ["file_path"] }],
    },
  },
  {
    name: "latexmk_draft_compile",
    description:
      "Run a fast single-pass draft compile to quickly surface errors without running multiple passes or bibliography. Good for syntax/error checking during editing.",
    inputSchema: {
      type: "object",
      properties: {
        tex_content: {
          type: "string",
          description: "LaTeX source content",
        },
        file_path: {
          type: "string",
          description: "Absolute path to an existing .tex file",
        },
        engine: {
          type: "string",
          enum: ["pdflatex", "xelatex", "lualatex", "latex"],
          default: "pdflatex",
        },
        working_dir: {
          type: "string",
          description: "Working directory",
        },
      },
      oneOf: [{ required: ["tex_content"] }, { required: ["file_path"] }],
    },
  },
  {
    name: "latexmk_clean",
    description:
      "Clean LaTeX build artifacts in a directory using `latexmk -c` (auxiliary files only) or `latexmk -C` (auxiliary + output files).",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: {
          type: "string",
          description: "Directory containing the LaTeX build artifacts",
        },
        job_name: {
          type: "string",
          description: "Specific job name (base filename without extension). Cleans all if omitted.",
        },
        clean_all: {
          type: "boolean",
          default: false,
          description: "If true, uses -C to also remove output files (PDF/DVI/PS). If false, uses -c for auxiliary files only.",
        },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "latexmk_check",
    description:
      "Check whether latexmk is installed and which TeX engines are available on this system.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: {
          type: "string",
          description: "Optional working directory (not required for this check)",
        },
      },
    },
  },
  {
    name: "latexmk_list_dependencies",
    description:
      "List all file dependencies of a LaTeX document (included .tex files, .bib files, packages, images, etc.) using `latexmk -deps`.",
    inputSchema: {
      type: "object",
      properties: {
        tex_content: {
          type: "string",
          description: "LaTeX source content",
        },
        file_path: {
          type: "string",
          description: "Absolute path to an existing .tex file",
        },
        working_dir: {
          type: "string",
          description: "Working directory",
        },
      },
      oneOf: [{ required: ["tex_content"] }, { required: ["file_path"] }],
    },
  },
  {
    name: "latexmk_watch_start",
    description:
      "Start a background latexmk watch process (-pvc) that recompiles automatically on file changes. Returns a session_id.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute path to the root .tex file to watch",
        },
        engine: {
          type: "string",
          enum: ["pdflatex", "xelatex", "lualatex", "latex"],
          default: "pdflatex",
        },
        working_dir: {
          type: "string",
          description: "Working directory. Defaults to the source file directory.",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "latexmk_watch_stop",
    description: "Stop a running latexmk watch session by session_id.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID returned by latexmk_watch_start.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "latexmk_watch_list",
    description: "List all currently active latexmk watch sessions.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "latexmk_write_config",
    description: "Write a .latexmkrc config file to a project directory or globally to ~/.latexmkrc.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: {
          type: "string",
          description: "Directory to write the project-level .latexmkrc into.",
        },
        engine: {
          type: "string",
          enum: ["pdflatex", "xelatex", "lualatex", "latex"],
        },
        output_format: {
          type: "string",
          enum: ["pdf", "dvi", "ps"],
        },
        shell_escape: {
          type: "boolean",
        },
        extra_pdflatex_args: {
          type: "string",
          description: "Extra arguments to append to the pdflatex command.",
        },
        custom_rules: {
          type: "string",
          description: "Raw Perl lines to append to the generated config.",
        },
        global: {
          type: "boolean",
          default: false,
          description: "Write to ~/.latexmkrc instead of the project directory.",
        },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "latexmk_read_config",
    description: "Read the active .latexmkrc config files from the project and home directory.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: {
          type: "string",
          description: "Optional project directory to check first.",
        },
      },
    },
  },
  {
    name: "latexmk_list_citations",
    description:
      "Extract all citation keys from a LaTeX document and optionally cross-reference them against a .bib file.",
    inputSchema: {
      type: "object",
      properties: {
        tex_content: {
          type: "string",
          description: "LaTeX source content",
        },
        file_path: {
          type: "string",
          description: "Absolute path to an existing .tex file",
        },
        bib_path: {
          type: "string",
          description: "Absolute path to a .bib file to cross-reference.",
        },
        working_dir: {
          type: "string",
          description: "Optional working directory for symmetry with other tools.",
        },
      },
      oneOf: [{ required: ["tex_content"] }, { required: ["file_path"] }],
    },
  },
];

// Server

const server = new Server(
  { name: "latexmk-mcp", version: "2.0.2" },
  { capabilities: { tools: {} },
    instructions: "Compile, clean, watch, and inspect LaTeX documents using latexmk."
  }

);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;
    switch (name) {
      case "latexmk_compile":
        result = await handleCompile(args);
        break;
      case "latexmk_draft_compile":
        result = await handleDraftCompile(args);
        break;
      case "latexmk_clean":
        result = await handleClean(args);
        break;
      case "latexmk_check":
        result = await handleCheck(args);
        break;
      case "latexmk_list_dependencies":
        result = await handleListDependencies(args);
        break;
      case "latexmk_watch_start":
        result = await handleWatchStart(args);
        break;
      case "latexmk_watch_stop":
        result = await handleWatchStop(args);
        break;
      case "latexmk_watch_list":
        result = await handleWatchList();
        break;
      case "latexmk_write_config":
        result = await handleWriteConfig(args);
        break;
      case "latexmk_read_config":
        result = await handleReadConfig(args);
        break;
      case "latexmk_list_citations":
        result = await handleListCitations(args);
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Entry

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("latexmk MCP server v2.0.2 running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
