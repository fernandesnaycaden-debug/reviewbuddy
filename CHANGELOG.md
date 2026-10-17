# Changelog

All notable changes to reviewbuddy are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The GitHub Action's `@v1` tag always points at the latest 1.x release.

## [Unreleased]

### Security

- **A forged review marker can no longer skip the review.** Only reviews posted by `github-actions[bot]`, the token's own user or `REVIEWBUDDY_REVIEWER` count as earlier reviewbuddy reviews. Before, anyone could post a review with `<!-- reviewbuddy:sha=<head> -->` and the next run printed "Already reviewed" and passed `--fail-on`.
- **A repository can no longer choose where reviewbuddy writes files.** The `output` key in `.reviewbuddy.json` is ignored with a warning; use `--output` or `REVIEWBUDDY_OUTPUT`.
- **`--branch` and `--since` read `.reviewbuddy.json` and `.reviewbuddy.md` from the revision given**, not from the checked-out branch being reviewed, as pull requests already read them from the base branch.

## [1.0.0] - 2026-10-17

The first release. Use the action as `fernandesnaycaden-debug/reviewbuddy@v1`, or run the CLI with `npx github:fernandesnaycaden-debug/reviewbuddy`.

### Added

#### Reviewing code

- **CLI** that reviews a diff file, a GitHub pull request URL, or a diff piped in on stdin (`-`), and prints its findings as `security`, `bug`, `performance` or `suggestion`, each on a file and line. Each changed file is reviewed separately, and large files are split into pieces that fit the model's context.
- **Git modes**: `--staged`, `--uncommitted`, `--branch <base>` and `--since <rev>` run `git diff` for you, in the current directory or `--repo-dir`.
- **Diff input** in UTF-8 (with or without a byte order mark) or UTF-16 with a byte order mark, so diffs saved by Windows PowerShell 5.1 work.
- **Default ignore list** for lockfiles, minified files, source maps, snapshots, SVGs and `dist/`, `build/`, `vendor/` and `node_modules/`. Add patterns with `--ignore`, or turn the defaults off with `--no-default-ignore`.
- **Full-file context**: besides the diff, the model sees the new version of each changed file (or the 40 lines around each change when the whole file doesn't fit), so it can tell when the surrounding code already handles a problem. Each provider has its own prompt budget. The context always matches the reviewed version: the PR's head commit, the index, the working tree or `HEAD`.
- **`--min-severity`** drops findings less serious than the one you name, everywhere: terminal, report, posted review, annotations and `--fail-on`.
- **Suggested fixes**: when the fix is small and certain, the finding carries a replacement. reviewbuddy validates it, keeps the original indentation, and posts it as a GitHub `suggestion` block the author can commit with one click.
- **Multi-line findings**: a problem that covers a block (up to 20 lines in one hunk) is one comment on that range, optionally with a suggestion for the whole block. Ranges show up in every output format.

#### Model providers

- **Ollama** (local, the default), plus **Groq**, **OpenRouter**, **Gemini** and **Anthropic** as cloud providers. Pick one with `--provider`, `REVIEWBUDDY_PROVIDER` or `.reviewbuddy.json`, and pick a model with each provider's `*_MODEL` variable.
- Structured output via a JSON schema, with an automatic fallback to plain JSON mode for models that don't support it.
- Anthropic's server-side refusal fallback on the default Claude models. A piece of code that is still declined is skipped with a warning.
- **Retries and timeouts**: network errors and HTTP 429/5xx are retried up to 3 times with backoff, honouring `Retry-After` up to 60 seconds. A rate limit pauses every request to that host, not just the one that got it. `--timeout` (or `REVIEWBUDDY_TIMEOUT`) limits each model request, by default 600 seconds for Ollama and 300 for cloud providers. GitHub requests time out after 30 seconds.

#### Pull request reviews

- **One review per run**, with an inline comment on each finding and a summary naming the model. Findings outside the diff, and anything over the 50-comment inline cap, go in the summary, most severe first. reviewbuddy never approves a PR.
- **Incremental reviews**: each review records the commit it reviewed in a hidden marker. The next run reviews only the commits since then, says "Already reviewed" when there is nothing new, and falls back to the whole PR after a force-push. `--full` reviews the whole PR again.
- **Deduplication**: a finding already posted on the same file, line and severity is not posted again, even with `--full`. A run with nothing new posts nothing.
- **`--dry-run`** shows exactly what would be posted (including the review event and any dismissals) without posting.
- **Request changes**: `--request-changes-on` posts the review as **Request changes** when a new finding has a listed severity. reviewbuddy dismisses its own earlier change request once it no longer applies (all its blocking comments are outdated, or a `--full` run found nothing blocking), and keeps it when in doubt. It never touches a person's review.
- **Large pull requests**: when GitHub refuses the diff (HTTP 406, over 300 files), reviewbuddy builds the same per-file diffs from the paginated files API, up to GitHub's 3,000-file limit. Incremental runs fall back from the compare diff to the compare file list, and to a full review when that list is full. Files without a patch are listed as not reviewed.
- **Concurrency and limits**: `--concurrency` reviews 1 to 16 files at once, by default 1 for Ollama, 2 for Groq and OpenRouter, and 4 for Gemini and Anthropic. Output stays in file order. `--max-files` (source files and the biggest changes first) and `--max-chunks-per-file` (default 10) keep a huge PR from running for hours. A file that fails doesn't stop the others; the run exits with code 1 and the next run retries it.

#### GitHub Action

- **Composite action** that reviews every pull request with the same engine as the CLI, including incremental reviews. It needs no checkout step.
- **`fail-on`** fails the check while a finding of a listed severity is still in the PR, so it can be a required status check. Fixing the flagged line clears it; pushing an unrelated commit doesn't.
- **Annotations** for every finding (errors for `security` and `bug`, warnings otherwise), shown on the run page and in the PR's **Files changed** tab, plus the full Markdown report on the run's **step summary**.
- **Fork and Dependabot PRs**: without secrets, the review is skipped with a warning. With a read-only token, the findings still appear in the summary and annotations.
- Inputs for every setting (`provider`, `model`, `api-key`, `fail-on`, `request-changes-on`, `min-severity`, `ignore`, `full`, `timeout`, `concurrency`, `max-files`, `max-chunks-per-file`, `config`, `sarif-file`, `github-token`), and a `sarif-file` output.

#### Output

- **`--format text|json|sarif`** and **`--output`**. The format can also be chosen from the output file's extension. The text format writes a Markdown report.
- **JSON**: a versioned document (`schemaVersion: 1`) listing every reviewed file, its findings and the files that weren't reviewed.
- **SARIF 2.1.0**: one rule per severity, ready for GitHub Code Scanning. The action's `sarif-file` input writes it for `github/codeql-action/upload-sarif`.
- In JSON and SARIF modes, stdout holds only the document, so it can be piped straight into other tools.

#### Per-repository configuration

- **`.reviewbuddy.json`** holds settings and **`.reviewbuddy.md`** holds project-specific review rules (capped at 4,000 characters). Both are optional; see `examples/` for samples.
- Precedence: CLI flag, then environment variable or action input, then `.reviewbuddy.json`, then the built-in default. Ignore patterns add up instead.
- For pull requests, both files are read from the PR's **base branch**. `--no-config` (`config: false` in the action) ignores them.

### Security notes

- **Config can't be changed by the PR it reviews.** `.reviewbuddy.json` and `.reviewbuddy.md` are read from the base branch, so a PR can't drop `failOn` or tell the model to report nothing in order to pass its own check. A change to either file takes effect once it is merged. If the token can't read them, the run stops instead of silently reviewing without the repo's rules.
- **No secrets in config.** reviewbuddy refuses to run when `.reviewbuddy.json` contains a key that looks like a credential (`apiKey`, `token`, `password`, ...). Keep API keys in environment variables or Actions secrets.
- **Keys are never printed**, not even in error messages.
- **Repository rules can't take over the output.** The built-in instructions come first, and the model is told to ignore anything in `.reviewbuddy.md` that asks it to change the output format or report nothing.
- **Action inputs are never interpolated into the shell script.** They reach it only as environment variables, so a crafted input can't inject commands.
- **Git arguments are checked**: `--branch` and `--since` reject values that start with `-`, so a revision can't be read as a git option. Paths in a diff that lead outside the working directory (`../`) are never read for context.
- **Reviews are never posted twice.** Posting a review is retried only after a rate limit.
- **Permissions**: the action needs `pull-requests: write` (and `contents: read` for full-file context and config). Uploading SARIF also needs `security-events: write`. On private repositories, Code Scanning requires GitHub Advanced Security.

[1.0.0]: https://github.com/fernandesnaycaden-debug/reviewbuddy/releases/tag/v1.0.0
