import { expect, test, describe } from "bun:test";
import { parseLatexLog } from "../src/index.ts";

describe("parseLatexLog", () => {
  test("should identify LaTeX errors with source metadata", () => {
    const log = [
      "(./main.tex",
      "! LaTeX Error: File `missing.sty' not found.",
      " Type X to quit or <RETURN> to proceed.",
      "l.12 \\usepackage{missing}",
      ")",
    ].join("\n");
    const result = parseLatexLog(log);
    expect(result.errors).toContainEqual({
      message: "LaTeX Error: File `missing.sty' not found.",
      file: "./main.tex",
      line: 12,
      context: "Type X to quit or <RETURN> to proceed.",
    });
    expect(result.missing_packages).toEqual(["missing"]);
  });

  test("should identify Package warnings", () => {
    const log = "(./main.tex\nPackage hyperref Warning: Token not allowed in a PDF string on input line 8.\n)";
    const result = parseLatexLog(log);
    expect(result.warnings).toContainEqual({
      message: "Package hyperref Warning: Token not allowed in a PDF string on input line 8.",
      file: "./main.tex",
      line: 8,
      type: "general",
      package_name: "hyperref",
    });
  });

  test("should identify box warnings and dimensions", () => {
    const log = "(./chapter.tex\nOverfull \\hbox (5.4321pt too wide) in paragraph at lines 22--23\n)";
    const result = parseLatexLog(log);
    expect(result.warnings).toContainEqual({
      message: "Overfull \\hbox (5.4321pt too wide) in paragraph at lines 22--23",
      file: "./chapter.tex",
      line: 22,
      type: "overfull",
      dimensions: "5.4321pt too wide",
    });
  });

  test("should identify Latexmk info and page count", () => {
    const log = [
      "Latexmk: This is Latexmk, John Collins, 7 Jan. 2023. Version 4.79.",
      "Output written on main.pdf (3 pages, 12345 bytes).",
    ].join("\n");
    const result = parseLatexLog(log);
    expect(result.info).toContain("Latexmk: This is Latexmk, John Collins, 7 Jan. 2023. Version 4.79.");
    expect(result.page_count).toBe(3);
  });
});
