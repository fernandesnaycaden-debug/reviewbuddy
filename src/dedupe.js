// Recognise earlier reviewbuddy reviews, so re-runs review only new commits and skip findings already posted.

const MARKER = /<!-- reviewbuddy:sha=([0-9a-f]{7,64}) -->/;

/** The hidden marker recording which commit a review covered. */
export function markerFor(sha) {
  return `<!-- reviewbuddy:sha=${sha} -->`;
}

/** The commit SHA in a review body's marker, or null if it has none. */
export function parseMarker(body) {
  return body?.match(MARKER)?.[1] ?? null;
}

/**
 * The last review that carries our marker, as { id, sha }, or null.
 * GitHub lists reviews oldest first. The author isn't checked: the token may be a person's or the Actions bot.
 */
export function latestMarkedReview(reviews) {
  let latest = null;
  for (const review of reviews) {
    const sha = parseMarker(review.body);
    if (sha) latest = { id: review.id, sha };
  }
  return latest;
}

/** Two findings are the same if they share this key: same path, line and severity. */
export function findingKey(path, line, severity) {
  return `${path}:${line}:${severity.toLowerCase()}`;
}

/** The severity an inline comment of ours starts with ("**[BUG]** ..."), lower case, or undefined. */
function commentSeverity(comment) {
  return comment.body?.match(/^\*\*\[(\w+)\]\*\*/)?.[1].toLowerCase();
}

/**
 * Findings our reviews (reviewIds) posted as inline comments that still apply, as [{ filename, line, endLine?, severity }].
 * GitHub gives a range comment's first line as start_line and its last as line; line is a finding's first line here.
 * Outdated comments (the code under them changed) have no current line, so they are left out.
 */
export function openFindings(comments, reviewIds) {
  const found = [];
  for (const c of comments) {
    const severity = commentSeverity(c);
    if (reviewIds.has(c.pull_request_review_id) && severity && c.line != null) {
      const range = c.start_line != null && c.start_line < c.line;
      found.push({
        filename: c.path, line: range ? c.start_line : c.line, ...(range && { endLine: c.line }), severity,
      });
    }
  }
  return found;
}

/** Keys of the findings already posted as inline comments by our reviews (reviewIds). */
export function postedKeys(comments, reviewIds) {
  return new Set(openFindings(comments, reviewIds).map((f) => findingKey(f.filename, f.line, f.severity)));
}

/** Remove findings whose key is in keys. Returns { results, skipped }. */
export function dropPosted(results, keys) {
  let skipped = 0;
  const kept = results.map((r) => {
    const comments = r.comments.filter((c) => !keys.has(findingKey(r.filename, c.line, c.severity)));
    skipped += r.comments.length - comments.length;
    return { ...r, comments };
  });
  return { results: kept, skipped };
}

/** Our reviews (they carry the marker) that still request changes, oldest first. Dismissed ones are DISMISSED. */
export function blockingReviews(reviews) {
  return reviews.filter((r) => r.state === 'CHANGES_REQUESTED' && parseMarker(r.body));
}

// A finding listed in a review body instead of inline: "- `src/a.js:4-9` **[BUG]** ...".
const LISTED = /^- `[^`\n]+:\d+(?:-\d+)?` \*\*\[(\w+)\]\*\*/gm;

/** Severities (lower case) of the findings a review body lists: outside the diff, or over the inline limit. */
export function bodySeverities(body) {
  return [...(body ?? '').matchAll(LISTED)].map((m) => m[1].toLowerCase());
}

/**
 * The ids of our change requests that no longer apply and can be dismissed (see README, "Blocking merges").
 * reviews and comments: all of the PR's. blocking: the --request-changes-on severities. found: the severities of
 * everything this run found, posted before or not. full: this run reviewed every file of the whole PR (--full).
 * failed: a file could not be reviewed. When unsure, a review keeps blocking.
 * - Nothing is dismissed without blocking severities, when this run found a blocking finding, or when a file failed.
 * - After a full review, every change request is dismissed.
 * - Otherwise one is dismissed only if it has blocking inline comments, all of them outdated (the code under them
 *   changed), and its body lists no blocking finding, since those can't be tracked.
 */
export function dismissible(reviews, comments, {
  blocking, found, full, failed,
}) {
  const isBlocking = (severity) => blocking.includes(severity);
  if (blocking.length === 0 || failed || found.some(isBlocking)) return [];
  return blockingReviews(reviews)
    .filter((review) => {
      if (full) return true;
      const inline = comments.filter((c) => c.pull_request_review_id === review.id && isBlocking(commentSeverity(c)));
      return inline.length > 0 && inline.every((c) => c.line == null) && !bodySeverities(review.body).some(isBlocking);
    })
    .map((review) => review.id);
}
