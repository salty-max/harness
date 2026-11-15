// templates/settings-asks.json against the commands that must ask and the reads that must not, and
// doctor.ts's check that a project carries them (bun test).
// The matcher approximates Claude Code's own (code.claude.com/docs/en/permissions, read 15 November 2026):
// a `*` matches any text, spaces too; a command splits on && || ; | |& & and newlines outside quotes, and
// the bodies of $(…) and backticks are commands too; leading VAR=x assignments and the wrappers timeout,
// time, nice, nohup, stdbuf, command, builtin, noglob and a bare xargs come off first; an ask applies when
// any part matches. Not modelled: Claude Code's real parser (heredocs, functions, case), so a pass here
// says the patterns are right for the forms below, not that Claude Code behaves the same on every input.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingAsks } from "./doctor";
import { withAsks } from "./init";

const ASKS = JSON.parse(readFileSync(join(import.meta.dir, "templates", "settings-asks.json"), "utf8")) as string[];

/** The parts of a command a rule is matched against. */
export function parts(command: string): string[] {
  const out: string[] = [];
  const nested: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < command.length; ) {
    const c = command[i]!;
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < command.length) {
        cur += command.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) quote = "";
      cur += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (command.startsWith("$(", i)) {
      let depth = 1;
      let j = i + 2;
      for (; j < command.length && depth; j++) depth += command[j] === "(" ? 1 : command[j] === ")" ? -1 : 0;
      nested.push(command.slice(i + 2, j - 1));
      cur += command.slice(i, j);
      i = j;
      continue;
    }
    if (c === "`") {
      const j = command.indexOf("`", i + 1);
      if (j > 0) {
        nested.push(command.slice(i + 1, j));
        cur += command.slice(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    const op = ["&&", "||", "|&", ";", "|", "&", "\n"].find(
      (o) => command.startsWith(o, i) && !(o === "&" && (/[<>]/.test(command[i - 1] ?? "") || command[i + 1] === ">")),
    );
    if (op) {
      out.push(cur);
      cur = "";
      i += op.length;
      continue;
    }
    cur += c;
    i++;
  }
  out.push(cur);
  const count = (s: string, ch: string) => s.split(ch).length - 1;
  const unwrap = (p: string) => {
    // a subshell's or a group's own brackets come off, a $( … )'s stay
    while (/^[({]/.test(p) && count(p, p[0]!) > count(p, p[0] === "(" ? ")" : "}")) p = p.slice(1).trim();
    while (/[)}]$/.test(p) && count(p, p.at(-1)!) > count(p, p.at(-1) === ")" ? "(" : "{")) p = p.slice(0, -1).trim();
    return p;
  };
  const cleaned = out
    .map((p) => unwrap(p.trim()))
    .map((p) => p.replace(/^(?:then|do|else|if|while|!)\s+/, "").trim())
    .filter(Boolean);
  return [...cleaned, ...nested.flatMap(parts)];
}

const WRAPPER =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+|timeout\s+(?:-\S+\s+)*\S+\s+|time\s+|nice\s+(?:-n\s*\S+\s+|-\d+\s+)?|nohup\s+|stdbuf\s+(?:-\S+\s+)*|command\s+(?!-v)|builtin\s+|noglob\s+|xargs\s+(?!-))/;

function bare(part: string): string {
  for (let m = WRAPPER.exec(part); m; m = WRAPPER.exec(part)) part = part.slice(m[0].length);
  return part;
}

function matches(rule: string, part: string): boolean {
  const pattern = rule.slice("Bash(".length, -1);
  if (!pattern.includes("*")) return part === pattern;
  if (pattern.endsWith(" *") && pattern.split("*").length === 2 && part === pattern.slice(0, -2)) return true;
  const rx = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  return rx.test(part);
}

/** The rules a command trips. */
export function asked(rules: string[], command: string): string[] {
  const hit = new Set<string>();
  for (const p of parts(command)) for (const r of rules) if (matches(r, bare(p)) || matches(r, p)) hit.add(r);
  return [...hit];
}

const MUST_ASK = [
  // a push, past the hooks, through the tools
  "git push",
  "git push origin main",
  "git -C api push -q",
  "git commit --no-verify -m x",
  "git -c core.hooksPath=/dev/null commit -m x",
  "bun harness/each.ts --all -- git push",
  "bun harness/hooks.ts uninstall api",
  // releases, merges, workflows
  "gh release create v1.0.0",
  "gh -R owner/repo release upload v1 a.zip",
  "gh pr merge 3 --squash",
  "gh --repo owner/repo pr merge 3",
  "gh workflow run release.yml",
  "gh run rerun 123 --failed",
  "gh -R owner/repo run rerun 123",
  // repositories, and the token that gets past every gh rule
  "gh repo create owner/repo --public",
  "gh repo edit owner/repo --visibility public --accept-visibility-change-consequences",
  "gh repo delete owner/repo --yes",
  "gh repo rename new --repo owner/old --yes",
  "gh repo archive owner/repo --yes",
  'curl -s -X PUT -H "Authorization: Bearer $(gh auth token)" https://api.github.com/repos/owner/repo/pulls/1/merge',
  // gh api writes: a method named, or a body (a POST by default)
  "gh api -X PUT repos/owner/repo/pulls/12/merge",
  "gh api -XPUT repos/owner/repo/pulls/12/merge",
  "gh api --method PUT repos/owner/repo/pulls/12/merge",
  "gh api --method=DELETE repos/owner/repo/git/refs/heads/x",
  "gh api repos/owner/repo/git/refs -f ref=refs/heads/x -f sha=abc",
  "gh api repos/owner/repo/git/refs -fref=refs/heads/x",
  "gh api repos/owner/repo/issues -F title=x",
  "gh api repos/owner/repo/issues --field title=x",
  "gh api repos/owner/repo/issues --raw-field=title=x",
  "gh api repos/owner/repo/issues --input body.json",
  "gh api repos/owner/repo/actions/workflows/ci.yml/dispatches -f ref=main",
  "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
  "GH_TOKEN=x gh api -X PUT repos/owner/repo/pulls/1/merge",
  "cd api && gh api -X PUT repos/owner/repo/pulls/12/merge --jq .merged",
  'del() { gh api -X DELETE "repos/owner/$1/git/refs/heads/$2"; }; del repo x',
  // vercel api writes
  "vercel api /v13/deployments --input body.json",
  "vercel api /v13/deployments -XPOST --input body.json",
  "vercel api /v10/projects -F name=x",
  "vercel api /v10/projects -f name=x",
  "vercel api /v9/projects/x -X PATCH -f rootDirectory=apps/web",
  "npx vercel api /v13/deployments --input body.json",
  // a deploy: the default command, any path, any runner
  "vercel",
  "vercel .",
  "vercel ./apps/web --yes",
  "vercel apps/web --yes",
  "vercel /Users/me/project",
  "vercel ~/code/project",
  'vercel "$DIR" --yes',
  "vercel $DIR",
  "vercel somefolder --prod",
  "vercel somefolder --target=production",
  "vercel --prod",
  "vercel --cwd web --prod",
  "vercel -e NODE_ENV=production",
  "npx vercel",
  "npx vercel --prod",
  "npx vercel 2>&1",
  "npx --no-install vercel",
  "bunx vercel apps/web",
  "bun x vercel",
  "pnpm vercel",
  "pnpm dlx vercel",
  "pnpm dlx vercel apps/web --yes",
  "npx vercel@latest",
  "npx vercel@latest --prod --yes",
  "bunx vercel@latest promote dpl_x --yes",
  "npx vercel@62 env rm TAG production --yes",
  "(cd web && vercel 2>&1 | tail -5)",
  "vercel > /tmp/deploy.out",
  "vc",
  "vc --prod",
  "vercel deploy --prod --yes",
  "cd web && vercel --prod --yes 2>&1 | tail -5",
  "timeout 300 vercel deploy --prod",
  "VERCEL_ORG_ID=x vercel deploy",
  "for d in a b; do vercel $d --yes; done",
  "echo $(vercel deploy --prod)",
  // production, the project, its secrets, its data, money
  "vercel redeploy https://x.vercel.app",
  "vercel promote dpl_123 --yes",
  "vercel rollback",
  "vercel rolling-release start",
  "vercel rr approve",
  "vercel alias set dpl.vercel.app example.com",
  "vercel ln dpl.vercel.app example.com",
  "vercel domains add example.com web",
  "vercel dns add example.com www CNAME x",
  "vercel certs issue example.com",
  "vercel firewall ip-blocks block 1.2.3.4",
  "vercel redirects add /a /b",
  "vercel routes add",
  "vercel remove dpl_123 --yes",
  "vercel rm web --safe --yes",
  "printf v | vercel env add TAG production",
  "vercel env rm TAG production --yes",
  "vercel env remove TAG production",
  "vercel env update TAG production",
  "vercel project add web",
  "vercel projects add web",
  "vercel project create web",
  "vercel project rm web --yes",
  "vercel projects remove web",
  "vercel project rename a b",
  "vercel project update --framework vite",
  "vercel project pause web",
  "vercel project protection disable web",
  "vercel link --yes --project web",
  "vercel git connect https://github.com/owner/repo",
  "vercel git disconnect --yes",
  "vercel crons run /api/cron/x",
  "vercel blob del a.json",
  "vercel blob delete-store store_abc --yes",
  "vercel blob empty-store",
  "vercel blob put a.json",
  "vercel blob create-store x",
  "vercel cache purge --yes",
  "vercel tokens create ci",
  "vercel integration add neon",
  "vercel buy credits",
  // secrets and variables
  "gh secret set X",
  "gh -R owner/repo variable delete X",
];

const MUST_NOT_ASK = [
  "gh pr list -R owner/repo --json number,title",
  "gh pr view 12 -R owner/repo --json files",
  "gh pr checks 12",
  "gh pr diff 12",
  "gh run list -R owner/repo --limit 5",
  "gh run view 123 --log-failed",
  "gh run watch 123 --exit-status",
  "gh secret list -R owner/repo",
  "gh variable list",
  "gh repo view owner/repo --json visibility",
  "gh auth status",
  "gh api rate_limit",
  "gh api user --jq .login",
  "gh api repos/owner/repo/compare/main...abc --jq .behind_by",
  "gh api repos/owner/repo/vulnerability-alerts -i",
  "gh api repos/owner/repo/actions/runs --paginate --jq '.workflow_runs[].id'",
  "gh api 'repos/owner/repo/commits?per_page=5' -q '.[].sha'",
  "gh api repos/owner/repo/contents/README.md -H 'Accept: application/vnd.github.raw'",
  "gh api repos/owner/repo/pulls/7/files --jq '.[].filename' | grep -F data/",
  "gh api repos/owner/repo-forever/releases/latest --jq .tag_name",
  "vercel api /v2/user",
  "vercel api /v9/projects/web --scope team --raw",
  'vercel api "/v6/deployments?projectId=x&limit=1" --scope team',
  "vercel ls",
  "vercel ls web --scope team 2>&1 | head -8",
  "vercel ls --environment production",
  "vercel inspect https://web-abc-team.vercel.app --wait --timeout 5m",
  "vercel logs web.example.com --since 10m",
  "vercel env ls production",
  "vercel env pull /tmp/x.env --environment=production",
  "vercel pull --environment=production",
  "vercel whoami",
  "vercel teams ls",
  "vercel project ls",
  "vercel projects ls",
  "vercel project inspect web",
  "vercel blob list --prefix a/",
  "vercel blob get a.json",
  "vercel blob list-stores",
  "vercel crons ls",
  "vercel help",
  "vercel curl /api/health --deployment x.vercel.app",
  "cat web/.vercel/project.json",
  "ls web/.vercel 2>/dev/null",
  "bun run build:vercel 2>&1 | tail -6",
  "bun build src/vercel.ts --target=node --format=esm",
  'git commit -qm "feat(web): visits counted (vercel web analytics)"',
  "curl -s https://web.vercel.app/api/health",
];

describe("the template's asks", () => {
  test("every command that reaches GitHub, Vercel or past the hooks asks", () => {
    expect(MUST_ASK.filter((c) => asked(ASKS, c).length === 0)).toEqual([]);
  });

  test("the reads a project leans on never ask", () => {
    expect(MUST_NOT_ASK.map((c) => [c, asked(ASKS, c)]).filter(([, r]) => r!.length)).toEqual([]);
  });

  test("every rule is a Bash rule, each once", () => {
    for (const r of ASKS) expect(r).toMatch(/^Bash\(.+\)$/);
    expect(new Set(ASKS).size).toBe(ASKS.length);
  });

  test("doctor names the template's asks a project lacks, and none once init has merged them", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "asks-test-")));
    expect(missingAsks(root)[0]).toContain("not there");
    mkdirSync(join(root, ".claude"));
    const file = join(root, ".claude", "settings.json");
    writeFileSync(file, JSON.stringify({ permissions: { ask: ["Bash(git push *)"] } }));
    expect(missingAsks(root)[0]).toContain(`${ASKS.length - 1} of the template's asks missing`);
    writeFileSync(file, JSON.stringify(withAsks({ model: "opus" }, ASKS)));
    expect(missingAsks(root)).toEqual([]);
  });

  test("the matcher splits, strips and globs as the docs say", () => {
    expect(parts("cd a && git push; echo $(vercel --prod) | tee x")).toEqual(["cd a", "git push", "echo $(vercel --prod)", "tee x", "vercel --prod"]);
    expect(parts("echo 'a && b' | cat")).toEqual(["echo 'a && b'", "cat"]);
    expect(bare("FOO=1 timeout 30 nice git push")).toBe("git push");
    expect(matches("Bash(ls *)", "ls")).toBe(true);
    expect(matches("Bash(ls *)", "lsof")).toBe(false);
    expect(matches("Bash(vercel)", "vercel ls")).toBe(false);
  });
});
