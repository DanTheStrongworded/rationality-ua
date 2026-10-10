import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOOKS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "books",
);

export function fixIndentations(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let quoteBlock: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmedLine = line.trim();

    // Skip empty lines
    if (trimmedLine.length === 0) {
      if (quoteBlock.length > 0) {
        // End of quote block
        result.push("> " + quoteBlock.join("\n> "));
        quoteBlock = [];
      }
      result.push(line);
      continue;
    }

    // Check if this line starts with 4+ spaces
    if (line.match(/^\s{4,}/)) {
      // Remove indentation for footnote URLs
      if (trimmedLine.match(/^\[http/) || trimmedLine.match(/^\(http/)) {
        if (quoteBlock.length > 0) {
          result.push("> " + quoteBlock.join("\n> "));
          quoteBlock = [];
        }
        result.push(trimmedLine);
        continue;
      }

      // Check if this looks like a quote (starts with quote markers or contains quote content)
      if (
        trimmedLine.match(/^[\*\—«]/) ||
        trimmedLine.includes("Софі́стикат") ||
        trimmedLine.includes("Зетет") ||
        trimmedLine.includes("Праща Давида") ||
        trimmedLine.includes("гомункул") ||
        trimmedLine.includes("упере") ||
        trimmedLine.includes("баєсівський")
      ) {
        // Add to quote block
        quoteBlock.push(trimmedLine);
        continue;
      }

      // For other indented text, just remove indentation
      if (quoteBlock.length > 0) {
        result.push("> " + quoteBlock.join("\n> "));
        quoteBlock = [];
      }
      result.push(trimmedLine);
    } else {
      // Not indented
      if (quoteBlock.length > 0) {
        result.push("> " + quoteBlock.join("\n> "));
        quoteBlock = [];
      }
      result.push(line);
    }
  }

  // Handle case where file ends with a quote block
  if (quoteBlock.length > 0) {
    result.push("> " + quoteBlock.join("\n> "));
  }

  return result.join("\n");
}

export function processFile(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const fixedContent = fixIndentations(content);

    if (content !== fixedContent) {
      fs.writeFileSync(filePath, fixedContent, "utf8");
      console.log(`Fixed indentations in: ${filePath}`);
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

  console.log(`\nFixed indentations in ${fixedCount} out of ${markdownFiles.length} files`);
}

const invokedAsMain =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  main();
}
