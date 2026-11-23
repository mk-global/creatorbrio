// Module hooks that let a plain Node child process (Node 20.6 or later) load
// the project's TypeScript source directly: they resolve the `@/` alias,
// extensionless imports and a package subpath without an extension (such as
// `next/server`), and compile each .ts or .mts file with the project's
// own TypeScript compiler (`transpileModule`, which only strips types).
// No bundler or extra dependency is involved.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

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
  try {
    return await next(specifier, context);
  } catch (error) {
    // A package subpath without an extension, such as next/server, which Node 20 does not resolve by itself.
    if (!/^(@[^/]+\/)?[^./@][^/]*\/[^.]+$/.test(specifier)) throw error;
    try {
      return await next(`${specifier}.js`, context);
    } catch {
      // The retry is only a guess: when it fails too, the original error is the one that says what was wrong.
      throw error;
    }
  }
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && /\.m?ts$/.test(url)) {
    const file = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf-8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, sourceMap: false },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return next(url, context);
}
