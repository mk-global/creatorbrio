// Lets Node run the T1 harness's TypeScript directly (Node 22.18 or later
// strips types) while its modules import each other as the repository's
// TypeScript settings require: a relative specifier without an extension
// resolves to the `.ts` file beside it, and `@/x` (the repository's alias for
// `src/`, which the shared #224 spend modules use) resolves to `src/x.ts`.
// Only when the first resolution fails, `@/x` and a relative path also try
// `x/index.ts`, and a package subpath without an extension (such as Next's
// `next/server`, which the app's route handlers import, #237) tries `.js`.
//
//   node --import ./eval/t1/register.mjs eval/t1/run.ts ...
import * as nodeModule from "node:module";

const SRC = new URL("../../src/", import.meta.url).href;

function candidates(specifier) {
  const plain = !/\.[cm]?[jt]s$/.test(specifier);
  if (specifier.startsWith("@/")) {
    const rest = specifier.slice(2);
    return plain ? [`${SRC}${rest}.ts`, `${SRC}${rest}/index.ts`] : [SRC + rest];
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && plain) return [`${specifier}.ts`, `${specifier}/index.ts`];
  return [];
}

/** A package subpath without an extension, tried with `.js` only after the default resolution fails. */
const packageSubpath = (specifier) =>
  /^(@[^/]+\/)?[^./@][^/]*\/[^.]+$/.test(specifier) && !specifier.startsWith("@/") && !specifier.startsWith("node:") ? `${specifier}.js` : null;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      for (const alt of candidates(specifier)) {
        try {
          return next(alt, context);
        } catch {
          // Try the next candidate, then the default resolution.
        }
      }
      try {
        return next(specifier, context);
      } catch (error) {
        const alt = packageSubpath(specifier);
        if (!alt) throw error;
        return next(alt, context);
      }
    },
  });
} else {
  nodeModule.register(
    "data:text/javascript," +
      encodeURIComponent(`
const SRC = ${JSON.stringify(SRC)};
function candidate(specifier) {
  if (specifier.startsWith("@/")) return /\\.[cm]?[jt]s$/.test(specifier) ? SRC + specifier.slice(2) : SRC + specifier.slice(2) + ".ts";
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s$/.test(specifier)) return specifier + ".ts";
  return null;
}
export async function resolve(specifier, context, next) {
  const alt = candidate(specifier);
  if (alt) {
    try {
      return await next(alt, context);
    } catch {
      // Fall through to the default resolution.
    }
  }
  return next(specifier, context);
}
`),
    import.meta.url,
  );
}
