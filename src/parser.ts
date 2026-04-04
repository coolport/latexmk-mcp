export interface ParsedError {
  message: string;
  file: string | null;
  line: number | null;
  context: string | null;
}

export interface ParsedWarning {
  message: string;
  file: string | null;
  line: number | null;
  type: "overfull" | "underfull" | "general" | "missing_package";
  package_name?: string;
  dimensions?: string;
}

export interface ParsedLog {
  errors: ParsedError[];
  warnings: ParsedWarning[];
  missing_packages: string[];
  info: string[];
  page_count: number | null;
}

function maybePushOpenedFiles(rawLine: string, fileStack: string[]) {
  const fileRegex = /\((\.?[^()\s]+\.(?:tex|sty|cls|clo|def|cfg|fd))/g;
  let match: RegExpExecArray | null;

  while ((match = fileRegex.exec(rawLine)) !== null) {
    const openedFile = match[1];
    if (openedFile) {
      fileStack.push(openedFile);
    }
  }
}

export function parseLatexLog(log: string): ParsedLog {
  const lines = log.split("\n");
  const errors: ParsedError[] = [];
  const warnings: ParsedWarning[] = [];
  const missing_packages: string[] = [];
  const info: string[] = [];
  let page_count: number | null = null;
  const fileStack: string[] = [];

  const currentFile = () => fileStack.at(-1) ?? null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    if (!line) continue;

    maybePushOpenedFiles(rawLine, fileStack);

    const pageMatch = line.match(/Output written on .+? \((\d+) page/);
    const pageCount = pageMatch?.[1];
    if (pageCount) {
      page_count = Number.parseInt(pageCount, 10);
      continue;
    }

    if (/^!(?: LaTeX| Package| Class)? Error/i.test(line)) {
      const missingPkg = line.match(/File [`']([^`']+\.sty)['`] not found/i);
      const missingPackageName = missingPkg?.[1];
      if (missingPackageName) {
        missing_packages.push(missingPackageName.replace(/\.sty$/i, ""));
      }

      const ctx: string[] = [];
      let errLine: number | null = null;
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j] ?? "";
        if (!nextLine.startsWith(" ") && !nextLine.startsWith("l.")) break;

        const trimmed = nextLine.trim();
        const lineNumMatch = trimmed.match(/^l\.(\d+)/);
        const errorLineNumber = lineNumMatch?.[1];
        if (errorLineNumber) {
          errLine = Number.parseInt(errorLineNumber, 10);
        } else {
          ctx.push(trimmed);
        }
        j++;
      }

      i = j - 1;

      errors.push({
        message: line.replace(/^!\s*/, ""),
        file: currentFile(),
        line: errLine,
        context: ctx.length > 0 ? ctx.join(" ") : null,
      });
    } else if (/^(Overfull|Underfull) \\[hv]box \(([^)]+)\)/.test(line)) {
      const boxMatch = line.match(/^(Overfull|Underfull) \\[hv]box \(([^)]+)\)/);
      const lineNumMatch = line.match(/at lines? (\d+)/);
      const warningLineNumber = lineNumMatch?.[1];
      const warningType = boxMatch?.[1]?.toLowerCase();
      const dimensions = boxMatch?.[2];

      warnings.push({
        message: line,
        file: currentFile(),
        line: warningLineNumber ? Number.parseInt(warningLineNumber, 10) : null,
        type: (warningType === "underfull" ? "underfull" : "overfull"),
        dimensions,
      });
    } else if (/(?:LaTeX|Package|Class).*?Warning/i.test(line)) {
      const packageMatch = line.match(/^Package ([^\s]+) Warning/i);
      const lineNumMatch = line.match(/on input line (\d+)/);
      const inputLineNumber = lineNumMatch?.[1];
      const packageName = packageMatch?.[1];

      warnings.push({
        message: line,
        file: currentFile(),
        line: inputLineNumber ? Number.parseInt(inputLineNumber, 10) : null,
        type: "general",
        package_name: packageName,
      });
    } else if (line.startsWith("Latexmk:")) {
      info.push(line);
    }

    const opens = (rawLine.match(/\(/g) ?? []).length;
    const closes = (rawLine.match(/\)/g) ?? []).length;
    const netCloses = closes - opens;
    for (let c = 0; c < netCloses && fileStack.length > 0; c++) {
      fileStack.pop();
    }
  }

  return {
    errors,
    warnings,
    missing_packages: [...new Set(missing_packages)],
    info,
    page_count,
  };
}
