// Resolves the project's `@/` alias and extensionless TypeScript imports so a
// plain Node child process can load source files directly. Node strips the
// types itself (--experimental-transform-types); no bundler is involved.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src");

export async function resolve(specifier, context, next) {
  let target = null;
  if (specifier.startsWith("@/")) target = path.join(SRC, specifier.slice(2));
  else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (target && !path.extname(target)) {
    for (const candidate of [`${target}.ts`, path.join(target, "index.ts")]) {
      if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
    }
  }
  return next(specifier, context);
}
