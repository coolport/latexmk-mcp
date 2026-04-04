import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  handleListCitations,
  handleReadConfig,
  handleWriteConfig,
} from "../src/handlers.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "latexmk-mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe("handleWriteConfig / handleReadConfig", () => {
  test("writes a project .latexmkrc and reads it back first", async () => {
    const workingDir = await makeTempDir();

    const writeResult = await handleWriteConfig({
      working_dir: workingDir,
      engine: "xelatex",
      output_format: "pdf",
      shell_escape: true,
      extra_pdflatex_args: "-file-line-error",
      custom_rules: "$clean_ext .= ' acn';",
    });

    expect(writeResult.success).toBe(true);
    expect(writeResult.config_path).toBe(path.join(workingDir, ".latexmkrc"));
    expect(writeResult.content).toContain('$pdflatex = "xelatex %O %S"; $pdf_mode = 5;');
    expect(writeResult.content).toContain("set_tex_cmds('-shell-escape %O %S');");
    expect(writeResult.content).toContain('$pdflatex .= " -file-line-error";');

    const readResult = await handleReadConfig({ working_dir: workingDir });
    expect(readResult.configs[0]).toEqual({
      path: path.join(workingDir, ".latexmkrc"),
      content: writeResult.content,
      exists: true,
    });
  });
});

describe("handleListCitations", () => {
  test("extracts cite keys from tex_content and compares against a bib file", async () => {
    const workingDir = await makeTempDir();
    const bibPath = path.join(workingDir, "refs.bib");

    await fs.writeFile(
      bibPath,
      [
        "@article{alpha, title={Alpha}}",
        "@book{beta, title={Beta}}",
        "@misc{unused, title={Unused}}",
      ].join("\n"),
      "utf-8"
    );

    const result = await handleListCitations({
      tex_content: [
        "See \\cite{alpha}.",
        "Also \\citep[chap.~2]{beta, gamma}.",
        "And \\textcite{alpha}.",
      ].join("\n"),
      bib_path: bibPath,
      working_dir: workingDir,
    });

    expect(result.cited_keys).toEqual(["alpha", "beta", "gamma"]);
    expect(result.cited_count).toBe(3);
    expect(result.bib_entries).toEqual(["alpha", "beta", "unused"]);
    expect(result.missing_from_bib).toEqual(["gamma"]);
    expect(result.unused_in_bib).toEqual(["unused"]);
  });

  test("reads tex content from file_path when source is not provided", async () => {
    const workingDir = await makeTempDir();
    const texPath = path.join(workingDir, "main.tex");

    await fs.writeFile(
      texPath,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\autocite{delta, epsilon}",
        "\\end{document}",
      ].join("\n"),
      "utf-8"
    );

    const result = await handleListCitations({ file_path: texPath });

    expect(result.cited_keys).toEqual(["delta", "epsilon"]);
    expect(result.cited_count).toBe(2);
  });
});
