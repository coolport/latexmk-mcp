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
];

// Server

const server = new Server(
  { name: "latexmk-mcp", version: "1.0.0" },
  { capabilities: { tools: {} },
    instructions: "Compile and manage LaTeX documents."
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
