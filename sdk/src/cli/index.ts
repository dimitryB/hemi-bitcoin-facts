/**
 * hbf: check, record and verify Bitcoin facts on Hemi.
 *
 *   hbf facts    check | record | verify | status
 *   hbf finality checkpoint | record | verify | status | watch
 *   hbf bond     create | record | status | refresh | redeem
 *
 * Exit codes: 0 success / valid, 1 invalid or failed, 2 usage error.
 */
import { redactUrls, UsageError } from "../common.js";

type Group = (argv: string[]) => Promise<number>;

const GROUPS: Record<string, () => Promise<Group>> = {
  facts: async () => (await import("./facts.js")).run,
  finality: async () => (await import("./finality.js")).run,
  bond: async () => (await import("./bond.js")).run,
};

const USAGE = `usage: hbf <facts|finality|bond> <command> [options]

  hbf facts    check | record | verify | status
  hbf finality checkpoint | record | verify | status | watch
  hbf bond     create | record | status | refresh | redeem

Run "hbf <group> --help" for a group's commands and options.`;

async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv;
  if (!group || group === "--help" || group === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return group ? 0 : 2;
  }
  const load = GROUPS[group];
  if (!load) {
    process.stderr.write(`unknown group "${group}"\n${USAGE}\n`);
    return 2;
  }
  return (await load())(rest);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Messages from viem and the vendored Esplora client can carry whole URLs: only scheme and host are printed.
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${redactUrls(error.message)}\n`);
      process.exit(2);
    }
    process.stderr.write(`error: ${redactUrls(error instanceof Error ? error.message : String(error))}\n`);
    process.exit(1);
  },
);
