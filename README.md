# reviewbuddy
AI code reviewer for GitHub PRs. Runs on local models (Ollama) or free cloud APIs.

It reviews a GitHub pull request and posts its findings as inline review comments, or reviews a local diff file and prints them. Running automatically on every PR (a GitHub Action) comes later.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (`node --version`)
- One model provider, either:
  - [Ollama](https://ollama.com/) 0.5 or newer running locally, with at least one model pulled (the default), or
  - an API key for a cloud provider: Groq, OpenRouter, Gemini or Anthropic (see [Choose a provider](#choose-a-provider))

No `npm install` is needed: the project has no dependencies.

## Run it without cloning

```powershell
npx reviewbuddy https://github.com/owner/repo/pull/12 --dry-run
npx reviewbuddy changes.diff
```

Until the package is on npm, run it straight from GitHub instead: `npx github:fernandesnaycaden-debug/reviewbuddy <pr-url or diff>`. Every option below works the same way; just swap `npm run review --` for `npx reviewbuddy`.

## Run it from a clone

```powershell
git clone https://github.com/fernandesnaycaden-debug/reviewbuddy.git
cd reviewbuddy

ollama list                                # check which models you have
$env:OLLAMA_MODEL = "qwen2.5-coder:7b"     # use a model name from that list
npm run review
```

`$env:OLLAMA_MODEL` only lasts for the current PowerShell window. On macOS/Linux use `OLLAMA_MODEL=qwen2.5-coder:7b npm run review`.

To review a different diff: `npm run review -- path/to/file.diff`

## Choose a provider

reviewbuddy uses Ollama unless you pick another provider with `REVIEWBUDDY_PROVIDER` or `--provider` (the flag wins). Cloud providers need no local model, just an API key.

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

Make a diff in the project you want reviewed, then point reviewbuddy at it. A diff can touch any number of files; each file is reviewed separately.

```powershell
cd C:\path\to\your-project
git diff --output=changes.diff                 # uncommitted changes
git diff main...my-branch --output=changes.diff  # everything on a branch

cd C:\path\to\reviewbuddy
npm run review -- C:\path\to\your-project\changes.diff
```

Use `--output=` rather than `git diff > changes.diff`: in Windows PowerShell 5.1, `>` writes UTF-16, which reviewbuddy can't read.

Files with no added lines (deleted files, pure renames, binary files) are skipped. So are files that aren't worth a model's time: lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`), `*.min.*`, `*.map`, `*.snap`, `*.svg`, and anything under `dist/`, `build/`, `vendor/` or `node_modules/`.

To skip more files, pass comma-separated patterns. A pattern ending in `/` matches a directory anywhere, a pattern without `/` matches a file name, and `*` matches anything except `/`:

```powershell
npm run review -- changes.diff --ignore "*.generated.ts,fixtures/"
npm run review -- changes.diff --no-default-ignore   # review lockfiles, dist/ etc. too
```

Large files are reviewed in several parts so they fit in the model's context window.

## Save the results to a file

Add `--output` (or `-o`) to write a formatted Markdown report alongside the terminal output:

```powershell
npm run review -- --output review-report.md
npm run review -- changes.diff -o report.md
```

The report includes a summary table, the model name, and per-file findings with severity badges. Every run overwrites the file.

## Review a GitHub pull request

Pass the PR's URL instead of a diff file. reviewbuddy downloads the diff, reviews each file, and posts one review on the PR with a comment on each problem line.

First create a token at GitHub → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new):

- **Repository access:** only the repos you want reviewed
- **Permissions:** Pull requests → **Read and write**

```powershell
$env:GITHUB_TOKEN = "github_pat_..."
npm run review -- https://github.com/owner/repo/pull/12
```

To see what would be posted without posting anything, add `--dry-run`. Public repos don't need a token for a dry run:

```powershell
npm run review -- https://github.com/owner/repo/pull/12 --dry-run
```

How the review looks on GitHub:

- It is a plain comment review. reviewbuddy never approves a PR or requests changes.
- Each finding is an inline comment like **[SECURITY]** Hardcoded API key; load it from an environment variable.
- The review summary says how many issues were found and which model found them. Findings that point at a line outside the diff can't be attached to that line, so they are listed in the summary instead.

### Running it again on the same PR

Each review ends with a hidden marker, `<!-- reviewbuddy:sha=... -->`, that records which commit it reviewed. On the next run reviewbuddy looks for the most recent review with that marker. It doesn't matter who posted it, so a personal token and the GitHub Actions bot share the same history.

- **No new commits since then:** it prints `Already reviewed abc1234, nothing new` and stops. No model is called.
- **New commits:** it reviews only the changes since the reviewed commit (GitHub's compare diff), limited to files the PR itself changes. The review summary says `since abc1234`.
- **The reviewed commit is gone** (after a force-push or rebase): it says so and reviews the whole PR.
- **A finding was already posted:** an inline comment from an earlier reviewbuddy review on the same file, line and severity is not posted again. The run prints how many it skipped.
- **Nothing new to post:** no review is posted, not even an empty one. This includes a first run that finds no issues at all, so the next run reviews from the last commit that did get a review (or the whole PR, if none did).

To ignore earlier reviews and review the whole PR again, add `--full`. Findings that are already posted are still skipped:

```powershell
npm run review -- https://github.com/owner/repo/pull/12 --full
```

`--dry-run` prints all of this too: which commit it would diff from, whether it fell back to a full review, how many findings it skipped, and the review it would post.

Known limits: matching is by line number, so a finding whose code moved is posted again on its new line. If the base branch was merged into the PR, the incremental diff includes those changes in files the PR also touches. Findings that went into an earlier review's summary (lines outside the diff) are not checked for duplicates.

## Configuration

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
| `GITHUB_TOKEN` | none                     | Token used to read PRs and post reviews |
| `REVIEWBUDDY_IGNORE` | none               | Extra comma-separated patterns to skip, like `--ignore` |
| `REVIEWBUDDY_TIMEOUT` | `600` (Ollama), `300` (cloud) | Seconds a single model request may take, like `--timeout`. `0` means no limit |

Pass `--timeout <seconds>` to override `REVIEWBUDDY_TIMEOUT` for one run, for example `npm run review -- changes.diff --timeout 1200` for a slow model.

With the default Claude models (Opus 5.5, Sonnet 5.5, Opus 5, Fable 5.1), reviewbuddy turns on Anthropic's server-side refusal fallback. If a safety classifier declines to review a piece of code, another Claude model finishes the request. A piece that is still declined, or that Gemini blocks, is skipped with a warning.

Network errors and HTTP 429/5xx responses from GitHub, Ollama and the cloud providers are retried up to 3 times with backoff (1s, 2s, 4s, or whatever `Retry-After` asks for). Posting the review is only retried after a 429, so a PR never gets the same review twice. GitHub requests time out after 30 seconds.

## Tests

```powershell
npm test
```

The tests cover diff parsing, line numbering, chunking, the ignore list, reply parsing, retries and timeouts, the GitHub client (including pagination and compare diffs), review markers and skipping findings already posted, re-runs (same commit, new commits, force-push fallback, `--full`), splitting findings between inline comments and the review body, the Markdown report, a full run with GitHub and Ollama mocked, and each cloud provider's requests, replies and errors (provider selection, missing keys, schema fallback, 401/404/429). They need neither Ollama, API keys nor network access.

## Expected output

The sample [samples/buggy.diff](samples/buggy.diff) contains three planted bugs:
| Line | Bug |
|------|-----|
| 4    | Hardcoded API key |
| 15   | SQL injection (string concatenation into a query) |
| 22   | Off-by-one loop (`i <= numbers.length`) |

A good run looks roughly like this. The wording and timing depend on the model and the machine:

```
Reviewing src/services/orders.js (1/1) ...
  src/services/orders.js:4 [SECURITY] Hardcoded API key; load it from an environment variable.
  src/services/orders.js:15 [SECURITY] SQL injection from string concatenation; use a parameterized query.
  src/services/orders.js:22 [BUG] Off-by-one; `<=` reads past the end of the array, so the total is NaN.

3 issues in 1 file. Review took 14.2s
```

## Troubleshooting

| Message | Fix |
|---------|-----|
| `Could not connect to Ollama` | Start Ollama (open the app, or run `ollama serve`). |
| `Ollama returned HTTP 404 ... isn't installed` | `OLLAMA_MODEL` isn't set to a model you have. Check `ollama list`. |
| `model returned invalid JSON` | The model replied with something that isn't JSON. It retries once; if it fails again, try a larger model. |
| `Ollama didn't finish within 600s` | The model is too slow on this machine. Try a smaller model, or raise `--timeout`. |
| `... retrying in 2.0s (1/3)` | A network error or a busy server. reviewbuddy retries on its own; it only fails if every retry does. |
| `Unknown provider "..."` | Use one of `ollama`, `groq`, `openrouter`, `gemini`, `anthropic` in `--provider` or `REVIEWBUDDY_PROVIDER`. |
| `Set GROQ_API_KEY to use Groq` (or another `*_API_KEY`) | The provider you picked needs a key. Set it with `$env:GROQ_API_KEY = "..."`, or pick another provider. |
| `Groq returned HTTP 401 (Groq rejected the API key ...)` | The key is wrong, expired or revoked (also shown for HTTP 403). Create a new one. |
| `... returned HTTP 404 (model "..." not found ...)` | The `*_MODEL` variable names a model that provider doesn't offer. Unset it to use the default, or check the provider's model list. |
| `... returned HTTP 429 (rate limited ...)` | You hit the free tier's per-minute or daily limit. reviewbuddy already retried. Wait, review a smaller diff, or switch provider. |
| `OpenRouter returned HTTP 402` | Your OpenRouter balance is used up. Add credits, or use a free model. |
| `... didn't reply within 300s` | The cloud model is slow or overloaded. Raise `--timeout`, or pick a faster model. |
| `Retrying without the JSON schema, in plain JSON mode` | Only a warning: the model doesn't support structured output, so reviewbuddy uses plain JSON mode for it. |
| `Set GITHUB_TOKEN to post a review` | Set `$env:GITHUB_TOKEN`, or add `--dry-run`. |
| `GitHub returned HTTP 401` | The token is wrong or expired. Create a new one. |
| `GitHub returned HTTP 403` | The token doesn't have Pull requests: Read and write on that repo. |
| `GitHub returned HTTP 404` | Check the PR URL. For a private repo, the token must include that repo. |
| `GitHub returned HTTP 406` | The PR is too large for GitHub's diff API. Review it locally with `git diff` instead. |
| `Already reviewed abc1234, nothing new` | Not an error: the PR's head commit already has a reviewbuddy review. Push new commits, or add `--full` to review it again. |
| `Previous review's commit abc1234 no longer exists ... reviewing the whole PR` | The branch was force-pushed or rebased, so there's nothing to diff against. reviewbuddy reviews the whole PR instead; findings already posted are still skipped. |
| `No new findings to post.` | Not an error: the new commits had no issues, or every finding was already posted. Nothing was posted. |
