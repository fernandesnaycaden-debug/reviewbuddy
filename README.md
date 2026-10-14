# reviewbuddy
AI code reviewer for GitHub PRs. Runs on local models (Ollama) or free cloud APIs.

It reviews a GitHub pull request and posts its findings as inline review comments, or reviews a local diff file and prints them. Running automatically on every PR (a GitHub Action) comes later.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (`node --version`)
- [Ollama](https://ollama.com/) 0.5 or newer running locally, with at least one model pulled

No `npm install` is needed: the project has no dependencies.

## Run it

```powershell
git clone https://github.com/fernandesnaycaden-debug/reviewbuddy.git
cd reviewbuddy

ollama list                                # check which models you have
$env:OLLAMA_MODEL = "qwen2.5-coder:7b"     # use a model name from that list
npm run review
```

`$env:OLLAMA_MODEL` only lasts for the current PowerShell window. On macOS/Linux use `OLLAMA_MODEL=qwen2.5-coder:7b npm run review`.

To review a different diff: `npm run review -- path/to/file.diff`

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

Every run posts a new review; earlier ones are not updated or removed.

## Configuration

| Variable       | Default                  | Meaning                    |
|----------------|--------------------------|----------------------------|
| `OLLAMA_MODEL` | `qwen3.5:4b`             | Ollama model to use        |
| `OLLAMA_URL`   | `http://localhost:11434` | Where Ollama is listening  |
| `GITHUB_TOKEN` | none                     | Token used to read PRs and post reviews |
| `REVIEWBUDDY_IGNORE` | none               | Extra comma-separated patterns to skip, like `--ignore` |

## Tests

```powershell
npm test
```

The tests cover diff parsing, line numbering, chunking, the ignore list and reply parsing. They don't need Ollama.

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
| `Request to Ollama ... failed` after ~5 minutes | The model is too slow on this machine. Try a smaller model. |
| `Set GITHUB_TOKEN to post a review` | Set `$env:GITHUB_TOKEN`, or add `--dry-run`. |
| `GitHub returned HTTP 401` | The token is wrong or expired. Create a new one. |
| `GitHub returned HTTP 403` | The token doesn't have Pull requests: Read and write on that repo. |
| `GitHub returned HTTP 404` | Check the PR URL. For a private repo, the token must include that repo. |
| `GitHub returned HTTP 406` | The PR is too large for GitHub's diff API. Review it locally with `git diff` instead. |
