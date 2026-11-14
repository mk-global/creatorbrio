/**
 * The real export browser's processes, as the operating system lists them, for
 * the Chromium suites that check its recovery (#198) and its sandbox (#197).
 *
 * The browser is found by parentage only: the one process this test process
 * started from `executable` without a `--type`, and everything under it. Any
 * other Chrome on the machine (the app's own, another test run's, a person's
 * browser) is never matched.
 */
import { execFileSync } from "node:child_process";

export interface Proc {
  pid: number;
  ppid: number;
  args: string;
}

/** A process in the export browser's tree, with its Chromium process type (`renderer`, `gpu-process`, ...). */
export interface BrowserChild extends Proc {
  type: string;
}

export function processes(): Proc[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
}

/** This test process's one export browser and every process under it; throws unless there is exactly one. */
export function ownExportBrowser(executable: string): { browser: Proc; children: BrowserChild[] } {
  const all = processes();
  // Children of this process that run the browser executable (the `ps` above is a child too).
  const roots = all.filter((p) => p.ppid === process.pid && p.args.includes(executable) && !p.args.includes("--type="));
  if (roots.length !== 1) throw new Error(`expected exactly one export browser launched by this test process, found ${roots.length}`);
  const tree = new Set([roots[0].pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) {
      if (tree.has(p.ppid) && !tree.has(p.pid)) {
        tree.add(p.pid);
        grew = true;
      }
    }
  }
  const children = all
    .filter((p) => p.pid !== roots[0].pid && tree.has(p.pid))
    .map((p) => ({ ...p, type: p.args.match(/--type=([\w-]+)/)?.[1] ?? "other" }));
  return { browser: roots[0], children };
}

export function alive(pid: number): boolean {
  const row = processes().find((p) => p.pid === pid);
  return row !== undefined && !/<defunct>/.test(row.args);
}
