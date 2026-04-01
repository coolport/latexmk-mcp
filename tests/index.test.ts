import { expect, test, describe } from "bun:test";
import { parseLatexLog } from "../src/index.ts";

describe("parseLatexLog", () => {
  test("should identify LaTeX errors", () => {
    const log = "! LaTeX Error: File `missing.sty' not found.\n Type X to quit or <RETURN> to proceed.";
    const result = parseLatexLog(log);
    expect(result.errors).toContain("! LaTeX Error: File `missing.sty' not found. Type X to quit or <RETURN> to proceed.");
  });

  test("should identify Package warnings", () => {
    const log = "Package hyperref Warning: Token not allowed in a PDF string";
    const result = parseLatexLog(log);
    expect(result.warnings).toContain("Package hyperref Warning: Token not allowed in a PDF string");
  });

  test("should identify Class warnings", () => {
    const log = "Class article Warning: Unused global option(s): [not-an-option].";
    const result = parseLatexLog(log);
    expect(result.warnings).toContain("Class article Warning: Unused global option(s): [not-an-option].");
  });

  test("should identify Latexmk info", () => {
    const log = "Latexmk: This is Latexmk, John Collins, 7 Jan. 2023. Version 4.79.";
    const result = parseLatexLog(log);
    expect(result.info).toContain("Latexmk: This is Latexmk, John Collins, 7 Jan. 2023. Version 4.79.");
  });
});
