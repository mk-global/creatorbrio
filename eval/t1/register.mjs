// Lets Node run the T1 harness's TypeScript directly (Node 22.18 or later
// strips types) while its modules import each other without a file
// extension, as the repository's TypeScript settings require: a relative
// specifier without an extension resolves to the `.ts` file beside it.
//
//   node --import ./eval/t1/register.mjs eval/t1/run.ts ...
import * as nodeModule from "node:module";

const isBare = (specifier) => (specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/.test(specifier);

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (isBare(specifier)) {
        try {
          return next(`${specifier}.ts`, context);
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
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s$/.test(specifier)) {
    try {
      return await next(specifier + ".ts", context);
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
