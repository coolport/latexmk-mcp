#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

const execFileAsync = promisify(execFile);

const CompileSchema = z.object({
  tex_content: z.string().optional().describe("LaTeX source content (if not providing file_path)"),
  file_path: z.string().optional().describe("Absolute path to an existing .tex file"),
  output_format: z
    .enum(["pdf", "dvi", "ps", "xdv"])
    .default("pdf")
    .describe("Target output format"),
  engine: z
    .enum(["pdflatex", "xelatex", "lualatex", "latex", "pdftex"])
    .default("pdflatex")
    .describe("TeX engine to use"),
  bibtex: z
    .enum(["bibtex", "biber", "none"])
    .default("none")
    .describe("Bibliography processor"),
  shell_escape: z.boolean().default(false).describe("Enable shell-escape (--shell-escape)"),
  synctex: z.boolean().default(false).describe("Generate SyncTeX data"),
  extra_args: z.array(z.string()).default([]).describe("Extra latexmk CLI arguments"),
  working_dir: z.string().optional().describe("Working directory (defaults to system temp)"),
});

const CleanSchema = z.object({
  working_dir: z.string().describe("Directory containing the LaTeX build artifacts to clean"),
  job_name: z.string().optional().describe("Specific job name (base filename without extension)"),
  clean_all: z.boolean().default(false).describe("Use -C (remove output files too) instead of -c"),
});

const PreviewSchema = z.object({
  tex_content: z.string().optional().describe("LaTeX source content"),
  file_path: z.string().optional().describe("Absolute path to an existing .tex file"),
  engine: z
    .enum(["pdflatex", "xelatex", "lualatex", "latex"])
    .default("pdflatex")
    .describe("TeX engine"),
  working_dir: z.string().optional().describe("Working directory"),
});

const CheckSchema = z.object({
  working_dir: z.string().optional().describe("Directory to check for latexmk availability"),
});

const ListDependenciesSchema = z.object({
  tex_content: z.string().optional().describe("LaTeX source content"),
  file_path: z.string().optional().describe("Absolute path to an existing .tex file"),
  working_dir: z.string().optional().describe("Working directory"),
});

// Helpers

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "latexmk-mcp-"));
}

async function writeTex(content: string, dir: string, name = "document"): Promise<string> {
  const filePath = path.join(dir, `${name}.tex`);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function buildLatexmkArgs(opts: {
  outputFormat: string;
  engine: string;
  bibtex: string;
  shellEscape: boolean;
  synctex: boolean;
  extraArgs: string[];
  jobName?: string;
  outputDir?: string;
}): string[] {
  const args: string[] = ["-interaction=nonstopmode", "-halt-on-error", "-f"];

  // Output format
  switch (opts.outputFormat) {
    case "pdf":
      args.push("-pdf");
      break;
    case "dvi":
      args.push("-dvi");
      break;
    case "ps":
      args.push("-ps");
      break;
    case "xdv":
      args.push("-xdv");
      break;
  }

  // Engine override
  switch (opts.engine) {
    case "xelatex":
      args.push("-xelatex");
      break;
    case "lualatex":
      args.push("-lualatex");
      break;
    case "pdftex":
    case "pdflatex":
      if (opts.outputFormat === "pdf") args.push("-pdflatex");
      break;
  }

  // Bibliography
  if (opts.bibtex === "bibtex") args.push("-bibtex");
  else if (opts.bibtex === "biber") args.push('-bibtex', '-e', '$biber=q/biber/');
  else args.push("-bibtex-");

  if (opts.shellEscape) args.push("-shell-escape");
  if (opts.synctex) args.push("-synctex=1");

  if (opts.outputDir) args.push(`-outdir=${opts.outputDir}`);
  if (opts.jobName) args.push(`-jobname=${opts.jobName}`);

  return [...args, ...opts.extraArgs];
}

function parseLatexLog(log: string): {
  errors: string[];
  warnings: string[];
  info: string[];
} {
  const lines = log.split("\n");
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (/^!(?: LaTeX| Package| Class)? Error/i.test(line)) {
      // Collect multi-line error context
      const ctx = [line];
      while (i + 1 < lines.length && lines[i + 1].startsWith(" ")) {
        ctx.push(lines[++i].trim());
      }
      errors.push(ctx.join(" "));
    } else if (/^(LaTeX|Package|Class) Warning/i.test(line)) {
      warnings.push(line);
    } else if (line.startsWith("Latexmk:")) {
      info.push(line);
    }
  }

  return { errors, warnings, info };
}

// Tool Handlers

async function handleCompile(rawArgs: unknown) {
  const args = CompileSchema.parse(rawArgs);

  if (!args.tex_content && !args.file_path) {
    throw new Error("Either tex_content or file_path must be provided.");
  }

  const ownDir = !args.working_dir && !args.file_path;
  const workDir = args.working_dir ?? (await createTempDir());

  let texPath: string;
  let jobName = "document";

  if (args.file_path) {
    texPath = path.resolve(args.file_path);
    jobName = path.basename(texPath, ".tex");
  } else {
    texPath = await writeTex(args.tex_content!, workDir, jobName);
  }

  const lmkArgs = buildLatexmkArgs({
    outputFormat: args.output_format,
    engine: args.engine,
    bibtex: args.bibtex,
    shellEscape: args.shell_escape,
    synctex: args.synctex,
    extraArgs: args.extra_args,
    jobName,
    outputDir: workDir,
  });

  lmkArgs.push(texPath);

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const result = await execFileAsync("latexmk", lmkArgs, {
      cwd: workDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    exitCode = e.code ?? 1;
  }

  const logFile = path.join(workDir, `${jobName}.log`);
  const logContent = (await readFileIfExists(logFile)) ?? "";
  const parsed = parseLatexLog(logContent + "\n" + stdout);

  const outputExt = args.output_format === "dvi" ? "dvi" : args.output_format === "ps" ? "ps" : args.output_format === "xdv" ? "xdv" : "pdf";
  const outputFile = path.join(workDir, `${jobName}.${outputExt}`);
  let outputExists = false;
  try {
    await fs.access(outputFile);
    outputExists = true;
  } catch { /* noop */ }

  // Clean up temp dir metadata if we created it
  if (ownDir) {
    // Leave the directory for the user to read output, surface the path
  }

  return {
    success: exitCode === 0 && outputExists,
    exit_code: exitCode,
    output_file: outputExists ? outputFile : null,
    working_dir: workDir,
    errors: parsed.errors,
    warnings: parsed.warnings,
    latexmk_info: parsed.info,
    stdout: stdout.slice(0, 4000),
    stderr: stderr.slice(0, 2000),
  };
}

async function handleClean(rawArgs: unknown) {
  const args = CleanSchema.parse(rawArgs);
  const flag = args.clean_all ? "-C" : "-c";

  const lmkArgs = [flag];
  if (args.job_name) lmkArgs.push(`-jobname=${args.job_name}`);

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const result = await execFileAsync("latexmk", lmkArgs, {
      cwd: path.resolve(args.working_dir),
      maxBuffer: 5 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    exitCode = e.code ?? 1;
  }

  return {
    success: exitCode === 0,
    exit_code: exitCode,
    clean_all: args.clean_all,
    stdout,
    stderr,
  };
}

async function handleDraftCompile(rawArgs: unknown) {
  // Fast single-pass compile to check for errors quickly (no reruns)
  const args = PreviewSchema.parse(rawArgs);

  if (!args.tex_content && !args.file_path) {
    throw new Error("Either tex_content or file_path must be provided.");
  }

  const workDir = args.working_dir ?? (await createTempDir());
  let texPath: string;
  let jobName = "document";

  if (args.file_path) {
    texPath = path.resolve(args.file_path);
    jobName = path.basename(texPath, ".tex");
  } else {
    texPath = await writeTex(args.tex_content!, workDir, jobName);
  }

  const lmkArgs = [
    "-pdf",
    "-interaction=nonstopmode",
    "-f",
    "-bibtex-",
    `-outdir=${workDir}`,
    `-jobname=${jobName}`,
    texPath,
  ];

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const result = await execFileAsync("latexmk", lmkArgs, {
      cwd: workDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    exitCode = e.code ?? 1;
  }

  const logFile = path.join(workDir, `${jobName}.log`);
  const logContent = (await readFileIfExists(logFile)) ?? "";
  const parsed = parseLatexLog(logContent + "\n" + stdout);

  return {
    success: exitCode === 0,
    exit_code: exitCode,
    working_dir: workDir,
    errors: parsed.errors,
    warnings: parsed.warnings,
    stdout: stdout.slice(0, 4000),
    stderr: stderr.slice(0, 2000),
  };
}

async function handleCheck(_rawArgs: unknown) {
  let version = "";
  let available = false;
  let path_found = "";

  try {
    const { stdout } = await execFileAsync("latexmk", ["--version"]);
    version = stdout.trim().split("\n")[0] ?? "";
    available = true;
  } catch {
    // latexmk not found
  }

  try {
    const { stdout } = await execFileAsync("which", ["latexmk"]);
    path_found = stdout.trim();
  } catch {
    // ignore
  }

  // Check for common TeX engines
  const engines: Record<string, boolean> = {};
  for (const eng of ["pdflatex", "xelatex", "lualatex", "latex"]) {
    try {
      await execFileAsync("which", [eng]);
      engines[eng] = true;
    } catch {
      engines[eng] = false;
    }
  }

  return {
    latexmk_available: available,
    latexmk_version: version,
    latexmk_path: path_found,
    engines_available: engines,
  };
}

async function handleListDependencies(rawArgs: unknown) {
  const args = ListDependenciesSchema.parse(rawArgs);

  if (!args.tex_content && !args.file_path) {
    throw new Error("Either tex_content or file_path must be provided.");
  }

  const workDir = args.working_dir ?? (await createTempDir());
  let texPath: string;
  let jobName = "document";

  if (args.file_path) {
    texPath = path.resolve(args.file_path);
    jobName = path.basename(texPath, ".tex");
  } else {
    texPath = await writeTex(args.tex_content!, workDir, jobName);
  }

  // Use -deps flag to print dependencies
  const lmkArgs = [
    "-pdf",
    "-deps",
    "-bibtex-",
    "-f",
    `-outdir=${workDir}`,
    `-jobname=${jobName}`,
    texPath,
  ];

  let stdout = "";
  let exitCode = 0;

  try {
    const result = await execFileAsync("latexmk", lmkArgs, {
      cwd: workDir,
      maxBuffer: 5 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    const e = err as { stdout?: string; code?: number };
    stdout = e.stdout ?? "";
    exitCode = e.code ?? 1;
  }

  // Parse dependencies from the output
  const deps: string[] = [];
  const depRegex = /^\s{2,}(.+\.(?:tex|bib|sty|cls|clo|def|cfg|fd|enc|tfm|pfb|png|jpg|pdf|eps|svg))\s*\\?$/gim;
  let match;
  while ((match = depRegex.exec(stdout)) !== null) {
    deps.push(match[1].trim());
  }

  return {
    success: exitCode === 0,
    dependencies: [...new Set(deps)],
    working_dir: workDir,
    raw_output: stdout.slice(0, 3000),
  };
}

// Tool Definitions

const TOOLS: Tool[] = [
  {
    name: "latexmk_compile",
    description:
      "Compile a LaTeX document using latexmk. Accepts raw LaTeX source or a path to an existing .tex file. Returns compile success/failure, errors, warnings, and the path to the output file.",
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
];

// Server

const server = new Server(
  { name: "latexmk-mcp", version: "1.0.0" },
  { capabilities: { tools: {} },
    instructions: "Compile, clean, and inspect LaTeX documents using latexmk."
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
  console.error("latexmk MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
