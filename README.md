# reviewbuddy
AI code reviewer for GitHub PRs. Runs on local models (Ollama) or free cloud APIs.

Right now it reviews a diff file (one or many changed files) and prints the findings. GitHub integration comes later.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (`node --version`)
- [Ollama](https://ollama.com/) running locally, with at least one model pulled

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

Files with no added lines (deleted files, pure renames, binary files) are skipped.

## Configuration

| Variable       | Default                  | Meaning                    |
|----------------|--------------------------|----------------------------|
| `OLLAMA_MODEL` | `qwen3.5:4b`             | Ollama model to use        |
| `OLLAMA_URL`   | `http://localhost:11434` | Where Ollama is listening  |

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
