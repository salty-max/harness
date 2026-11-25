// nokill.ts: what a helper's Bash may not run (a kill, a signal, a stop of a server), and the reads it must still allow
// (bun test). The hook itself is spawned with the JSON Claude Code sends, for its exit codes.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { kills, literalPids, ownVars, refusal, refusalText } from "./nokill";

const refused: [string, string][] = [
  // the incident, and the plain forms
  ["pkill -f scripts/serve.mjs", "pkill"],
  ["kill 1234", "kill"],
  ["kill -9 1234", "kill"],
  ["kill -0 999999", "kill"],
  ["killall node", "killall"],
  ["killall5 -9", "killall5"],
  ["/bin/kill 12", "kill"],
  ["/usr/bin/pkill vite", "pkill"],
  ["\\kill 12", "kill"],
  ["'pkill' vite", "pkill"],
  ['"kill" 12', "kill"],
  ["k''ill 12", "kill"],
  ["kill %1", "kill"],
  ["fuser -k 3000/tcp", "fuser -k"],
  ["fuser -kn tcp 3000", "fuser -k"],
  ["fuser --kill 3000/tcp", "fuser -k"],
  ["kill-port 3000", "kill-port"],
  ["npx kill-port 3000", "npx kill-port"],
  ["npx -y kill-port 3000", "npx kill-port"],
  ["bunx kill-port 3000", "bunx kill-port"],
  ["pnpx kill-port 3000", "pnpx kill-port"],
  ["bun x kill-port 3000", "bun x kill-port"],
  ["npm exec -- kill-port 3000", "npm exec kill-port"],
  ["pnpm dlx kill-port 3000", "pnpm dlx kill-port"],
  ["yarn dlx kill-port 3000", "yarn dlx kill-port"],
  // after a pipe or a list
  ["lsof -ti:3000 | xargs kill", "xargs kill"],
  ["lsof -ti :3000 | xargs kill -9", "xargs kill"],
  ["lsof -ti:3000 | xargs -r kill -9", "xargs kill"],
  ["pgrep -f vite | xargs -n 1 kill", "xargs kill"],
  ["pgrep -f vite | xargs -n1 kill", "xargs kill"],
  ["pgrep -f vite | xargs -I {} kill {}", "xargs kill"],
  ["pgrep -f vite | xargs -I{} kill {}", "xargs kill"],
  ["ps aux | grep vite | awk '{print $2}' | xargs kill -9", "xargs kill"],
  ["echo ok && pkill vite", "pkill"],
  ["echo ok; pkill vite", "pkill"],
  ["false || pkill vite", "pkill"],
  ["pkill vite &", "pkill"],
  ["echo a\npkill vite", "pkill"],
  ["if true; then pkill vite; fi", "pkill"],
  ["while true; do kill 1; done", "kill"],
  ["for p in 1 2; do kill $p; done", "kill"],
  ["! pkill vite", "pkill"],
  // substitutions and nested shells
  ["kill $(pgrep -f vite)", "kill"],
  ["kill `pgrep -f vite`", "kill"],
  ["echo $(pkill vite)", "pkill"],
  ['echo "$(pkill vite)"', "pkill"],
  ['echo "`kill 1`"', "kill"],
  ["echo $(echo $(echo $(kill 1)))", "kill"],
  ["bash -c 'pkill vite'", "pkill"],
  ["sh -c 'pkill vite'", "pkill"],
  ['zsh -lc "kill $PID"', "kill"],
  ["bash -c 'echo a; sh -c \"pkill vite\"'", "pkill"],
  ["eval 'pkill vite'", "pkill"],
  ["eval pkill vite", "pkill"],
  ["cat <(kill 1)", "kill"],
  ["(kill 1)", "kill"],
  ["{ kill 1; }", "kill"],
  ["f() { kill \"$1\"; }; f 12", "kill"],
  // wrappers
  ["env pkill vite", "pkill"],
  ["env -i FOO=1 pkill vite", "pkill"],
  ["FOO=1 pkill vite", "pkill"],
  ["command pkill vite", "pkill"],
  ["builtin kill 1", "kill"],
  ["exec kill 1", "kill"],
  ["nohup pkill vite", "pkill"],
  ["time pkill vite", "pkill"],
  ["nice -n 5 pkill vite", "pkill"],
  ["timeout 5 pkill vite", "pkill"],
  ["stdbuf -oL pkill vite", "pkill"],
  ["pkill vite >/dev/null 2>&1", "pkill"],
  ["2>&1 pkill vite", "pkill"],
  // runners
  // bundled short options whose last letter takes a value (`-rI pid`), and options with values on the wrappers
  ["pgrep node | xargs -rI pid kill pid", "xargs kill"],
  ["xargs -tI PID kill PID", "xargs kill"],
  ["xargs -rI{} kill {}", "xargs kill"],
  ["sudo -nu root pkill x", "sudo pkill"],
  ["sudo -iu root kill 1", "sudo kill"],
  ["sudo -uroot kill 1", "sudo kill"],
  ["timeout -s KILL 5 kill 1", "kill"],
  ["timeout -k 5 10 kill 1", "kill"],
  ["timeout --signal=KILL 5 pkill vite", "pkill"],
  ["nice --adjustment=5 kill 1", "kill"],
  ["exec -a x kill 1", "kill"],
  ["busybox kill 1", "busybox kill"],
  ["npx fkill :3000", "npx fkill"],
  ["npx fkill-cli", "npx fkill-cli"],
  ["skill -9 vite", "skill"],
  ["tmux send-keys -t dev C-c", "tmux send-keys C-c"],
  ["screen -X quit", "screen quit"],
  ["trap 'kill 0' EXIT", "kill"],
  ["sudo kill 1", "sudo kill"],
  ["sudo -u root pkill vite", "sudo pkill"],
  ["doas kill 1", "doas kill"],
  ["watch kill 1", "watch kill"],
  ["watch -n 2 kill 1", "watch kill"],
  ["watch 'kill 1'", "watch kill"],
  ["ssh host pkill vite", "ssh pkill"],
  ["ssh host 'pkill vite'", "ssh pkill"],
  ["ssh -p 22 -i key host 'ls; pkill vite'", "ssh pkill"],
  ["su -c 'pkill vite'", "su pkill"],
  ["flock /tmp/l -c 'pkill vite'", "flock pkill"],
  ["flock /tmp/l pkill vite", "flock pkill"],
  ["parallel kill ::: 1 2", "parallel kill"],
  ["parallel 'kill {}' ::: 1 2", "parallel kill"],
  ["setsid pkill vite", "setsid pkill"],
  ["caffeinate -i pkill vite", "caffeinate pkill"],
  ["script -q /dev/null pkill vite", "script pkill"],
  ["sudo xargs kill", "sudo xargs kill"],
  ["find . -name '*.pid' -exec kill {} \\;", "kill"],
  ["find . -name '*.pid' -exec kill {} +", "kill"],
  ["find . -execdir pkill vite \\;", "pkill"],
  ["find . -ok kill {} \\;", "kill"],
  ["find . -exec sh -c 'kill $0' {} \\;", "kill"],
  ["xargs sh -c 'kill $0'", "xargs"],
  ["env -S 'pkill vite'", "pkill"],
  // the verbs that stop a server
  ["launchctl kill 9 gui/501/x", "launchctl kill"],
  ["launchctl stop com.x", "launchctl stop"],
  ["launchctl bootout gui/501 /Library/x.plist", "launchctl bootout"],
  ["launchctl unload x.plist", "launchctl unload"],
  ["launchctl remove com.x", "launchctl remove"],
  ["launchctl kickstart -k gui/501/com.x", "launchctl kickstart -k"],
  ["systemctl stop nginx", "systemctl stop"],
  ["systemctl --user restart x", "systemctl restart"],
  ["service nginx stop", "service stop"],
  ["docker kill web", "docker kill"],
  ["docker stop web", "docker stop"],
  ["docker restart web", "docker restart"],
  ["docker compose down", "docker down"],
  ["docker compose -f a.yml stop", "docker stop"],
  ["docker-compose kill", "docker-compose kill"],
  ["podman stop x", "podman stop"],
  ["pm2 stop all", "pm2 stop"],
  ["pm2 delete all", "pm2 delete"],
  ["pm2 restart api", "pm2 restart"],
  ["tmux kill-server", "tmux kill-server"],
  ["tmux kill-session -t dev", "tmux kill-session"],
  ["brew services stop postgresql", "brew stop"],
  ["brew services restart postgresql", "brew restart"],
  // interpreters
  ['node -e "process.kill(1234)"', "node"],
  ["node -e \"require('child_process').execSync('pkill -f vite')\"", "node"],
  ["bun -e 'process.kill(1)'", "bun"],
  ["bun --eval \"Bun.spawnSync(['pkill','vite'])\"", "bun"],
  ['python3 -c "import os; os.kill(1, 9)"', "python3"],
  ['python -c "import os,signal; os.kill(1, signal.SIGTERM)"', "python"],
  ["ruby -e 'Process.kill(\"TERM\", 1)'", "ruby"],
  ["perl -e 'kill 9, 1'", "perl"],
  ["php -r 'posix_kill(1, 9);'", "php"],
  ['awk \'BEGIN { system("kill 1") }\'', "awk"],
  // (a known false positive: awk's program is a word that says kill, so use grep for it)
  ["awk '/kill/ {print}' file", "awk"],
  ["osascript -e 'tell application \"Vite\" to quit'", "osascript"],
  ["deno eval 'Deno.kill(1)'", "deno"],
  ["python3 - <<'EOF'\nimport os\nos.kill(1, 9)\nEOF", "python3"],
  ["echo 'process.kill(1)' | node", "node"],
  ["echo 'process.kill(1)' | node -", "node"],
  // what it can't read, on a line that mentions a kill
  ["K=kill; $K 12", "variable"],
  ['CMD="pkill vite"; $CMD', "variable"],
  ['CMD="pkill vite"; sh -c "$CMD"', "variable"],
  ["$(echo kill) 12", "variable"],
  ["echo 'pkill vite' | sh", "fed by a pipe"],
  ["echo 'pkill vite' | bash", "fed by a pipe"],
  ["sh <<'EOF'\npkill vite\nEOF", "fed by a pipe"],
  ["bash <<< 'pkill vite'", "fed by a pipe"],
  ["echo 'pkill vite' | at now", "at"],
  ["at now <<< 'pkill vite'", "at"],
  ["batch <<< 'pkill vite'", "batch"],
];

const allowed = [
  // reading code and history that talk about killing
  "grep -rn pkill .",
  "grep -rn 'kill' src/",
  "rg -n 'killall|pkill' .",
  "git log --grep=kill --oneline",
  "git log -S'pkill' --oneline",
  "git grep kill",
  "git diff HEAD~1 -- nokill.ts",
  "git show 7c45c8b",
  "cat kill.ts",
  "cat harness/nokill.ts",
  "ls -la scripts/kill-port.sh",
  "head -50 nokill.test.ts",
  "echo kill",
  "echo 'pkill vite'",
  'printf "%s\\n" "kill -9 1"',
  "man kill",
  "type kill",
  "which pkill",
  "command -v pkill",
  "command -V kill",
  "sed -n '/kill/p' file",
  "wc -l nokill.ts",
  "bun test nokill.test.ts",
  "bun test -t kill",
  "bun test --test-name-pattern 'a kill is refused'",
  "bun run check",
  "bun q.ts check -- bun run check",
  "bun harness/packet.ts yonder",
  "bun addon-kit/q.ts check -- bun run check",
  "node scripts/kill-port.js",
  "node --version",
  "python3 -m pytest -k kill",
  "python3 script.py",
  "bun scripts/serve.mjs --help",
  // looking at processes is reading
  "ps aux | grep vite",
  "ps -ef",
  "pgrep -fl vite",
  "pgrep -f vite",
  "lsof -i :3000",
  "lsof -ti :3000",
  "lsof -i :3000 | head -5",
  "curl -s localhost:3000/health",
  "uptime",
  // runners and wrappers that run something else
  "xargs grep -n kill",
  "git ls-files | xargs grep -n kill",
  "git ls-files | xargs -n 1 wc -l",
  "git ls-files | xargs -I {} wc -l {}",
  "find . -name '*.ts' -exec grep -l kill {} +",
  "find . -name '*.ts' -exec grep -l kill {} \\;",
  "find . -name '*kill*'",
  "find . -type f -name 'pkill*' -print",
  "env FOO=1 bun test",
  "nohup bun test > /dev/null",
  "timeout 60 bun test",
  "time bun test",
  "nice -n 5 bun test",
  "sudo ls",
  "sudo -uroot ls",
  "sudo -nu root ls",
  "xargs -n1 grep kill",
  "xargs -rI{} grep kill {}",
  "xargs -rI X grep kill X",
  "timeout -s KILL 5 bun test",
  "timeout -k 5 10 bun test",
  "nice --adjustment=5 ls",
  "exec -a x ls",
  "busybox ls",
  "tmux send-keys -t dev ls Enter",
  "trap - EXIT",
  "trap 'rm -f x' EXIT",
  "screen -ls",
  "ssh host ls -la",
  "ssh host 'git log --oneline'",
  "watch -n 2 ls",
  "npx tsc --noEmit",
  "bunx prettier --check .",
  "bun x tsc",
  "npm exec -- tsc",
  "pnpm dlx tsc",
  // stopping nothing
  "docker ps",
  "docker logs web",
  "docker compose ps",
  "docker compose up --dry-run",
  "systemctl status nginx",
  "systemctl list-units",
  "launchctl list",
  "launchctl print gui/501/x",
  "pm2 list",
  "pm2 logs",
  "tmux ls",
  "brew services list",
  // a shell that reads nothing about a kill
  "bash -c 'echo hi'",
  "sh -c 'ls | wc -l'",
  "eval 'echo hi'",
  "echo $(date)",
  "echo `date`",
  "f() { echo \"$1\"; }; f 12",
  "K=ls; $K",
  "echo 'echo hi' | sh",
  "sh <<'EOF'\necho hi\nEOF",
  "echo 'console.log(1)' | node",
  "python3 - <<'EOF'\nprint(1)\nEOF",
  "bun -e 'console.log(1)'",
  "node -e \"console.log('hi')\"",
  "python3 -c 'print(1)'",
  "awk '{print $1}' file",
  "osascript -e 'display dialog \"hi\"'",
  // git, as a reviewer uses it
  // (the word skill, killed or a killer is no kill)
  "ls ~/.claude/skills",
  "grep -n skill CLAUDE.md",
  "echo killed",
  "git log --oneline | grep -i killed",
  "grep -rn 'killer' src",
  "bun test --test-name-pattern 'the kill is refused'",
  "git status --short",
  "git diff --stat",
  "git log --oneline -5",
  "git -C yonder diff",
  "cd yonder && git diff",
  "",
  "   ",
];

describe("a command that kills or signals a process, or stops a server, is refused", () => {
  for (const [cmd, why] of refused)
    test(JSON.stringify(cmd), () => {
      const got = kills(cmd);
      expect(got).toBeDefined();
      expect(got).toContain(why);
    });
});

describe("a read of code or processes, or a command that runs something else, is let through", () => {
  for (const cmd of allowed)
    test(JSON.stringify(cmd), () => {
      expect(kills(cmd)).toBeUndefined();
    });
});

describe("what it can't read", () => {
  test("a line nested past six levels is refused only when it mentions a kill", () => {
    const deep = (inner: string) => "echo $(".repeat(8) + inner + ")".repeat(8);
    expect(kills(deep("echo hi"))).toBeUndefined();
    expect(kills(deep("pkill vite"))).toBeDefined();
  });

  test("refusal() never throws, a parse that fails is refused only when it mentions a kill", () => {
    expect(refusal("pkill vite")).toContain("pkill");
    expect(refusal("echo hi")).toBeUndefined();
    expect(() => refusal("echo $(((((")).not.toThrow();
  });
});

// The session's mode (--session): a kill of the call's own children passes, every other kill stays refused.
const sessionPasses = [
  "sleep 9 & kill %1",
  "kill -0 999999",
  "sleep 9 & kill $!",
  'sleep 9 & kill "$!"',
  "sleep 9 & kill ${!}",
  "node serve.js & pid=$!; sleep 1; curl -s localhost:3000; kill $pid",
  'node serve.js & pid=$!; trap "kill $pid" EXIT; bun test',
  "bun run dev & export p=$! && sleep 2 && kill -9 ${p}",
  "sleep 9 & kill -TERM $!",
  "sleep 9 & kill -s KILL $!",
  "sleep 9 & timeout 5 kill $!",
  "sleep 9 & /bin/kill $!",
  "sleep 9 & kill %% %+ %- %2",
  "a | b & kill $!",
  "sleep 9 & kill -- $!",
  "sleep 9 & kill -9 -- $!",
  'sleep 9 & eval "kill $!"',
  "kill -s 0 $(cat x.pid)",
  "kill -n 0 4821",
  "kill -l",
  "kill -L",
  'bash -c "sleep 3 & kill \\$!"',
];
const sessionRefused: [string, string][] = [
  // (no background job before it: zsh reads an unset $! as 0, so `kill $!` is `kill 0`, the whole group)
  ["kill $!", "kill"],
  ["kill %1", "kill"],
  ["pid=$!; kill $pid", "kill"],
  ["kill $!; sleep 9 &", "kill"],
  ["pid=$!; sleep 9 & kill $pid", "kill"],
  ["sleep 9 & kill $pid; pid=$!", "kill"],
  // (a variable the line changes elsewhere, or later in a loop or a trap, is no child)
  ["sleep 9 & p=$!; for p in 4821; do kill $p; done", "kill"],
  ["sleep 9 & p=$!; read p < f; kill $p", "kill"],
  ["sleep 9 & p=$!; let p=4821; kill $p", "kill"],
  ["sleep 9 & p=$!; printf -v p 4821; kill $p", "kill"],
  ["sleep 9 & p=$!; IFS= read -r p <<< 4821; kill $p", "kill"],
  ["sleep 9 & p=$!; unset p; kill $p", "kill"],
  ["sleep 9 & p=$!; p+=1; kill $p", "kill"],
  ["sleep 9 & p=$!; echo ${p:=4821}; kill $p", "kill"],
  ["sleep 9 & p=$!; while true; do kill $p; p=4821; done", "kill"],
  ["sleep 9 & p=$!; trap 'kill $p' EXIT; p=4821", "kill"],
  ["sleep 9 & p=$!; sleep 8 & p=$!; kill $p", "kill"],
  ["(sleep 9 &); kill $!", "kill"],
  ["{ sleep 9 & }; kill $!", "kill"],
  ['bash -c "kill \\$!"', "kill"],
  // (the signal is the first option alone: a later dash word is a target, a group)
  ["kill -9 -0", "kill"],
  ["kill -s KILL -0", "kill"],
  ["sleep 9 & kill -TERM -0 $!", "kill"],
  ["sleep 9 & kill -9 -- -$!", "kill"],
  ["kill 4821", "kill"],
  ["kill -9 4821", "kill"],
  ["kill", "kill"],
  ["kill -9", "kill"],
  ["kill 0", "kill"],
  ["kill -1", "kill"],
  ["kill -9 -1", "kill"],
  ["kill -- -$!", "kill"],
  ["kill $pid", "kill"],
  ["kill ${PID}", "kill"],
  ["pid=$!; pid=5; kill $pid", "kill"],
  ["pid=$(pgrep vite); kill $pid", "kill"],
  ["for p in 1 2; do kill $p; done", "kill"],
  ["kill $! $(pgrep vite)", "kill"],
  ["kill $(lsof -ti:3000)", "kill"],
  ["kill %vite", "kill"],
  ["echo pid=$!; kill $pid", "kill"],
  ["sudo kill $!", "sudo kill"],
  ["echo $! | xargs kill", "xargs kill"],
  ["find . -name '*.pid' -exec kill {} +", "kill"],
  ["pkill -f scripts/serve.mjs", "pkill"],
  ["killall node", "killall"],
  ["fuser -k 3000/tcp", "fuser -k"],
  ["npx kill-port 3000", "npx kill-port"],
  ["docker compose down", "docker down"],
  ["launchctl stop com.x", "launchctl stop"],
  ["node -e 'process.kill(4821)'", "inline script"],
];

describe("the session's mode lets a kill of its own command's children through", () => {
  for (const cmd of sessionPasses)
    test(JSON.stringify(cmd), () => {
      expect(refusal(cmd, true)).toBeUndefined();
      // (a helper may not even do that)
      expect(refusal(cmd)).toBeDefined();
    });
});

describe("the session's mode refuses every other kill", () => {
  for (const [cmd, why] of sessionRefused)
    test(JSON.stringify(cmd), () => {
      expect(refusal(cmd, true)).toContain(why);
    });
  test("every form the helpers' gate refuses stays refused, but a kill -0, which signals nothing", () => {
    const own = new Set(["kill -0 999999"]);
    for (const [cmd] of refused) expect([cmd, refusal(cmd, true) !== undefined]).toEqual([cmd, !own.has(cmd)]);
  });
  test("the reads stay readable", () => {
    for (const cmd of allowed) expect(refusal(cmd, true)).toBeUndefined();
  });
});

describe("whose a kill target is", () => {
  test("a variable is the call's own only when set from $! after a background job, and not set to anything else since", () => {
    expect([...ownVars("srv & a=$! b=1; export c=${!}; local d=$!; d=2; readonly e=$!")].sort()).toEqual(["a", "c", "e"]);
    expect([...ownVars("srv & echo x=$!; f=$! g=$!")].sort()).toEqual(["f", "g"]);
    expect([...ownVars("a=$! b=$!")]).toEqual([]);
    expect([...ownVars("(srv &); a=$!")]).toEqual([]);
    expect([...ownVars('srv & a="$!"; echo "$a ${a}"')]).toEqual(["a"]);
    expect([...ownVars("srv & a=$!; for a in 1; do :; done")]).toEqual([]);
  });
  test("the literal pids a refused line gives kill are named, not its options or other numbers", () => {
    expect(literalPids("kill -9 4821; sleep 3000; kill $x 12")).toEqual([4821, 12]);
    expect(literalPids("kill -1")).toEqual([]);
  });
  test("a session's refusal names the process a literal pid is, and points at TaskStop", () => {
    const text = refusalText("kill", `kill ${process.pid}`, true);
    expect(text).toContain("TaskStop");
    expect(text).toContain("report it");
    expect(text).toContain(`${process.pid} `);
    expect(refusalText("kill", "kill 999999", true)).toContain("999999: no such process");
    expect(refusalText("pkill", "pkill vite", false)).toContain("A helper never kills");
  });
  test("a session's refusal of a script that may only mention a kill says to run it from a file", () => {
    const cmd = "python3 - <<EOF\nprint('pkill')\nEOF";
    const why = refusal(cmd, true)!;
    expect(why).toContain("stdin");
    expect(refusalText(why, cmd, true)).toContain("put it in a file and run that");
    expect(refusalText("kill", "kill 999999", true)).not.toContain("put it in a file");
  });
});

describe("the hook as Claude Code runs it", () => {
  const script = join(import.meta.dir, "nokill.ts");
  const run = (stdin: string, env: Record<string, string> = {}, args: string[] = []) => {
    const p = Bun.spawnSync(["bun", script, ...args], { stdin: Buffer.from(stdin), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const call = (command: unknown, tool = "Bash") => JSON.stringify({ session_id: "s", cwd: "/tmp", hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, agent_type: "reviewer" });

  test("a kill exits 2 with the reason on stderr and nothing on stdout", () => {
    const r = run(call("lsof -ti:3000 | xargs kill -9"));
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("Refused (the no-kill gate): xargs kill");
    expect(r.err).toContain("Report what it would have fixed as a finding");
  });

  test("a read exits 0 and says nothing", () => {
    const r = run(call("git diff && grep -rn pkill ."));
    expect(r).toEqual({ code: 0, out: "", err: "" });
  });

  test("a tool that isn't Bash, or a call with no command, is none of its business", () => {
    expect(run(call("pkill vite", "Read")).code).toBe(0);
    expect(run(JSON.stringify({ tool_name: "Bash", tool_input: {} })).code).toBe(0);
    expect(run(call(42)).code).toBe(0);
  });

  test("input it can't read is refused only when it mentions a kill", () => {
    expect(run("not json, pkill vite").code).toBe(2);
    expect(run("not json at all").code).toBe(0);
    expect(run("").code).toBe(0);
  });

  test("--session lets the call's own children be stopped and refuses the rest, with its own words", () => {
    expect(run(call("sleep 9 & kill $!"), {}, ["--session"])).toEqual({ code: 0, out: "", err: "" });
    const r = run(call("kill 999999"), {}, ["--session"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("Refused (the no-kill gate): kill. A session stops only what its own command started: a job it put in the background with & earlier in the same command");
    expect(r.err).toContain("999999: no such process");
    expect(run(call("sleep 9 & kill $!")).code).toBe(2);
  });
});
