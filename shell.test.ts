// shell.ts: the wrappers `bare` takes off a command, which the push ask and the no-kill gate both depend on (bun test).
// The splitter itself (parse) is exercised through claude-hooks/ask-push.test.ts, which it moved out of unchanged.
import { describe, expect, test } from "bun:test";
import { bare, parse, unredirected } from "./shell";

/** What command a line comes to once its wrappers, assignments and redirections are taken off: its words, joined. */
const command = (line: string): string => bare(unredirected(parse(line).cmds[0]!.words)).words.map((w) => w.text).join(" ");

describe("bare takes off a wrapper's own words, option values included, and leaves the command", () => {
  test("timeout: its options, the values of -s and -k, then the duration", () => {
    expect(command("timeout 5 git push")).toBe("git push");
    expect(command("timeout -v 5 git push")).toBe("git push");
    expect(command("timeout -s KILL 5 git push")).toBe("git push");
    expect(command("timeout -k 5 10 git push")).toBe("git push");
    expect(command("timeout -k 5 -s TERM 10 git push")).toBe("git push");
    expect(command("timeout --signal KILL 5 git push")).toBe("git push");
    expect(command("timeout --signal=KILL 5 git push")).toBe("git push");
    expect(command("timeout --kill-after 5 10 git push")).toBe("git push");
    expect(command("timeout --foreground 5 git push")).toBe("git push");
  });

  test("nice: -n 5, -5, --adjustment=5 and --adjustment 5", () => {
    expect(command("nice git push")).toBe("git push");
    expect(command("nice -n 5 git push")).toBe("git push");
    expect(command("nice -5 git push")).toBe("git push");
    expect(command("nice --adjustment=5 git push")).toBe("git push");
    expect(command("nice --adjustment 5 git push")).toBe("git push");
  });

  test("exec: -a takes a name", () => {
    expect(command("exec git push")).toBe("git push");
    expect(command("exec -a x git push")).toBe("git push");
    expect(command("exec -c git push")).toBe("git push");
    expect(command("command -p git push")).toBe("git push");
  });

  test("the rest still comes off", () => {
    expect(command("FOO=1 git push")).toBe("git push");
    expect(command("env -i FOO=1 git push")).toBe("git push");
    expect(command("nohup git push")).toBe("git push");
    expect(command("time -p git push")).toBe("git push");
    expect(command("stdbuf -oL git push")).toBe("git push");
    expect(command("if git push")).toBe("git push");
    expect(command("env nice -n 5 timeout -s KILL 5 git push 2>&1")).toBe("git push");
  });
});
