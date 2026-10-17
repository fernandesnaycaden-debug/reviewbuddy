# Releasing

Users pin the action as `@v1` (the latest 1.x release), `@vX.Y.Z` (one release) or a commit SHA. Every release therefore gets its own `vX.Y.Z` tag, and the `v1` tag is moved to it. Only start a `v2` tag for a breaking change (a removed or renamed input, or a changed default that breaks existing workflows).

The commands below are for PowerShell, run from the repository root.

## Checklist

1. **On a release branch, bump the version** in `package.json` (`"version": "X.Y.Z"`). The JSON example in the README shows `"version": "1.0.0"` under `tool`; update it too.

2. **Add a CHANGELOG section.** In `CHANGELOG.md`, add `## [X.Y.Z] - YYYY-MM-DD` above the previous release, with `### Added`, `### Changed`, `### Fixed` or `### Security notes` as needed. Write it for users, not as a commit list. At the bottom, add the compare link:

   ```markdown
   [X.Y.Z]: https://github.com/fernandesnaycaden-debug/reviewbuddy/compare/vPREVIOUS...vX.Y.Z
   ```

3. **Test, then merge** the PR into `main`:

   ```powershell
   npm test
   ```

4. **Tag the merged commit** and move `v1` to it:

   ```powershell
   git switch main
   git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git tag -fa v1 -m "v1 -> vX.Y.Z"
   ```

5. **Push the tags.** `v1` already exists on GitHub, so moving it needs `--force`. Never force-push a `vX.Y.Z` tag: once published, a release tag must not change.

   ```powershell
   git push origin vX.Y.Z
   git push origin v1 --force
   ```

6. **Create the GitHub Release** from the CHANGELOG section. In the web UI: **Releases → Draft a new release**, choose tag `vX.Y.Z`, set the title to `vX.Y.Z`, and paste the section's content. With the [GitHub CLI](https://cli.github.com/):

   ```powershell
   $version = "X.Y.Z"
   $lines = Get-Content CHANGELOG.md
   $start = ($lines | Select-String -SimpleMatch "## [$version]" | Select-Object -First 1).LineNumber
   $rest = $lines[$start..($lines.Count - 1)]
   $end = ($rest | Select-String -Pattern '^## \[|^\[\d' | Select-Object -First 1).LineNumber
   $notes = if ($end) { $rest[0..($end - 2)] } else { $rest }
   $notesFile = Join-Path $env:TEMP "reviewbuddy-$version.md"
   $notes | Set-Content -Encoding utf8 $notesFile
   gh release create "v$version" --title "v$version" --notes-file $notesFile --verify-tag
   ```

7. **Marketplace.** On the first release, tick **Publish this Action to the GitHub Marketplace** in the release form and accept the agreement. Later releases stay listed; the form shows the same checkbox each time.

8. **Check** that a workflow using `fernandesnaycaden-debug/reviewbuddy@v1` picks up the new release (for example, this repo's next PR run, or a test repo).
