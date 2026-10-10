import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOOKS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "books",
);

export function fixIndentedQuotes(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inQuoteBlock = false;
  let quoteLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmedLine = line.trim();

    // Skip empty lines
    if (trimmedLine.length === 0) {
      if (inQuoteBlock) {
        // End of quote block
        if (quoteLines.length > 0) {
          result.push("> " + quoteLines.join("\n> "));
          quoteLines = [];
        }
        inQuoteBlock = false;
      }
      result.push(line);
      continue;
    }

    // Check if this line starts with 4+ spaces and contains Ukrainian text (likely a quote)
    if (line.match(/^\s{4,}/) && trimmedLine.match(/[а-яА-ЯїЇєЄґҐіІ]/)) {
      if (!inQuoteBlock) {
        inQuoteBlock = true;
        quoteLines = [];
      }
      quoteLines.push(trimmedLine);
    } else {
      if (inQuoteBlock) {
        // End of quote block
        if (quoteLines.length > 0) {
          result.push("> " + quoteLines.join("\n> "));
          quoteLines = [];
        }
        inQuoteBlock = false;
      }

      // For footnote URLs, remove indentation
      if (line.match(/^\s+\[http/) || line.match(/^\s+[^\s]+\(http/)) {
        result.push(trimmedLine);
      } else {
        result.push(line);
      }
    }
  }

  // Handle case where file ends with a quote block
  if (inQuoteBlock && quoteLines.length > 0) {
    result.push("> " + quoteLines.join("\n> "));
  }

  return result.join("\n");
}

export function processFile(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const fixedContent = fixIndentedQuotes(content);

    if (content !== fixedContent) {
      fs.writeFileSync(filePath, fixedContent, "utf8");
      console.log(`Fixed quotes in: ${filePath}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, (error as Error).message);
    return false;
  }
}

export function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  function walkDirectory(currentDir: string): void {
    const items = fs.readdirSync(currentDir);

    for (const item of items) {
      const fullPath = path.join(currentDir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walkDirectory(fullPath);
      } else if (item.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  walkDirectory(dir);
  return files;
}

export function main(): void {
  console.log("Finding all markdown files in books directory...");
  const markdownFiles = findMarkdownFiles(BOOKS_DIR);
  console.log(`Found ${markdownFiles.length} markdown files\n`);

  let fixedCount = 0;

  for (const filePath of markdownFiles) {
    if (processFile(filePath)) {
      fixedCount++;
    }
  }

  console.log(`\nFixed quotes in ${fixedCount} out of ${markdownFiles.length} files`);
}

const invokedAsMain =
  process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsMain) {
  main();
}
