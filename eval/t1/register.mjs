// Lets Node run the T1 harness's TypeScript directly (Node 22.18 or later
// strips types) while its modules import each other as the repository's
// TypeScript settings require: a relative specifier without an extension
// resolves to the `.ts` file beside it, and `@/x` (the repository's alias for
// `src/`, which the shared #224 spend modules use) resolves to `src/x.ts`.
//
//   node --import ./eval/t1/register.mjs eval/t1/run.ts ...
import * as nodeModule from "node:module";

const SRC = new URL("../../src/", import.meta.url).href;

function candidate(specifier) {
  if (specifier.startsWith("@/")) return /\.[cm]?[jt]s$/.test(specifier) ? SRC + specifier.slice(2) : `${SRC}${specifier.slice(2)}.ts`;
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/.test(specifier)) return `${specifier}.ts`;
  return null;
}

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      const alt = candidate(specifier);
      if (alt) {
        try {
          return next(alt, context);
        } catch {
          // Fall through to the default resolution.
        }
      }
      return next(specifier, context);
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
