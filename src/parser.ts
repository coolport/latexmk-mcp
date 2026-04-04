export function parseLatexLog(log: string): {
  errors: string[];
  warnings: string[];
  info: string[];
} {
  const lines = log.split("\n");
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    if (/^!(?: LaTeX| Package| Class)? Error/i.test(line)) {
      const ctx = [line];
      while (i + 1 < lines.length && lines[i + 1]?.startsWith(" ")) {
        ctx.push(lines[++i]!.trim());
      }
      errors.push(ctx.join(" "));
    } else if (/(?:LaTeX|Package|Class).*?Warning/i.test(line)) {
      warnings.push(line);
    } else if (line.startsWith("Latexmk:")) {
      info.push(line);
    }
  }

  return { errors, warnings, info };
}
