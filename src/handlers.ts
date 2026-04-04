import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { z } from "zod";
import { parseLatexLog } from "./parser.js";

const execFileAsync = promisify(execFile);

export const CompileSchema = z.object({
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

type CompileOptions = z.infer<typeof CompileSchema>;

export const CleanSchema = z.object({
  working_dir: z.string().describe("Directory containing the LaTeX build artifacts to clean"),
  job_name: z.string().optional().describe("Specific job name (base filename without extension)"),
  clean_all: z.boolean().default(false).describe("Use -C (remove output files too) instead of -c"),
});

type CleanOptions = z.infer<typeof CleanSchema>;

export const PreviewSchema = z.object({
  tex_content: z.string().optional().describe("LaTeX source content"),
  file_path: z.string().optional().describe("Absolute path to an existing .tex file"),
  engine: z
    .enum(["pdflatex", "xelatex", "lualatex", "latex"])
    .default("pdflatex")
    .describe("TeX engine"),
  working_dir: z.string().optional().describe("Working directory"),
});

type PreviewOptions = z.infer<typeof PreviewSchema>;

export const CheckSchema = z.object({
  working_dir: z.string().optional().describe("Directory to check for latexmk availability"),
});

export const ListDependenciesSchema = z.object({
  tex_content: z.string().optional().describe("LaTeX source content"),
  file_path: z.string().optional().describe("Absolute path to an existing .tex file"),
  working_dir: z.string().optional().describe("Working directory"),
});

type ListDependenciesOptions = z.infer<typeof ListDependenciesSchema>;

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

  if (opts.bibtex === "bibtex") args.push("-bibtex");
  else if (opts.bibtex === "biber") args.push("-bibtex", "-e", "$biber=q/biber/");
  else args.push("-bibtex-");

  if (opts.shellEscape) args.push("-shell-escape");
  if (opts.synctex) args.push("-synctex=1");
  if (opts.outputDir) args.push(`-outdir=${opts.outputDir}`);
  if (opts.jobName) args.push(`-jobname=${opts.jobName}`);

  return [...args, ...opts.extraArgs];
}

export async function handleCompile(rawArgs: unknown) {
  const args: CompileOptions = CompileSchema.parse(rawArgs);

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

  const outputExt = args.output_format === "dvi"
    ? "dvi"
    : args.output_format === "ps"
      ? "ps"
      : args.output_format === "xdv"
        ? "xdv"
        : "pdf";
  const outputFile = path.join(workDir, `${jobName}.${outputExt}`);
  let outputExists = false;

  try {
    await fs.access(outputFile);
    outputExists = true;
  } catch {
    // noop
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

export async function handleClean(rawArgs: unknown) {
  const args: CleanOptions = CleanSchema.parse(rawArgs);
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

export async function handleDraftCompile(rawArgs: unknown) {
  const args: PreviewOptions = PreviewSchema.parse(rawArgs);

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

export async function handleCheck(_rawArgs: unknown) {
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

export async function handleListDependencies(rawArgs: unknown) {
  const args: ListDependenciesOptions = ListDependenciesSchema.parse(rawArgs);

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

  const deps: string[] = [];
  const depRegex = /^\s{2,}(.+\.(?:tex|bib|sty|cls|clo|def|cfg|fd|enc|tfm|pfb|png|jpg|pdf|eps|svg))\s*\\?$/gim;
  let match: RegExpExecArray | null;
  while ((match = depRegex.exec(stdout)) !== null) {
    const dep = match[1];
    if (dep) {
      deps.push(dep.trim());
    }
  }

  return {
    success: exitCode === 0,
    dependencies: [...new Set(deps)],
    working_dir: workDir,
    raw_output: stdout.slice(0, 3000),
  };
}
