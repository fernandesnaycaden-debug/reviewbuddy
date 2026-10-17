# reviewbuddy
AI code reviewer for GitHub PRs. Runs on local models (Ollama) or free cloud APIs.

It reviews a GitHub pull request and posts its findings as inline review comments, or reviews your local git changes (or a diff file, or a diff on stdin) and prints them. Results can also be written as [JSON or SARIF](#output-formats) for other tools. It can also [run on every pull request](#run-it-on-every-pull-request) as a GitHub Action, and upload its findings to [Code Scanning](#upload-findings-to-code-scanning).

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (`node --version`)
- One model provider, either:
  - [Ollama](https://ollama.com/) 0.5 or newer running locally, with at least one model pulled (the default), or
  - an API key for a cloud provider: Groq, OpenRouter, Gemini or Anthropic (see [Choose a provider](#choose-a-provider))

No `npm install` is needed: the project has no dependencies.

## Run it without cloning

```powershell
npx reviewbuddy --staged                 # in your project: review what you're about to commit
npx reviewbuddy https://github.com/owner/repo/pull/12 --dry-run
npx reviewbuddy changes.diff
```

Until the package is on npm, run it straight from GitHub instead: `npx github:fernandesnaycaden-debug/reviewbuddy <flags, pr-url or diff>`. Every option below works the same way; just swap `npm run review --` for `npx reviewbuddy`.

## Run it from a clone

```powershell
git clone https://github.com/fernandesnaycaden-debug/reviewbuddy.git
cd reviewbuddy

ollama list                                # check which models you have
$env:OLLAMA_MODEL = "qwen2.5-coder:7b"     # use a model name from that list
npm run review
```

`$env:OLLAMA_MODEL` only lasts for the current PowerShell window. On macOS/Linux use `OLLAMA_MODEL=qwen2.5-coder:7b npm run review`.

With no arguments it reviews the sample [samples/buggy.diff](samples/buggy.diff). To review your own work, see [Review your own changes](#review-your-own-changes).

## Choose a provider

reviewbuddy uses Ollama unless you pick another provider with `REVIEWBUDDY_PROVIDER`, `--provider` or the reviewed repo's [`.reviewbuddy.json`](#configure-per-repository) (the flag wins, then the variable). Cloud providers need no local model, just an API key.

| Provider | `--provider` | Free tier | Get a key |
|----------|--------------|-----------|-----------|
| Ollama (local) | `ollama` | Free, runs on your machine | No key needed |
| Groq | `groq` | Yes, with per-minute and daily limits | [console.groq.com/keys](https://console.groq.com/keys) |
| OpenRouter | `openrouter` | Yes, on free models (about 50 requests a day until you buy credits) | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| Gemini | `gemini` | Yes, on Flash and Flash-Lite models | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Anthropic (Claude) | `anthropic` | No, paid per token | [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys) |

Groq:

```powershell
$env:REVIEWBUDDY_PROVIDER = "groq"
$env:GROQ_API_KEY = "gsk_..."
npm run review
```

OpenRouter (the default model `openrouter/free` sends each request to one of the free models):

```powershell
$env:REVIEWBUDDY_PROVIDER = "openrouter"
$env:OPENROUTER_API_KEY = "sk-or-..."
npm run review
```

Gemini:

```powershell
$env:REVIEWBUDDY_PROVIDER = "gemini"
$env:GEMINI_API_KEY = "..."
npm run review
```

Anthropic:

```powershell
$env:REVIEWBUDDY_PROVIDER = "anthropic"
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm run review
```

To switch provider for one run, use the flag: `npm run review -- changes.diff --provider gemini`. To use a different model, set that provider's `*_MODEL` variable (see [Configuration](#configuration)), for example `$env:GROQ_MODEL = "openai/gpt-oss-120b"`.

Like `$env:OLLAMA_MODEL`, these only last for the current PowerShell window, so a key never ends up in a file. reviewbuddy never prints your key, even in error messages.

reviewbuddy asks each provider for replies that match a JSON schema. If a model doesn't support that, it warns once and falls back to plain JSON mode.

## Review your own changes

Tell reviewbuddy which changes to review, and it runs `git diff` itself. No diff file needed:

| Flag | Reviews | Same as |
|------|---------|---------|
| `--staged` | What you're about to commit | `git diff --cached` |
| `--uncommitted` | Everything not committed yet, staged or not | `git diff HEAD` |
| `--branch <base>` | Every commit on the current branch since it left `<base>` | `git diff <base>...HEAD` |
| `--since <rev>` | Every commit since `<rev>` (a commit, tag or branch) | `git diff <rev> HEAD` |

```powershell
cd C:\path\to\your-project
npx reviewbuddy --staged
npx reviewbuddy --branch main
npx reviewbuddy --since HEAD~3

# From the reviewbuddy clone instead, point --repo-dir at the project:
npm run review -- --uncommitted --repo-dir C:\path\to\your-project
```

Use only one of these at a time, and not together with a diff file or PR URL. git runs in `--repo-dir` (or the current directory, or any subdirectory of the repo) and must be on your `PATH`. `--branch` and `--since` only see commits, so commit first or use `--uncommitted`. If there is nothing to review, reviewbuddy says so (`Nothing to review: no staged changes ...`) and exits with code 1.

A diff can touch any number of files; each file is reviewed separately.

Known limits:

- **New files that git doesn't track yet don't show up** in `--uncommitted` (git diff ignores untracked files). Stage them, or run `git add -N <file>` to make git include them without staging their content.
- `--uncommitted`, `--branch` and `--since` need at least one commit.
- Binary files and submodule changes have no added lines to review, so they are skipped.

### Diff files and stdin

You can still review a diff file, from git or any other tool (`diff -u` output works too):

```powershell
git diff --output=changes.diff
npm run review -- changes.diff
```

Or pipe a diff in, and pass `-` as the target:

```bash
git diff main...HEAD -- src/ | npx reviewbuddy -
```

Diff files and stdin can be UTF-8 (with or without a byte order mark) or UTF-16 with a byte order mark. So `git diff > changes.diff` in Windows PowerShell 5.1, which writes UTF-16, works. **One catch in PowerShell 5.1:** piping (`git diff | npx reviewbuddy -`) re-encodes the text using `$OutputEncoding`, which is ASCII by default, so non-ASCII characters (accents, emoji, CJK) reach reviewbuddy as `?`. In PowerShell, use the git flags above or a diff file instead. PowerShell 7 and bash pipe UTF-8 unchanged.

Files with no added lines (deleted files, pure renames, binary files) are skipped. So are files that aren't worth a model's time: lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`), `*.min.*`, `*.map`, `*.snap`, `*.svg`, and anything under `dist/`, `build/`, `vendor/` or `node_modules/`.

To skip more files, pass comma-separated patterns. A pattern ending in `/` matches a directory anywhere, a pattern without `/` matches a file name, and `*` matches anything except `/`:

```powershell
npm run review -- changes.diff --ignore "*.generated.ts,fixtures/"
npm run review -- changes.diff --no-default-ignore   # review lockfiles, dist/ etc. too
```

Large files are reviewed in several parts so they fit in the model's context window.

### Full-file context

A diff alone hides a lot: a value that looks unchecked may be validated a few lines above the hunk, and a function that looks undefined may be defined further down. So besides the diff, reviewbuddy sends the model the new version of each changed file, in a separate section marked as reference only. The model is told to use it to check whether the surrounding code already handles a problem, and never to comment on lines outside the diff (comments on other lines are dropped anyway).

- **Pull requests:** each changed file is downloaded at the PR's head commit. Fine-grained tokens need **Contents: Read** for this. Without it, reviewbuddy warns and reviews that file from the diff alone.
- **Git flags:** each changed file is read in the version the diff's new side comes from, so the context always matches what is being reviewed: the staged version (`git show :path`) for `--staged`, the working tree for `--uncommitted`, and the last commit (`git show HEAD:path`) for `--branch` and `--since`. Paths are relative to the repo's top level, wherever in the repo you run it.
- **Diff files and stdin:** each changed file is read from the current directory, or from `--repo-dir` if you pass one. Use it when you run reviewbuddy from somewhere other than the project:

  ```powershell
  npm run review -- C:\path\to\your-project\changes.diff --repo-dir C:\path\to\your-project
  ```

  If the file isn't there, or its content doesn't match the diff (say, a different branch is checked out), that file is reviewed from the diff alone. Paths in the diff that lead outside the directory (`../`) are never read.

The context has to fit in a per-provider budget for the whole prompt, so the model's context window and free-tier limits aren't exceeded. If the full file doesn't fit next to the diff, reviewbuddy sends only the 40 lines around each change. If even that doesn't fit, it sends the diff alone.

| Provider | Prompt budget (characters, about 3 per token) |
|----------|----------------------------------|
| Ollama | 16,000 (its context is 8,192 tokens, so a file is added only when the diff leaves room) |
| Groq | 24,000 (the free tier limits tokens per minute) |
| OpenRouter | 40,000 |
| Gemini, Anthropic | 60,000 |

More context means more input tokens per request: up to the budget above, usually far less, since most files are a few thousand characters. On free tiers that can bring rate limits sooner; on Anthropic it costs more per review.

## Output formats

`--format` picks how the results are written: `text` (the default), `json` or `sarif`. It can also come from `REVIEWBUDDY_FORMAT` or `"format"` in [`.reviewbuddy.json`](#configure-per-repository).

| Format | Without `--output` | With `--output <file>` | Use it for |
|--------|--------------------|------------------------|------------|
| `text` | Findings printed to the terminal | A Markdown report as well | Reading the review yourself |
| `json` | The JSON document on stdout, nothing else | The JSON document in the file | Scripts, editor plugins, dashboards |
| `sarif` | The SARIF log on stdout, nothing else | The SARIF log in the file | GitHub Code Scanning and other SARIF viewers |

Without `--format`, `--output`'s extension decides: `.json` writes JSON, `.sarif` writes SARIF, anything else (like `.md`) writes the Markdown report. `--format` wins over the extension.

```powershell
npm run review -- --staged -o review-report.md          # Markdown report
npx reviewbuddy --branch main -o results.sarif           # SARIF, from the extension
npx reviewbuddy --staged --format json > review.json     # JSON on stdout
```

When JSON or SARIF goes to stdout, **stdout holds only that document**: progress, findings and warnings all go to stderr, so `reviewbuddy ... --format json | jq .summary` works. Every run overwrites the `--output` file. `--min-severity` and `--fail-on` work the same in every format: dropped findings are left out of the document, and the exit code is 1 when `--fail-on` matches, after the document is written. A run with nothing to review still writes a valid, empty document.

The Markdown report includes a summary table, the model name, and per-file findings with severity badges.

### JSON

```json
{
  "schemaVersion": 1,
  "tool": { "name": "reviewbuddy", "version": "1.0.0" },
  "provider": "groq",
  "model": "openai/gpt-oss-20b",
  "durationSeconds": 14.2,
  "summary": { "files": 1, "findings": 2, "notReviewed": 0 },
  "files": [
    {
      "path": "src/services/orders.js",
      "findings": [
        { "line": 4, "severity": "security", "message": "Hardcoded API key; load it from an environment variable.", "suggestion": "const API_KEY = process.env.API_KEY;" },
        { "line": 22, "severity": "bug", "message": "Off-by-one: `<=` reads past the end of the array." }
      ]
    }
  ],
  "notReviewed": []
}
```

- `schemaVersion` changes only when a field is removed or changes meaning. New fields can appear without a bump, so ignore keys you don't know.
- `path` is relative to the repository root, as in the diff. `line` is the line in the new version of the file.
- `severity` is `security`, `bug`, `performance` or `suggestion`. `endLine` is the last line of a [multi-line finding](#multi-line-findings) and `suggestion` the code that replaces the finding's line (or lines); each is only there when there is one.
- `files` lists every reviewed file, including ones with no findings.
- `notReviewed` lists files that were left out or only partly reviewed, as `{ "path": "...", "reason": "..." }`: too large for the GitHub API, over `--max-files`, failed, or partly reviewed (see [Large pull requests](#large-pull-requests)). `path` is `null` for a note about files GitHub didn't list at all.

### SARIF

`--format sarif` writes a [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) log with one run. There is one rule per severity (`reviewbuddy/security`, `reviewbuddy/bug`, `reviewbuddy/performance`, `reviewbuddy/suggestion`), and each finding is a result with that rule, a repo-relative file URI and its line:

| Severity | SARIF level |
|----------|-------------|
| `security`, `bug` | `error` |
| `performance` | `warning` |
| `suggestion` | `note` |

A suggested fix is added to the result's message as `Suggested fix: ...`. Files that weren't reviewed are `toolExecutionNotifications` on the run's invocation (`error` for a failed file, `warning` otherwise), and `executionSuccessful` is `false` when a file failed. To see the results on GitHub, see [Upload findings to Code Scanning](#upload-findings-to-code-scanning).

## Fail on certain findings

Add `--fail-on` with comma-separated severities (`security`, `bug`, `performance`, `suggestion`) to exit with code 1 when any finding has one of them. The review is still printed (and posted, for a PR) first. This works for diff files and PRs, locally and in CI:

```powershell
npm run review -- changes.diff --fail-on security,bug
$env:REVIEWBUDDY_FAIL_ON = "security"   # same thing, as a variable; the flag wins
```

On a pull request, a finding counts as long as it is still there, not just when it is new: findings from this run count even if they were already posted, and so do inline comments from earlier reviewbuddy reviews whose line hasn't changed since. Once the code under such a comment changes, GitHub marks it outdated and it stops counting. So pushing an unrelated commit doesn't make the check pass, but fixing the flagged line does.

To block a PR through its review instead (a **Request changes** review), and for how the two compare, see [Blocking merges](#blocking-merges).

## Only report serious findings

Severities rank `security` > `bug` > `performance` > `suggestion`. Add `--min-severity` to leave out everything less serious than the one you name. For example, `--min-severity bug` keeps security and bug findings and drops performance and suggestion ones:

```powershell
npm run review -- changes.diff --min-severity bug
$env:REVIEWBUDDY_MIN_SEVERITY = "bug"   # same thing, as a variable; the flag wins
```

Dropped findings are left out everywhere: the terminal, the report, the posted review, the annotations and `--fail-on`. The run prints how many it left out. By default nothing is dropped.

`--fail-on` only sees what `--min-severity` keeps, so `--min-severity bug --fail-on performance` can never fail; reviewbuddy warns about such a combination.

## Review a GitHub pull request

Pass the PR's URL instead of a diff file. reviewbuddy downloads the diff, reviews each file, and posts one review on the PR with a comment on each problem line.

First create a token at GitHub → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new):

- **Repository access:** only the repos you want reviewed
- **Permissions:** Pull requests → **Read and write**, and Contents → **Read** (for [full-file context](#full-file-context))

```powershell
$env:GITHUB_TOKEN = "github_pat_..."
npm run review -- https://github.com/owner/repo/pull/12
```

To see what would be posted without posting anything, add `--dry-run`. Public repos don't need a token for a dry run:

```powershell
npm run review -- https://github.com/owner/repo/pull/12 --dry-run
```

How the review looks on GitHub:

- It is a comment review. reviewbuddy never approves a PR. It requests changes only if you ask it to, with `--request-changes-on` (see [Blocking merges](#blocking-merges)).
- Each finding is an inline comment like **[SECURITY]** Hardcoded API key; load it from an environment variable.
- A problem that covers a block of lines, like a whole loop or `try`/`catch`, is one comment on those lines (see [Multi-line findings](#multi-line-findings)).
- When the fix is a small, certain change to the commented line (or block), the comment ends with a GitHub suggestion. The author can apply it with **Commit suggestion**, or batch several into one commit from the **Files changed** tab.
- The review summary says how many issues were found and which model found them. Findings that point at a line outside the diff can't be attached to that line, so they are listed in the summary instead (without a suggestion).
- At most 50 findings are posted inline, the most severe first; any more are listed in the summary (see [Large pull requests](#large-pull-requests)). So are files that weren't reviewed.

### Suggested fixes

The model gives a replacement line only when it is sure, and only for a fix that fits on the commented line (a [multi-line finding](#multi-line-findings) can get a replacement for its whole block). reviewbuddy then checks it: an empty suggestion, one spanning several lines on a one-line finding, or one identical to the current line is dropped, and the line's original indentation is kept. An inline comment with one is posted like this:

````markdown
**[BUG]** Off-by-one: the loop starts at 1, so the first name is skipped.

```suggestion
  for (let i = 0; i < names.length; i++) {
```
````

On GitHub that shows as the finding, then a diff of the line with the old version in red and the fix in green, and a **Commit suggestion** button. In the terminal the fix is printed under the finding as `fix: ...`, and in the Markdown report it appears as **Fix:** after the issue.

### Multi-line findings

Most findings are about one line. When the problem really is a block, like a whole unsafe loop or a `try`/`catch` that swallows errors, the model can mark the block: `line` is its first line and `endLine` its last. reviewbuddy keeps a range only if:

- it ends after it starts and spans at most **20 lines**,
- its first line is an added line (as for every finding), and
- all its lines are in one hunk of the diff.

Otherwise the finding is kept on its first line alone, and a suggestion written for the whole block is dropped. When posting, GitHub's rule is checked as well: both ends must be in the same hunk of the PR's own diff (an incremental run reviews a different diff). If they aren't, the comment goes on the first line without the suggestion; if even that line isn't in the diff, the finding is listed in the review summary.

On GitHub, a range comment highlights the whole block in the **Files changed** tab, with the comment under its last line, and the conversation shows it as a comment on lines +2 to +4. A multi-line suggestion replaces the whole block:

````markdown
**[BUG]** Off-by-one: `<=` reads one past the end of `xs`.

```suggestion
  for (let i = 0; i < xs.length; i++) {
    use(xs[i]);
  }
```
````

**Commit suggestion** then replaces lines 2 to 4 with these three lines. reviewbuddy keeps the lines' indentation relative to each other and lines the block up with the code it replaces, so a model that drops the leading spaces doesn't break it. A suggestion identical to the current block is dropped.

A range shows up everywhere else too: as `src/a.js:2-4` in the terminal, the Markdown report and the review summary, as `endLine` in [JSON](#json), `region.endLine` in [SARIF](#sarif), and `endLine` on the Actions annotation, which then spans the block.

### Running it again on the same PR

Each review ends with a hidden marker, `<!-- reviewbuddy:sha=... -->`, that records which commit it reviewed. On the next run reviewbuddy looks for the most recent review with that marker posted by reviewbuddy itself: by the GitHub Actions bot (`github-actions[bot]`), or by the user the token belongs to. So a personal token and the Actions bot share the same history. Anyone can post a review containing the marker, and one naming the head commit would otherwise make reviewbuddy skip the review, so a marker from any other account is ignored with a warning. If reviewbuddy posts as a GitHub App, set `REVIEWBUDDY_REVIEWER` to the app's bot login (e.g. `my-app[bot]`).

- **No new commits since then:** it prints `Already reviewed abc1234, nothing new` and stops. No model is called.
- **New commits:** it reviews only the changes since the reviewed commit (GitHub's compare diff), limited to files the PR itself changes. The review summary says `since abc1234`.
- **The reviewed commit is gone** (after a force-push or rebase): it says so and reviews the whole PR.
- **A file failed last time:** that review's marker names the commit the run started from (the earlier reviewed commit, or the PR's base commit for a first review) instead of the head. So the next run reviews those changes again, failed files included, and skips the findings that were already posted.
- **A finding was already posted:** an inline comment from an earlier reviewbuddy review on the same file, line and severity is not posted again. For a range that is its first line: GitHub lists a range comment with `start_line` (first) and `line` (last), and reviewbuddy maps them back. The run prints how many it skipped.
- **Nothing new to post:** no review is posted, not even an empty one. This includes a first run that finds no issues at all, so the next run reviews from the last commit that did get a review (or the whole PR, if none did).

To ignore earlier reviews and review the whole PR again, add `--full`. Findings that are already posted are still skipped:

```powershell
npm run review -- https://github.com/owner/repo/pull/12 --full
```

`--dry-run` prints all of this too: which commit it would diff from, whether it fell back to a full review, how many findings it skipped, the review it would post and its event (`COMMENT` or `REQUEST_CHANGES`), and any earlier change request it would [dismiss](#how-a-change-request-is-cleared).

Known limits: matching is by line number, so a finding whose code moved is posted again on its new line. If the base branch was merged into the PR, the incremental diff includes those changes in files the PR also touches. Findings that went into an earlier review's summary (lines outside the diff, or over the inline limit) are not checked for duplicates.

## Large pull requests

reviewbuddy handles PRs with hundreds of files. It falls back to other GitHub APIs when the diff is too big, reviews several files at once, and has limits so a huge PR can't run for hours or run up a big bill.

### When GitHub won't send the diff

GitHub refuses to send a PR as one diff (HTTP 406) once it is too big: over 300 files, or too many lines. reviewbuddy then lists the PR's changed files page by page (100 per page) and builds the same per-file diffs from them. Nothing else changes: the same line numbers, comments and suggestions. You'll see:

```
The diff is too large for GitHub's diff format, reading the changed files page by page instead.
```

What GitHub's files API can't give you:

- **Files without a patch.** GitHub leaves out the diff of a file when it alone is too large. Those files are skipped and listed in the review summary as `not reviewed: too large for the GitHub API`. Binary files have no patch either, but were never reviewed, so they aren't listed. Neither are ignored files such as lockfiles.
- **More than 3,000 files.** The files API lists at most 3,000. If the PR changes more, the rest are not seen at all, and the summary says how many.

Incremental reviews use GitHub's compare API, which has its own limits. If the compare diff is refused or times out, reviewbuddy reads the compare API's file list instead. That list has at most 300 files and can't be paged through, so when it is full, reviewbuddy says so and reviews the whole PR instead (`Too many changes since abc1234 for GitHub's compare API ..., reviewing the whole PR`).

### Reviewing files in parallel

`--concurrency N` reviews up to N files at once (1 to 16). The pieces of one large file are still reviewed one after another. Set it per run, with `REVIEWBUDDY_CONCURRENCY`, with `"concurrency"` in `.reviewbuddy.json`, or with the action's `concurrency` input. Without it, the default depends on the provider:

| Provider | Default | Why |
|----------|---------|-----|
| Ollama | 1 | One local model on one machine gains nothing from parallel requests; they only queue and risk timeouts |
| Groq, OpenRouter | 2 | Their free tiers limit tokens or requests per minute, and more requests at once just hit that limit sooner |
| Gemini, Anthropic | 4 | Higher limits, so a few at a time cut the wall-clock time a lot |

On a free tier, keep the default or go lower. On paid plans with high limits, 6 to 8 is usually safe; past that, rate limits tend to cancel out the gain. Ollama on a machine with lots of GPU memory and `OLLAMA_NUM_PARALLEL` set can go to 2 to 4.

The output stays readable: each file's lines are held back and printed as one block when that file is done, headed by a running count:

```
Reviewing 140 files with concurrency 4

Reviewed src/api/users.js (1/140)
  src/api/users.js:42 [BUG] ...

Reviewed src/db/query.js (2/140)
  No issues found.
```

Blocks print in the order files finish. Everything else stays in the PR's file order, whatever order files finish in: the posted review, the job summary, the Markdown report, and the JSON and SARIF documents.

**Rate limits.** When a provider or GitHub answers HTTP 429 (or GitHub's 403 secondary rate limit), reviewbuddy waits as long as its `Retry-After` header asks (up to 60 seconds). It also pauses **every** request to that host for that long, not just the one that got the 429, so parallel workers don't keep hammering an API that asked them to stop. The pause is printed right away: `Groq rate limited (HTTP 429), pausing requests to it for 12.0s (1/3)...`.

**When a file fails.** If one file still fails after the retries (a timeout, a server error, a rate limit that doesn't clear), the other files carry on. The failed file is listed in the output and the review summary, and the run exits with code 1, so the check shows the review is incomplete. The next run tries it again (see [Running it again on the same PR](#running-it-again-on-the-same-pr)). Errors that would fail every file stop the run at once: a missing or rejected API key, a model that doesn't exist, an exhausted OpenRouter balance, or Ollama not running.

### Limits

- **`--max-files N`** reviews at most N files (`REVIEWBUDDY_MAX_FILES`, `"maxFiles"`, action input `max-files`). Default: no limit. Files are picked in this order: source code first, then tests (`test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`, `*_test.*`), then docs and config (`docs/`, `*.md`, `*.txt`, `*.json`, `*.yml`, `*.toml`, ...). Within each group, files with the most added lines go first. The chosen files are reviewed and reported in the PR's order; the rest are listed in the summary as `over --max-files N`. For the action on a busy repo, `max-files: 100` is a sensible cap.
- **`--max-chunks-per-file N`** reviews at most the first N pieces of any one file (`REVIEWBUDDY_MAX_CHUNKS_PER_FILE`, `"maxChunksPerFile"`, action input `max-chunks-per-file`). Default: **10**; `0` means no limit. A big file's diff is split into pieces that fit the model's prompt (16,000 characters each on Ollama, up to 60,000 on cloud providers). Ten pieces cover a few thousand changed lines, which is more than nearly any hand-written change. A file past that is almost always generated, vendored or a data dump, and could otherwise eat the whole run on its own. Such a file is listed in the summary as `partly reviewed: the first 10 of 37 parts`; its findings from the reviewed parts are kept.
- **Inline comments.** GitHub documents no maximum number of comments per review, but a review with hundreds of them is slow to post, may be refused, and buries the important findings. So reviewbuddy posts at most **50** inline comments, the most severe first (`security`, then `bug`, `performance`, `suggestion`; ties in file order). It lists the rest in the review summary, with file and line. Everything still goes in one review, rather than several that would each notify the author and count against GitHub's limit on content created per minute. If the summary itself would pass GitHub's size limit for a review body (65,536 characters), it is cut at a line break with a note. The job summary, `--output`, JSON and SARIF always have every finding.

## Run it on every pull request

reviewbuddy is also a GitHub Action. Add this file to the repo you want reviewed as `.github/workflows/reviewbuddy.yml`:

```yaml
name: reviewbuddy

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

# A new push cancels the review still running for the previous one.
concurrency:
  group: reviewbuddy-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: fernandesnaycaden-debug/reviewbuddy@v1
        with:
          provider: groq
          api-key: ${{ secrets.GROQ_API_KEY }}
          fail-on: security
```

Then add the API key as a secret: in the repo, go to **Settings → Secrets and variables → Actions → New repository secret**, name it `GROQ_API_KEY` (or whatever the workflow refers to) and paste the key. The workflow passes it to the action; it never appears in logs.

Every time a PR is opened, gets new commits, is reopened or is marked ready for review, the action reviews it and posts a review just like the CLI does, including [reviewing only the new commits](#running-it-again-on-the-same-pr). Drafts are skipped. On top of that:

- The full Markdown report appears on the run's summary page.
- Each finding is also an annotation: `security` and `bug` as errors, `performance` and `suggestion` as warnings. They show on the run page and next to the code in the PR's **Files changed** tab. A multi-line finding's annotation spans its lines.
- With `fail-on`, the check fails when a finding of a listed severity is still in the PR (see [Fail on certain findings](#fail-on-certain-findings)).
- With `request-changes-on`, the review requests changes when a new finding has a listed severity, and reviewbuddy dismisses that review once it no longer applies (see [Blocking merges](#blocking-merges)).

No checkout step is needed: the action downloads the PR's diff and the changed files from the GitHub API. The `contents: read` permission in the example workflow covers the files.

| Input | Default | Meaning |
|-------|---------|---------|
| `provider` | none (required) | `groq`, `openrouter`, `gemini` or `anthropic`. `ollama` works only with `OLLAMA_URL` set to a server the runner can reach |
| `api-key` | empty | API key for that provider; pass it from a secret |
| `model` | empty: the file's `model` if it names the same provider, else the provider's default | Model to use, like that provider's `*_MODEL` variable |
| `fail-on` | empty: the file's `failOn`, else never fails | Comma-separated severities that fail the check, like `--fail-on` |
| `request-changes-on` | empty: the file's `requestChangesOn`, else comment only | Comma-separated severities that make the review request changes, like `--request-changes-on`. It never approves |
| `min-severity` | empty: the file's `minSeverity`, else report everything | Least serious severity to report: `security`, `bug`, `performance` or `suggestion`, like `--min-severity` |
| `ignore` | empty | Extra comma-separated file patterns to skip, like `--ignore`. Added to the defaults and the file's `ignore` |
| `full` | `false` | `true` reviews the whole PR every time, like `--full` |
| `timeout` | empty: the file's `timeout`, else the provider's default | Seconds a single model request may take (`0` = no limit), like `--timeout` |
| `concurrency` | empty: the file's `concurrency`, else the provider's default (2 for `groq` and `openrouter`, 4 for `gemini` and `anthropic`) | Files to review at once, 1 to 16, like `--concurrency`; see [Large pull requests](#large-pull-requests) |
| `max-files` | empty: the file's `maxFiles`, else no limit | Review at most this many files, like `--max-files` |
| `max-chunks-per-file` | empty: the file's `maxChunksPerFile`, else `10` | Review at most this many pieces of one file (`0` = no limit), like `--max-chunks-per-file` |
| `config` | `true` | `false` ignores the repo's `.reviewbuddy.json` and `.reviewbuddy.md`, like `--no-config` |
| `sarif-file` | empty (no file) | Also write the findings as SARIF to this path, for [Code Scanning](#upload-findings-to-code-scanning). Implies `full` |
| `github-token` | `${{ github.token }}` | Token used to read the PR, post the review and dismiss reviewbuddy's own outdated change requests. Needs `pull-requests: write` |

"The file" is the reviewed repo's `.reviewbuddy.json`.

The action has one output, `sarif-file`: the SARIF file's path when `sarif-file` was set and the file was written, empty otherwise.

The action also reads the repo's [`.reviewbuddy.json` and `.reviewbuddy.md`](#configure-per-repository) from the PR's base branch. A non-empty input overrides the same setting in the file; an empty one leaves the file's value in place.

The action only runs on `pull_request` events; under any other trigger it stops with an error.

### Pull requests from forks

GitHub doesn't give workflows on pull requests from forks any secrets, and their `GITHUB_TOKEN` is read-only. Dependabot PRs are treated the same way. So for such a PR:

- **No API key:** the action prints a warning that it skipped the review and passes. A maintainer can review the PR with the CLI instead.
- **A key is available but the token is read-only:** the review runs and the findings appear in the run's summary and annotations, but the review can't be posted on the PR. The action warns about that instead of failing; `fail-on` still applies.

### Block merging on findings

This makes the check fail. For blocking through the review instead, and how the two compare, see [Blocking merges](#blocking-merges).

1. Set `fail-on` in the workflow, for example `fail-on: security,bug`.
2. Let the workflow run once on a PR, so GitHub knows the check.
3. In **Settings → Branches** (or **Rules → Rulesets**), protect your main branch and add **Require status checks to pass**, choosing the `review` check.

A PR with an open finding of a listed severity can then not be merged until the flagged line is fixed (or an admin bypasses the rule). A draft PR's skipped run doesn't block anything; the review runs once it is marked ready.

### Upload findings to Code Scanning

Set `sarif-file` and add an upload step, and the findings also show up as Code Scanning alerts: in the PR's checks and **Files changed** tab, and under **Security → Code scanning**.

```yaml
name: reviewbuddy

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  security-events: write   # needed to upload SARIF

jobs:
  review:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      # Lets the upload match alerts to the source files.
      - uses: actions/checkout@v4
      - id: reviewbuddy
        uses: fernandesnaycaden-debug/reviewbuddy@v1
        with:
          provider: groq
          api-key: ${{ secrets.GROQ_API_KEY }}
          fail-on: security
          sarif-file: reviewbuddy.sarif
      - uses: github/codeql-action/upload-sarif@v3
        # Also after fail-on fails the review step, but not when the review was skipped.
        if: ${{ always() && steps.reviewbuddy.outputs.sarif-file != '' }}
        with:
          sarif_file: ${{ steps.reviewbuddy.outputs.sarif-file }}
          category: reviewbuddy
```

- The job needs **`security-events: write`** to upload.
- Code Scanning is free on public repositories. On **private repositories it requires GitHub Advanced Security** (GitHub Code Security); without it, the upload step fails, though the review itself still runs and posts.
- Code Scanning treats each upload as the complete list for the PR, and closes alerts that are missing from it. So `sarif-file` implies `full`: every run reviews the whole PR, not just the new commits, which means more model calls per push. Findings that are already posted as comments are still not posted again.
- On a fork PR without an API key the review is skipped, no file is written, the output stays empty, and the upload step is skipped too.

The CLI writes the same file locally with `--format sarif` or `-o results.sarif`, for VS Code's SARIF Viewer or any other SARIF tool.

## Versions

Pick how closely your workflow follows new releases:

| `uses:` | What you get |
|---------|--------------|
| `fernandesnaycaden-debug/reviewbuddy@v1` | The latest 1.x release. The `v1` tag moves with each release, so you get fixes and new features without breaking changes |
| `fernandesnaycaden-debug/reviewbuddy@v1.0.0` | Exactly that release, until you change it |
| `fernandesnaycaden-debug/reviewbuddy@<full commit SHA>` | The most secure option: a commit SHA can't be moved to other code, while a tag can. Add the version as a comment (`# v1.0.0`), and Dependabot can keep it up to date |

What changed in each release is in [CHANGELOG.md](CHANGELOG.md).

## Blocking merges

reviewbuddy has two ways to keep a PR with serious findings from being merged. Both are off by default, and you can use either or both.

| | `--request-changes-on` | `--fail-on` |
|-|------------------------|-------------|
| What it does | Posts the review as **Request changes** instead of a comment when a new finding has a listed severity | Exits with code 1, a failed check, while a finding of a listed severity is still in the PR |
| What blocks the merge | Branch protection (or a ruleset) with **Require a pull request before merging** and required approvals: a change request blocks until it is dismissed | Branch protection (or a ruleset) with **Require status checks to pass**, choosing the `review` check |
| Clears when | reviewbuddy dismisses its change request ([rule below](#how-a-change-request-is-cleared)), or someone with write access dismisses it | A later run finds no open finding of those severities |
| With the Actions token | GitHub doesn't clearly document whether a change request from `github-actions[bot]` counts toward review requirements. Check it on your repo, or post with a GitHub App or machine-user token | Reliable: a required check doesn't depend on who ran it |

Which to use:

- **`fail-on` with a required status check** is the dependable gate. Use it when a finding must stop the merge.
- **`request-changes-on`** marks the PR **Changes requested** with the findings at the top, in the PR list and for every reviewer. Use it as a strong signal, or as the gate when the reviewing account's reviews count toward your rules.
- **Both**, for example `request-changes-on: security,bug` with `fail-on: security`, give a visible review and a hard check.

reviewbuddy **never approves** a PR: it can point out problems, but finding none doesn't prove the code is right.

```yaml
      - uses: fernandesnaycaden-debug/reviewbuddy@v1
        with:
          provider: groq
          api-key: ${{ secrets.GROQ_API_KEY }}
          request-changes-on: security,bug
          fail-on: security
```

The review requests changes when any finding it posts, inline or in the summary, has a listed severity. Findings that were already posted earlier don't make a new change request; the earlier one still stands.

### How a change request is cleared

GitHub keeps a change request blocking until it is dismissed, even after the code is fixed ("Dismiss stale pull request approvals" only covers approvals). So whenever `--request-changes-on` is set, each run looks for reviewbuddy's own earlier reviews (by the hidden marker) that are still **Changes requested**, and dismisses one, with a short message, when it no longer applies:

1. **Nothing is dismissed** if this run found a finding of a listed severity (new, or posted before and found again), or a file couldn't be reviewed.
2. After a **`--full` run** that reviewed every file and found no blocking issue, every earlier change request is dismissed.
3. **Otherwise** a change request is dismissed only if every blocking inline comment it posted is now outdated (GitHub reports no current line for a comment whose code changed) and its summary lists no blocking finding. Findings listed only in the summary (outside the diff, or over the inline limit) can't be tracked, so such a review keeps blocking until a `--full` run.

When in doubt it keeps blocking: a stale block is easier to clear by hand than a wrong "all clear". A kept one is reported as `Keeping 1 earlier change request by reviewbuddy`. Resolving a conversation doesn't count; changing the code under it does. Only reviews with the marker are touched, never a person's. Without `--request-changes-on` nothing is dismissed, so after turning it off, dismiss old change requests by hand.

`--dry-run` prints the event the review would use, and `Would dismiss reviewbuddy's change request #...` instead of dismissing anything.

### Permissions for blocking

- **GitHub Actions:** `permissions: pull-requests: write`, as in the example workflow, covers requesting changes and dismissing the review. On a fork PR the token is read-only: the review isn't posted (see [Pull requests from forks](#pull-requests-from-forks)), and a dismissal only prints a warning.
- **Fine-grained token:** Pull requests → **Read and write**. GitHub requires write for both creating a review and dismissing one.
- **Protected branches:** with **Restrict who can dismiss pull request reviews**, only admins and the people, teams or apps on that list can dismiss. Add the token's user or app, or dismiss by hand. reviewbuddy warns (`Could not dismiss reviewbuddy's earlier change request ...`) and carries on; the run doesn't fail.
- **Your own PR:** GitHub doesn't let anyone request changes on their own PR. When you run reviewbuddy locally with your token on your own PR, it posts the review as a comment instead and warns. In Actions the token is the bot's, so this doesn't come up.

## Configure per repository

A repository that gets reviewed can carry its own settings and review rules in two files at its root:

- **`.reviewbuddy.json`**: settings, the same ones as the flags and variables below.
- **`.reviewbuddy.md`**: project-specific review rules, added to the model's instructions.

Both are optional, and a missing file is not an error. [examples/](examples/) has a sample of each to copy.

### `.reviewbuddy.json`

```json
{
  "provider": "groq",
  "model": "openai/gpt-oss-120b",
  "ignore": ["src/generated/", "*.pb.js", "fixtures/"],
  "minSeverity": "bug",
  "failOn": ["security", "bug"],
  "requestChangesOn": ["security"],
  "timeout": 120
}
```

| Key | Type | Same as | Meaning |
|-----|------|---------|---------|
| `provider` | string | `--provider`, `REVIEWBUDDY_PROVIDER` | `ollama`, `groq`, `openrouter`, `gemini` or `anthropic` |
| `model` | string | `GROQ_MODEL` etc., the action's `model` | Model for that provider. Needs `provider` in the same file, and is only used when that provider is the one selected |
| `ignore` | array of strings | `--ignore`, `REVIEWBUDDY_IGNORE` | Extra file patterns to skip (same pattern rules as `--ignore`) |
| `defaultIgnore` | boolean | `--no-default-ignore` | `false` stops skipping lockfiles, `dist/` etc. by default |
| `minSeverity` | string | `--min-severity`, `REVIEWBUDDY_MIN_SEVERITY` | Least serious severity to report |
| `failOn` | array of strings | `--fail-on`, `REVIEWBUDDY_FAIL_ON` | Severities that make the run exit with code 1 (fail the check) |
| `requestChangesOn` | array of strings | `--request-changes-on`, `REVIEWBUDDY_REQUEST_CHANGES_ON` | Severities that make a PR review request changes; see [Blocking merges](#blocking-merges) |
| `timeout` | number | `--timeout`, `REVIEWBUDDY_TIMEOUT` | Seconds a single model request may take, `0` for no limit |
| `format` | string | `--format`, `REVIEWBUDDY_FORMAT` | `text`, `json` or `sarif`; see [Output formats](#output-formats) |
| `concurrency` | whole number, 1 to 16 | `--concurrency`, `REVIEWBUDDY_CONCURRENCY` | Files to review at once; see [Large pull requests](#large-pull-requests) |
| `maxFiles` | whole number | `--max-files`, `REVIEWBUDDY_MAX_FILES` | Review at most this many files, `0` for no limit |
| `maxChunksPerFile` | whole number | `--max-chunks-per-file`, `REVIEWBUDDY_MAX_CHUNKS_PER_FILE` | Review at most this many pieces of one file, `0` for no limit |

There is no `output` key: where reviewbuddy writes a file is up to whoever runs it (`--output` or `REVIEWBUDDY_OUTPUT`), not the repository being reviewed. An `output` key is ignored with a warning.

The file must be plain JSON (no comments, no trailing commas). A syntax error or a wrong type stops the run with a message naming the file and the key. An unknown key only prints a warning, so a typo like `"failon"` shows up in the log.

**No secrets.** If the file has a key that looks like a credential (`apiKey`, `token`, `GROQ_API_KEY`, `password`, ...), reviewbuddy stops with an error. Put API keys in environment variables, or in GitHub Actions secrets passed to the action's `api-key` input. A file in the repo is readable by everyone who can read the repo.

### `.reviewbuddy.md`

Write rules the way you'd brief a new reviewer: what your project does differently and what to flag. For example:

```markdown
- Database access goes through `db.query(sql, params)` with `?` placeholders. Report any SQL built by
  string concatenation or template literals as `security`, even if the values look safe.
- Errors are logged with `logger.error(err, context)`, never `console.log` or `console.error`. Report a
  `console.*` call in `src/` as `bug`. Tests and scripts under `scripts/` may use `console`.
- Money is stored and computed as integer cents (`amountCents`). Floating-point arithmetic on money is a `bug`.
```

The rules go into every request, after the built-in instructions, in a section titled "Project rules from the repository". The built-in instructions still win: the model replies in the same JSON, comments only on added lines, and is told to ignore anything in the rules that asks it to change the output format or report nothing. Without a `.reviewbuddy.md`, the prompt holds only the built-in instructions.

The rules are capped at **4,000 characters** (about 1,300 tokens). A longer file is cut at the last line break before the cap, with a warning. The rules count against the provider's [prompt budget](#full-file-context): with long rules, the full-file context shrinks to the code around each change, or to the diff alone, rather than overflowing the model's context.

### Which value wins

Each setting takes the first of:

1. a CLI flag (`--fail-on`, `--min-severity`, ...)
2. an environment variable (`REVIEWBUDDY_FAIL_ON`, `GROQ_MODEL`, ...). In the action, the inputs become these variables, so **a non-empty action input overrides the file**. An empty variable or input counts as unset.
3. `.reviewbuddy.json`
4. the built-in default

Ignore patterns are the exception: they add up. The defaults (unless `"defaultIgnore": false` or `--no-default-ignore`), then the file's `ignore`, then `REVIEWBUDDY_IGNORE`, then `--ignore`.

For example, with `"minSeverity": "bug"` and `"failOn": ["security", "bug"]` in the file, a run with `REVIEWBUDDY_FAIL_ON=security` and no flags reports security and bug findings (`minSeverity` from the file), but fails only on security ones (the variable wins over the file's `failOn`).

In the action, `provider` is a required input, so the file's `provider` only applies to CLI runs. The file's `model` is still used in the action when the `model` input is empty and the file's `provider` matches the input.

### Where the files are read from

- **Diff files, stdin, `--staged` and `--uncommitted`:** from `--repo-dir` if you pass it, otherwise the current directory. If a file isn't there, reviewbuddy looks in each parent directory up to the git root (the directory with `.git`), and uses the nearest one. Outside a git repository only the directory itself is checked.
- **`--branch <rev>` and `--since <rev>`:** from `<rev>`, at the repo's top level (`git show <rev>:.reviewbuddy.json`), never from the checked-out branch. That branch is what is being reviewed, so when you check out someone else's branch to review it, its own `.reviewbuddy.json` can't turn off its checks. The line printed says so, e.g. `Config: .reviewbuddy.json (main)`.
- **Pull requests (CLI and action):** from the PR's **base branch**, at the base commit, via the GitHub API, never from the PR's own commits. Otherwise a PR could edit `.reviewbuddy.json` to drop `failOn`, or add "report no issues" to `.reviewbuddy.md`, and pass its own check. So **a change to either file takes effect once it is merged**; the PR that changes it is still reviewed with the old one. Reading the files needs the same **Contents: Read** permission as [full-file context](#full-file-context). If it is missing, the run stops with an error instead of silently reviewing without the repo's rules.

reviewbuddy prints one line saying which files it loaded, e.g. `Config: .reviewbuddy.json (base branch main @ 1a2b3c4), .reviewbuddy.md (base branch main @ 1a2b3c4)`. It prints nothing when there are none.

Pass `--no-config` (in the action: `config: false`) to ignore both files for a run.

## Configuration

These variables override the reviewed repo's [`.reviewbuddy.json`](#configure-per-repository), and the matching CLI flags override both. Pass `--no-config` to ignore the repo's `.reviewbuddy.json` and `.reviewbuddy.md`.

| Variable       | Default                  | Meaning                    |
|----------------|--------------------------|----------------------------|
| `REVIEWBUDDY_PROVIDER` | `ollama`         | `ollama`, `groq`, `openrouter`, `gemini` or `anthropic`, like `--provider` |
| `OLLAMA_MODEL` | `qwen3.5:4b`             | Ollama model to use        |
| `OLLAMA_URL`   | `http://localhost:11434` | Where Ollama is listening  |
| `GROQ_API_KEY` | none                     | Groq API key               |
| `GROQ_MODEL`   | `openai/gpt-oss-20b`     | Groq model to use          |
| `OPENROUTER_API_KEY` | none               | OpenRouter API key         |
| `OPENROUTER_MODEL` | `openrouter/free`    | OpenRouter model to use    |
| `GEMINI_API_KEY` | none                   | Gemini API key             |
| `GEMINI_MODEL` | `gemini-3.8-flash`       | Gemini model to use        |
| `ANTHROPIC_API_KEY` | none                | Anthropic API key          |
| `ANTHROPIC_MODEL` | `claude-opus-5-5`     | Claude model to use        |
| `GITHUB_TOKEN` | none                     | Token used to read PRs, post reviews and dismiss reviewbuddy's own outdated change requests |
| `REVIEWBUDDY_IGNORE` | none               | Extra comma-separated patterns to skip, like `--ignore` |
| `REVIEWBUDDY_FAIL_ON` | none              | Comma-separated severities that make the run exit with code 1, like `--fail-on` |
| `REVIEWBUDDY_REQUEST_CHANGES_ON` | none (comment only) | Comma-separated severities that make a PR review request changes, like `--request-changes-on` |
| `REVIEWBUDDY_MIN_SEVERITY` | none (report everything) | Least serious severity to report (`security` > `bug` > `performance` > `suggestion`), like `--min-severity` |
| `REVIEWBUDDY_TIMEOUT` | `600` (Ollama), `300` (cloud) | Seconds a single model request may take, like `--timeout`. `0` means no limit |
| `REVIEWBUDDY_FORMAT` | `text` (or from `--output`'s extension) | `text`, `json` or `sarif`, like `--format` |
| `REVIEWBUDDY_OUTPUT` | none (or `review.md` via `npm run review`) | Write results to a file, like `--output` |
| `REVIEWBUDDY_CONCURRENCY` | `1` (Ollama), `2` (Groq, OpenRouter), `4` (Gemini, Anthropic) | Files to review at once, 1 to 16, like `--concurrency` |
| `REVIEWBUDDY_MAX_FILES` | none (no limit) | Review at most this many files, like `--max-files` |
| `REVIEWBUDDY_MAX_CHUNKS_PER_FILE` | `10` | Review at most this many pieces of one file, like `--max-chunks-per-file`. `0` means no limit |
| `REVIEWBUDDY_REVIEWER` | none | Login of the account reviewbuddy posts as, when that isn't the token's user or `github-actions[bot]` (a GitHub App's `name[bot]`). Only its reviews' markers count; see [Running it again on the same PR](#running-it-again-on-the-same-pr) |

Pass `--timeout <seconds>` to override `REVIEWBUDDY_TIMEOUT` for one run, for example `npm run review -- changes.diff --timeout 1200` for a slow model.

`--repo-dir <path>` says which repository the git flags run in, and where diff files and stdin read the changed files for [full-file context](#full-file-context). It defaults to the current directory and has no variable.

| Flag | Meaning |
|------|---------|
| `--staged`, `--uncommitted`, `--branch <base>`, `--since <rev>` | Review local git changes; see [Review your own changes](#review-your-own-changes) |
| `-` (as the target) | Read the diff from stdin |
| `--format text\|json\|sarif` | How to write the results; see [Output formats](#output-formats) |
| `--output <file>`, `-o` | Write the results to a file instead of (JSON, SARIF) or as well as (text) the terminal |
| `--concurrency <n>` | Review up to n files at once; see [Large pull requests](#large-pull-requests) |
| `--max-files <n>` | Review at most n files, source files and the biggest changes first |
| `--max-chunks-per-file <n>` | Review at most the first n pieces of any one file (`0` = no limit) |
| `--request-changes-on <severities>` | On a PR, request changes instead of commenting when a posted finding has one of these severities; see [Blocking merges](#blocking-merges) |

With the default Claude models (Opus 5.5, Sonnet 5.5, Opus 5, Fable 5.1), reviewbuddy turns on Anthropic's server-side refusal fallback. If a safety classifier declines to review a piece of code, another Claude model finishes the request. A piece that is still declined, or that Gemini blocks, is skipped with a warning.

Network errors and HTTP 429/5xx responses from GitHub, Ollama and the cloud providers are retried up to 3 times with backoff (1s, 2s, 4s, or whatever `Retry-After` asks for, up to 60s). A rate limit (429, or GitHub's 403 secondary rate limit) also pauses every other request to the same host for that long, so files reviewed in parallel wait together. Posting the review is only retried after a rate limit, so a PR never gets the same review twice. GitHub requests time out after 30 seconds.

## Tests

```powershell
npm test
```

The tests cover diff parsing, line numbering, chunking, the ignore list, reply parsing, full-file context (the full file, the windows around each hunk, the budget cutoff, files that don't match the diff, fetching files at the head commit, `--repo-dir` and paths outside it), `--min-severity` and how it interacts with `--fail-on`, suggested fixes (parsing, validation, indentation, the suggestion block in posted comments, the report's Fix line), multi-line findings (`endLine` parsing, the 20-line cap, the same-hunk rule, `start_line`/`line` in posted comments, block suggestions and their indentation, re-runs not posting a range again, ranges in every output format), requesting changes (the event choice, never approving, the own-PR fallback, the dismissal rule, a refused dismissal, `--dry-run`), each provider's prompt budget, retries and timeouts, the GitHub client (including pagination and compare diffs), large pull requests (the HTTP 406 fallback to the files API with pagination, files without a patch, the 3,000-file note, building per-file diffs from patches with the same line numbers as from a diff, the compare API fallback and its 300-file cap, the worker pool's limit, ordering and error isolation, output kept in file order while files finish out of order, a failing file not losing the others, errors that stop the run, `Retry-After` and the pause shared across requests to one host, each provider's default concurrency, `--max-files` ordering and the 50-comment inline cap), review markers and skipping findings already posted, re-runs (same commit, new commits, force-push fallback, `--full`), splitting findings between inline comments and the review body, the Markdown report, `--fail-on` and exit codes, GitHub Actions annotations (and their escaping), the job summary, fork PRs without a key or with a read-only token, a full run with GitHub and Ollama mocked, per-repository config (validation, secret rejection, unknown keys, which value wins for each setting, ignore-pattern merging, finding the files up to the git root, reading them from the PR's base commit, `--no-config`, the rules cap and its effect on the context budget, and the prompt staying unchanged without rules), each cloud provider's requests, replies and errors (provider selection, missing keys, schema fallback, 401/404/429), the git flags (the git arguments for each mode, rejecting revisions that start with `-`, missing git, not a repository, unknown revisions, nothing to review, and, in temporary git repositories, that each mode reads its context from the index, the working tree or HEAD), reading stdin, UTF-8 byte order marks and UTF-16 diffs, choosing the format from `--format` or the extension, stdout holding only the document in JSON and SARIF modes (checked by running the CLI in a child process), the JSON document's shape, and the SARIF log's structure and level mapping (checked by hand against the essentials of the 2.1.0 schema). They need neither Ollama, API keys nor network access; the git tests are skipped if git isn't installed.

## Expected output

The sample [samples/buggy.diff](samples/buggy.diff) contains three planted bugs:
| Line | Bug |
|------|-----|
| 4    | Hardcoded API key |
| 15   | SQL injection (string concatenation into a query) |
| 22   | Off-by-one loop (`i <= numbers.length`) |

A good run looks roughly like this. The wording and timing depend on the model and the machine:

```
Reviewing 1 file with concurrency 1

Reviewed src/services/orders.js (1/1)
  src/services/orders.js:4 [SECURITY] Hardcoded API key; load it from an environment variable.
  src/services/orders.js:15 [SECURITY] SQL injection from string concatenation; use a parameterized query.
  src/services/orders.js:22 [BUG] Off-by-one; `<=` reads past the end of the array, so the total is NaN.

3 issues in 1 file. Review took 14.2s
```

There is no copy of `src/services/orders.js` next to the diff, so this sample is always reviewed from the diff alone.

### Measuring false positives

[samples/context-trap.diff](samples/context-trap.diff) adds two functions to [samples/context-trap/src/services/users.js](samples/context-trap/src/services/users.js):

| Line | What it is | A good review |
|------|------------|---------------|
| 41 | `user.name.toUpperCase()` on a user from `getUser(id)`. In the hunk it looks unchecked, but `getUser`, higher up in the same file, throws when the user is missing or has no name. | Says nothing |
| 46 | Off-by-one loop: `let i = 1` skips the first name | Reports a bug, ideally with `fix: for (let i = 0; ...` |

Run it twice, without and with the file for context, and compare:

```powershell
npm run review -- samples/context-trap.diff                                    # before: diff only
npm run review -- samples/context-trap.diff --repo-dir samples/context-trap   # after: with the full file
```

The first run can't see `getUser`, so models often flag line 41 as a possible null. The second run should only report line 46 and print `with the full file as context`. Try it with your usual provider and model, and run `samples/buggy.diff` too, to check that all three planted bugs are still found. Results vary from run to run, so run each a few times before drawing conclusions.

## Troubleshooting

| Message | Fix |
|---------|-----|
| `Could not connect to Ollama` | Start Ollama (open the app, or run `ollama serve`). |
| `Ollama returned HTTP 404 ... isn't installed` | `OLLAMA_MODEL` isn't set to a model you have. Check `ollama list`. |
| `model returned invalid JSON` | The model replied with something that isn't JSON. It retries once; if it fails again, try a larger model. |
| `Ollama didn't finish within 600s` | The model is too slow on this machine. Try a smaller model, or raise `--timeout`. |
| `... retrying in 2.0s (1/3)` | A network error or a busy server. reviewbuddy retries on its own; it only fails if every retry does. |
| `Unknown provider "..."` | Use one of `ollama`, `groq`, `openrouter`, `gemini`, `anthropic` in `--provider`, `REVIEWBUDDY_PROVIDER` or `.reviewbuddy.json`. |
| `Set GROQ_API_KEY to use Groq` (or another `*_API_KEY`) | The provider you picked needs a key. Set it with `$env:GROQ_API_KEY = "..."`, or pick another provider. |
| `Groq returned HTTP 401 (Groq rejected the API key ...)` | The key is wrong, expired or revoked (also shown for HTTP 403). Create a new one. |
| `... returned HTTP 404 (model "..." not found ...)` | The `*_MODEL` variable names a model that provider doesn't offer. Unset it to use the default, or check the provider's model list. |
| `... returned HTTP 429 (rate limited ...)` | You hit the free tier's per-minute or daily limit. reviewbuddy already retried. Wait, lower `--concurrency`, review a smaller diff, or switch provider. |
| `OpenRouter returned HTTP 402` | Your OpenRouter balance is used up. Add credits, or use a free model. |
| `... didn't reply within 300s` | The cloud model is slow or overloaded. Raise `--timeout`, or pick a faster model. |
| `Retrying without the JSON schema, in plain JSON mode` | Only a warning: the model doesn't support structured output, so reviewbuddy uses plain JSON mode for it. |
| `Set GITHUB_TOKEN to post a review` | Set `$env:GITHUB_TOKEN`, or add `--dry-run`. |
| `GitHub returned HTTP 401` | The token is wrong or expired. Create a new one. |
| `GitHub returned HTTP 403` | The token doesn't have Pull requests: Read and write on that repo. |
| `GitHub returned HTTP 404` | Check the PR URL. For a private repo, the token must include that repo. |
| `The diff is too large for GitHub's diff format, reading the changed files page by page instead` | Not an error: the PR is too big for GitHub's diff format, so reviewbuddy uses the files API instead. See [Large pull requests](#large-pull-requests). |
| `not reviewed: too large for the GitHub API` | GitHub sent no diff for that one file because it is too large. Review it locally (`--branch <base>` in a checkout of the PR), or split the change. |
| `GitHub's files API lists at most 3000 files` | The PR changes more than 3,000 files and GitHub won't list the rest. Split the PR, or review it locally with `--branch <base>`. |
| `Too many changes since abc1234 for GitHub's compare API` | Not an error: more than 300 files changed since the last review, so reviewbuddy reviews the whole PR instead. Findings already posted are still skipped. |
| `... rate limited (HTTP 429), pausing requests to it for ...` | Not an error: the API asked reviewbuddy to slow down, so every request to it waits. If it happens a lot, lower `--concurrency`. |
| `Incomplete: 2 files could not be reviewed` | Those files failed after every retry (each one's error is printed above). The other files were reviewed and posted, but the run exits with code 1. Run it again; the next run retries them. For repeated rate limits, lower `--concurrency`; for timeouts, raise `--timeout`. |
| `partly reviewed: the first 10 of 37 parts` | That file's diff is very large, so only its first pieces were reviewed. Raise `--max-chunks-per-file` (or set it to `0`), or add the file to `ignore` if it is generated. |
| `over --max-files N` | Not an error: the PR has more files than `--max-files`. Raise it, or remove it for no limit. |
| `Invalid value "..." in --concurrency` | Give a whole number from 1 to 16 (`--max-files` and `--max-chunks-per-file` take any whole number, `0` for no limit). |
| `Already reviewed abc1234, nothing new` | Not an error: the PR's head commit already has a reviewbuddy review. Push new commits, or add `--full` to review it again. |
| `Previous review's commit abc1234 no longer exists ... reviewing the whole PR` | The branch was force-pushed or rebased, so there's nothing to diff against. reviewbuddy reviews the whole PR instead; findings already posted are still skipped. |
| `No new findings to post.` | Not an error: the new commits had no issues, or every finding was already posted. Nothing was posted. |
| `Unknown severity "..." in --fail-on` | Use only `bug`, `security`, `performance` and `suggestion`, separated by commas, in `--fail-on`, `REVIEWBUDDY_FAIL_ON` or the action's `fail-on` input. |
| `Unknown severity "..." in --min-severity` | Use exactly one of `security`, `bug`, `performance` or `suggestion` in `--min-severity`, `REVIEWBUDDY_MIN_SEVERITY` or the action's `min-severity` input. |
| `--fail-on ... has no effect with --min-severity ...` | Only a warning: those findings are left out before `--fail-on` sees them. Lower `--min-severity` or drop them from `--fail-on`. The same goes for `--request-changes-on`. |
| `Unknown severity "..." in --request-changes-on` | Use only `bug`, `security`, `performance` and `suggestion`, separated by commas, as for `--fail-on`. |
| `GitHub doesn't let anyone request changes on their own pull request ... posted as a comment instead` | Only a warning: the token belongs to the PR's author. Use another account's token, or let the action review the PR. |
| `Could not dismiss reviewbuddy's earlier change request #...` | Only a warning: that change request still blocks. Give the token Pull requests: Read and write. With "Restrict who can dismiss pull request reviews", add its user or app to the list, or dismiss the review by hand. |
| `Keeping 1 earlier change request by reviewbuddy` | Not an error: a blocking finding is still in the code, or was listed only in the review summary. Fix it, run once with `--full` to re-check everything, or dismiss the review by hand. See [How a change request is cleared](#how-a-change-request-is-cleared). |
| The PR still shows **Changes requested** after turning `request-changes-on` off | reviewbuddy only dismisses its reviews while the setting is on. Dismiss the old review by hand: on the review, **...** → **Dismiss review**. |
| `Could not fetch ... for context ... The token needs "Contents: Read"` | Only a warning: that file is reviewed from the diff alone. Give the token Contents → Read access. |
| `... doesn't match the diff (another version checked out?)` | Only a warning: the local file isn't the diff's new version. Check out the branch the diff came from, or point `--repo-dir` at it. |
| `--repo-dir ... is not a directory` | Check the path passed to `--repo-dir`. |
| `Review one thing at a time` | Pass only one of `--staged`, `--uncommitted`, `--branch`, `--since`, a diff file, a PR URL or `-`. |
| `git isn't installed, or isn't on PATH` | Install [git](https://git-scm.com/), or review a diff file instead. |
| `... is not inside a git repository` | Run reviewbuddy inside the project, or pass `--repo-dir <path to the repo>`. |
| `git doesn't know the revision "..."` | Check the branch, tag or commit you passed to `--branch` or `--since` (`git branch -a`, `git log --oneline`). For `HEAD`, the repo needs at least one commit. |
| `--since "..." is not a revision: it can't start with "-"` | A revision is never an option. Check what you passed to `--branch` or `--since`. |
| `Nothing to review: no staged changes` (or similar) | Nothing matched that flag. Stage changes with `git add`, use `--uncommitted`, or commit first for `--branch` and `--since`. New untracked files need `git add` or `git add -N`. |
| `No diff on stdin` | `-` reads a piped diff, but nothing was piped in. Use `git diff \| reviewbuddy -`, or a git flag. |
| `Unknown format "..."` | Use `text`, `json` or `sarif` in `--format`, `REVIEWBUDDY_FORMAT` or `"format"` in `.reviewbuddy.json`. |
| Non-ASCII text shows up as `?` | Windows PowerShell 5.1 re-encodes text piped into node. Use a git flag or a diff file instead of a pipe. |
| Code Scanning upload fails on a private repo | Code Scanning on private repositories requires GitHub Advanced Security. The job also needs `permissions: security-events: write`. |
| `Invalid JSON in .reviewbuddy.json ...` | Fix the syntax. The file is plain JSON: no comments, no trailing commas, keys in double quotes. |
| `"failOn" in .reviewbuddy.json must be ...` (or another key) | The key has the wrong type. See the [key reference](#reviewbuddyjson). |
| `.reviewbuddy.json must not contain secrets` | Remove the key and set it as an environment variable or an Actions secret instead. If the key was ever committed, rotate it. |
| `Warning: unknown key "..." in .reviewbuddy.json` | Only a warning: the key is ignored. Check its spelling against the [key reference](#reviewbuddyjson). |
| `Warning: .reviewbuddy.md is ... characters` | Only a warning: only the first 4,000 characters are used. Shorten the rules. |
| `Could not read .reviewbuddy.json from the base branch ... "Contents: Read"` | Give the token Contents → Read access, or pass `--no-config` (`config: false` in the action). |
| `Failing: 2 findings match --fail-on security` | Not a crash: findings of a severity you listed are still in the code, so the run exits with code 1. Fix the flagged lines, or change `--fail-on`. |
| `Ollama doesn't run on GitHub-hosted runners` | Set the action's `provider` input to `groq`, `openrouter`, `gemini` or `anthropic` and pass its `api-key` from a secret. |
| `Set GROQ_API_KEY ... In GitHub Actions, add the key as a repository secret` | The workflow didn't get a key. Add the secret (Settings → Secrets and variables → Actions) and check that `api-key:` names it exactly. |
| `Skipping the review: GitHub doesn't pass secrets to workflows on pull requests from forks` | Only a warning: see [Pull requests from forks](#pull-requests-from-forks). |
| `Could not post the review: on pull requests from forks the GitHub token is read-only` | Only a warning: the findings are on the run's summary page and in the annotations. |
| `GitHub returned HTTP 403` in Actions on your own PR | The workflow lacks `permissions: pull-requests: write`. |
| `reviewbuddy runs on pull_request events` | The workflow uses another trigger. Use `on: pull_request`, as in the example workflow. |
