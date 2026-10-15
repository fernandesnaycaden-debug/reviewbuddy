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

/**
 * Keys of the findings already posted as inline comments by our reviews (reviewIds).
 * Outdated comments have no current line, so they never match.
 */
export function postedKeys(comments, reviewIds) {
  const keys = new Set();
  for (const c of comments) {
    const severity = c.body?.match(/^\*\*\[(\w+)\]\*\*/)?.[1];
    if (reviewIds.has(c.pull_request_review_id) && severity && c.line != null) {
      keys.add(findingKey(c.path, c.line, severity));
    }
  }
  return keys;
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
