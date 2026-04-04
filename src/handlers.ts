import { execFile, spawn } from "child_process";
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
  return_pdf: z.boolean().default(false).describe("Include compiled PDF as base64 in response"),
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

export const WatchStartSchema = z.object({
  file_path: z.string().describe("Absolute path to the root .tex file to watch"),
  engine: z
    .enum(["pdflatex", "xelatex", "lualatex", "latex"])
    .default("pdflatex")
    .describe("TeX engine"),
  working_dir: z.string().optional().describe("Working directory (defaults to file's directory)"),
});

export const WatchStopSchema = z.object({
  session_id: z.string().describe("Session ID returned by latexmk_watch_start"),
});

export const WriteConfigSchema = z.object({
  working_dir: z.string().describe("Directory to write the .latexmkrc file into"),
  engine: z.enum(["pdflatex", "xelatex", "lualatex", "latex"]).optional().describe("Default TeX engine"),
  output_format: z.enum(["pdf", "dvi", "ps"]).optional().describe("Default output format"),
  shell_escape: z.boolean().optional().describe("Enable shell-escape by default"),
  extra_pdflatex_args: z.string().optional().describe("Extra arguments for pdflatex"),
  custom_rules: z.string().optional().describe("Raw Perl lines to append to the config"),
  global: z.boolean().default(false).describe("Write to ~/.latexmkrc instead of working_dir"),
});

export const ReadConfigSchema = z.object({
  working_dir: z.string().optional().describe("Project directory to read config from"),
});

export const ListCitationsSchema = z.object({
  tex_content: z.string().optional().describe("LaTeX source content"),
  file_path: z.string().optional().describe("Absolute path to an existing .tex file"),
  bib_path: z.string().optional().describe("Absolute path to a .bib file to cross-reference"),
  working_dir: z.string().optional().describe("Working directory"),
});

interface WatchSession {
  pid: number;
  workDir: string;
  jobName: string;
  startedAt: string;
}

const watchSessions = new Map<string, ReturnType<typeof spawn>>();
const watchSessionMeta = new Map<string, WatchSession>();

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

async function readTexSource(opts: { tex_content?: string; file_path?: string }) {
  if (opts.tex_content) {
    return opts.tex_content;
  }

  if (!opts.file_path) {
    throw new Error("Either tex_content or file_path must be provided.");
  }

  const content = await readFileIfExists(path.resolve(opts.file_path));
  if (!content) {
    throw new Error(`Could not read file: ${opts.file_path}`);
  }

  return content;
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
  let pdf_base64: string | null = null;

  try {
    await fs.access(outputFile);
    outputExists = true;

    if (args.return_pdf && outputExt === "pdf") {
      const pdfBuffer = await fs.readFile(outputFile);
      pdf_base64 = pdfBuffer.toString("base64");
    }
  } catch {
    // noop
  }

  return {
    success: exitCode === 0 && outputExists,
    exit_code: exitCode,
    output_file: outputExists ? outputFile : null,
    working_dir: workDir,
    page_count: parsed.page_count,
    errors: parsed.errors,
    warnings: parsed.warnings,
    missing_packages: parsed.missing_packages,
    install_hints: parsed.missing_packages.map((pkg) => `tlmgr install ${pkg}`),
    latexmk_info: parsed.info,
    stdout: stdout.slice(0, 4000),
    stderr: stderr.slice(0, 2000),
    ...(pdf_base64 ? { pdf_base64 } : {}),
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
    missing_packages: parsed.missing_packages,
    install_hints: parsed.missing_packages.map((pkg) => `tlmgr install ${pkg}`),
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

export async function handleWatchStart(rawArgs: unknown) {
  const args = WatchStartSchema.parse(rawArgs);
  const texPath = path.resolve(args.file_path);
  const jobName = path.basename(texPath, ".tex");
  const workDir = args.working_dir ?? path.dirname(texPath);

  const engineFlag = args.engine === "xelatex"
    ? "-xelatex"
    : args.engine === "lualatex"
      ? "-lualatex"
      : "-pdf";

  const lmkArgs = [
    engineFlag,
    "-pvc",
    "-interaction=nonstopmode",
    `-outdir=${workDir}`,
    `-jobname=${jobName}`,
    texPath,
  ];
  const child = spawn("latexmk", lmkArgs, {
    cwd: workDir,
    detached: false,
    stdio: "ignore",
  });

  if (!child.pid) {
    throw new Error("Failed to spawn latexmk watch process.");
  }

  const sessionId = `watch-${child.pid}-${Date.now()}`;
  watchSessions.set(sessionId, child);
  watchSessionMeta.set(sessionId, {
    pid: child.pid,
    workDir,
    jobName,
    startedAt: new Date().toISOString(),
  });

  child.on("exit", () => {
    watchSessions.delete(sessionId);
    watchSessionMeta.delete(sessionId);
  });

  return {
    session_id: sessionId,
    pid: child.pid,
    watching: texPath,
    working_dir: workDir,
    message: "latexmk is now watching for changes. Use latexmk_watch_stop to stop.",
  };
}

export async function handleWatchStop(rawArgs: unknown) {
  const args = WatchStopSchema.parse(rawArgs);
  const child = watchSessions.get(args.session_id);
  const meta = watchSessionMeta.get(args.session_id);

  if (!child || !meta) {
    throw new Error(`No active watch session found with id: ${args.session_id}`);
  }

  child.kill("SIGTERM");
  watchSessions.delete(args.session_id);
  watchSessionMeta.delete(args.session_id);

  return {
    success: true,
    session_id: args.session_id,
    pid: meta.pid,
    message: "Watch session stopped.",
  };
}

export async function handleWatchList() {
  const sessions = Array.from(watchSessionMeta.entries()).map(([session_id, meta]) => ({
    session_id,
    ...meta,
  }));

  return {
    active_sessions: sessions,
    count: sessions.length,
  };
}

export async function handleWriteConfig(rawArgs: unknown) {
  const args = WriteConfigSchema.parse(rawArgs);
  const lines: string[] = ["# .latexmkrc generated by latexmk-mcp", ""];

  if (args.output_format) {
    const formatLines: Record<"pdf" | "dvi" | "ps", string> = {
      pdf: "$pdf_mode = 1;",
      dvi: "$dvi_mode = 1;",
      ps: "$postscript_mode = 1;",
    };
    lines.push("# Output format", formatLines[args.output_format], "");
  }

  if (args.engine) {
    const engineLines: Record<"pdflatex" | "xelatex" | "lualatex" | "latex", string> = {
      pdflatex: '$pdflatex = "pdflatex %O %S";',
      xelatex: '$pdflatex = "xelatex %O %S"; $pdf_mode = 5;',
      lualatex: '$pdflatex = "lualatex %O %S";',
      latex: '$latex = "latex %O %S";',
    };
    lines.push("# Engine", engineLines[args.engine], "");
  }

  if (args.shell_escape) {
    lines.push("# Shell escape", "set_tex_cmds('-shell-escape %O %S');", "");
  }

  if (args.extra_pdflatex_args) {
    lines.push("# Extra pdflatex args", `$pdflatex .= " ${args.extra_pdflatex_args}";`, "");
  }

  if (args.custom_rules) {
    lines.push("# Custom rules", args.custom_rules, "");
  }

  const configContent = lines.join("\n");
  const targetDir = args.global ? os.homedir() : path.resolve(args.working_dir);
  const configPath = path.join(targetDir, ".latexmkrc");

  await fs.writeFile(configPath, configContent, "utf-8");

  return {
    success: true,
    config_path: configPath,
    content: configContent,
  };
}

export async function handleReadConfig(rawArgs: unknown) {
  const args = ReadConfigSchema.parse(rawArgs);
  const locations = [
    path.join(os.homedir(), ".latexmkrc"),
    path.join(os.homedir(), "latexmkrc"),
  ];

  if (args.working_dir) {
    locations.unshift(path.join(path.resolve(args.working_dir), ".latexmkrc"));
  }

  const configs = await Promise.all(
    locations.map(async (configPath) => {
      const content = await readFileIfExists(configPath);
      return {
        path: configPath,
        content: content ?? "",
        exists: content !== null,
      };
    })
  );

  return { configs };
}

export async function handleListCitations(rawArgs: unknown) {
  const args = ListCitationsSchema.parse(rawArgs);
  const texContent = await readTexSource(args);
  const citeRegex = /\\(?:cite[tp]?|autocite[tp]?|footcite|parencite|textcite)(?:\[[^\]]*\])*\{([^}]+)\}/g;
  const citedKeys = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = citeRegex.exec(texContent)) !== null) {
    const citationGroup = match[1];
    if (!citationGroup) continue;

    for (const key of citationGroup.split(",")) {
      const trimmedKey = key.trim();
      if (trimmedKey) {
        citedKeys.add(trimmedKey);
      }
    }
  }

  const result: {
    cited_keys: string[];
    cited_count: number;
    bib_entries?: string[];
    missing_from_bib?: string[];
    unused_in_bib?: string[];
  } = {
    cited_keys: [...citedKeys],
    cited_count: citedKeys.size,
  };

  if (args.bib_path) {
    const bibContent = await readFileIfExists(path.resolve(args.bib_path));
    const bibEntries: string[] = [];

    if (bibContent) {
      const bibKeyRegex = /@\w+\{([^,]+),/g;
      while ((match = bibKeyRegex.exec(bibContent)) !== null) {
        const entry = match[1]?.trim();
        if (entry) {
          bibEntries.push(entry);
        }
      }
    }

    result.bib_entries = bibEntries;
    result.missing_from_bib = result.cited_keys.filter((key) => !bibEntries.includes(key));
    result.unused_in_bib = bibEntries.filter((key) => !citedKeys.has(key));
  }

  return result;
}
