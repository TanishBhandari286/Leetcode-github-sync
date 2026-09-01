// Detects LeetCode submissions, waits for the verdict, and fetches the
// submitted code + problem metadata via LeetCode's own GraphQL API.
// The payload is handed off to the background service worker for GitHub sync.

// Ordered by how specific/reliable each signal is. LeetCode has changed its
// submit-button markup before, so a single selector is a single point of
// failure - if the primary one stops matching, fall back to a looser one
// rather than silently syncing nothing.
const SUBMIT_BUTTON_SELECTORS = ['[data-e2e-locator="console-submit-button"]', 'button[aria-label="Submit" i]'];
const SUBMIT_BUTTON_HEURISTIC_MAX_DEPTH = 5;
const SUBMIT_BUTTON_HEURISTIC_MAX_TOP = 120; // px from viewport top - keeps it scoped to the toolbar area
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 40; // ~60s timeout waiting for a verdict

const QUESTION_META_QUERY = `
  query questionMeta($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionFrontendId
      title
      titleSlug
      difficulty
      topicTags {
        name
      }
    }
  }
`;

const SUBMISSION_LIST_QUERY = `
  query submissionList($offset: Int!, $limit: Int!, $questionSlug: String!) {
    questionSubmissionList(offset: $offset, limit: $limit, questionSlug: $questionSlug) {
      submissions {
        id
        statusDisplay
        lang
        timestamp
      }
    }
  }
`;

const SUBMISSION_DETAILS_QUERY = `
  query submissionDetails($submissionId: Int!) {
    submissionDetails(submissionId: $submissionId) {
      code
      runtimeDisplay
      memoryDisplay
      lang {
        name
      }
    }
  }
`;

const questionMetaCache = new Map();

function getCsrfToken() {
  const match = document.cookie.match(/csrftoken=([^;]+)/);
  return match ? match[1] : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTitleSlugFromUrl() {
  const match = location.pathname.match(/\/problems\/([^/]+)/);
  return match ? match[1] : null;
}

function isFinalStatus(statusDisplay) {
  return Boolean(statusDisplay) && !["Pending", "Judging", "Compiling"].includes(statusDisplay);
}

async function graphqlRequest(query, variables) {
  const response = await fetch("https://leetcode.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-csrftoken": getCsrfToken(),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    // Without this check a rate-limited (403) or 5xx response still gets
    // json()-parsed and falls through with no `errors` field, so the caller
    // would silently get back `undefined` data instead of a catchable error.
    const err = new Error(`LeetCode GraphQL API returned ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const json = await response.json();
  if (json.errors) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

async function getQuestionMeta(titleSlug) {
  if (questionMetaCache.has(titleSlug)) {
    return questionMetaCache.get(titleSlug);
  }
  const data = await graphqlRequest(QUESTION_META_QUERY, { titleSlug });
  // Only cache a real answer. LeetCode returns a 200 with `question: null`
  // under load, and caching that would pin the problem to "no difficulty" for
  // the rest of the page's life - which during a backfill means every later
  // submission for it silently misses the stats charts.
  if (data.question) questionMetaCache.set(titleSlug, data.question);
  return data.question;
}

async function getLatestSubmission(titleSlug) {
  const data = await graphqlRequest(SUBMISSION_LIST_QUERY, {
    offset: 0,
    limit: 1,
    questionSlug: titleSlug,
  });
  const submissions = data.questionSubmissionList?.submissions || [];
  return submissions[0] || null;
}

async function getSubmissionDetails(submissionId) {
  const data = await graphqlRequest(SUBMISSION_DETAILS_QUERY, {
    submissionId: Number(submissionId),
  });
  return data.submissionDetails;
}

// Polls the submission list until a submission newer than `previousLatestId`
// shows up with a final (non-Pending/Judging) verdict.
async function waitForVerdict(titleSlug, previousLatestId) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    let latest;
    try {
      latest = await getLatestSubmission(titleSlug);
    } catch (err) {
      console.warn("[LeetCode->GitHub] submission list poll failed", err);
      continue;
    }
    if (!latest || latest.id === previousLatestId) continue;
    if (isFinalStatus(latest.statusDisplay)) return latest;
  }
  return null;
}

async function handleSubmitClick() {
  const titleSlug = getTitleSlugFromUrl();
  if (!titleSlug) return;

  let previousLatestId = null;
  try {
    const previous = await getLatestSubmission(titleSlug);
    previousLatestId = previous?.id ?? null;
  } catch (err) {
    console.warn("[LeetCode->GitHub] could not read prior submission list", err);
  }

  const verdict = await waitForVerdict(titleSlug, previousLatestId);
  if (!verdict) {
    console.warn("[LeetCode->GitHub] timed out waiting for a submission verdict");
    return;
  }

  const [meta, details] = await Promise.all([
    getQuestionMeta(titleSlug).catch((err) => {
      console.warn("[LeetCode->GitHub] question metadata fetch failed", err);
      return null;
    }),
    getSubmissionDetails(verdict.id).catch((err) => {
      console.warn("[LeetCode->GitHub] submission details fetch failed", err);
      return null;
    }),
  ]);

  if (!details) {
    console.warn("[LeetCode->GitHub] no submission details for", verdict.id, "- skipping sync");
    return;
  }

  const payload = {
    submissionId: verdict.id,
    titleSlug,
    questionFrontendId: meta?.questionFrontendId ?? null,
    title: meta?.title ?? titleSlug,
    difficulty: meta?.difficulty ?? null,
    topicTags: meta?.topicTags?.map((tag) => tag.name) ?? [],
    statusDisplay: verdict.statusDisplay,
    lang: details.lang?.name ?? verdict.lang,
    code: details.code,
    runtimeDisplay: details.runtimeDisplay ?? null,
    memoryDisplay: details.memoryDisplay ?? null,
    timestamp: verdict.timestamp,
  };

  chrome.runtime.sendMessage({ type: "SYNC_SUBMISSION", payload });
}

function isLikelySubmitButton(el) {
  if (!el || el.tagName !== "BUTTON") return false;
  const text = (el.textContent || "").trim().toLowerCase();
  if (text !== "submit") return false;
  const top = el.getBoundingClientRect().top;
  return top >= 0 && top < SUBMIT_BUTTON_HEURISTIC_MAX_TOP;
}

// Tries each known selector in order, then falls back to walking up from the
// click target looking for a plausible "Submit" button near the top of the
// page. The heuristic path logs a warning so a future debugging session has
// a clear signal that LeetCode's markup moved instead of silently degrading.
function findSubmitButton(target) {
  const primary = target.closest(SUBMIT_BUTTON_SELECTORS[0]);
  if (primary) return primary;

  for (let i = 1; i < SUBMIT_BUTTON_SELECTORS.length; i++) {
    const match = target.closest(SUBMIT_BUTTON_SELECTORS[i]);
    if (match) {
      console.warn(
        `[LeetCode->GitHub] primary submit-button selector didn't match; used fallback selector #${i} - LeetCode's markup may have changed`
      );
      return match;
    }
  }

  let node = target;
  for (let depth = 0; node && depth < SUBMIT_BUTTON_HEURISTIC_MAX_DEPTH; depth++) {
    if (isLikelySubmitButton(node)) {
      console.warn(
        "[LeetCode->GitHub] submit button matched via text/position heuristic - LeetCode's markup may have changed, selectors need updating"
      );
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

document.addEventListener(
  "click",
  (event) => {
    const button = findSubmitButton(event.target);
    if (!button) return;
    handleSubmitClick().catch((err) =>
      console.error("[LeetCode->GitHub] submission handling failed", err)
    );
  },
  true
);

// --- Backfill: pull the user's full submission history from LeetCode's
// legacy REST endpoint so people migrating from LeetHub/LeetSync/a manual
// repo (or who just turned this extension on) can populate the target repo
// without re-solving everything. Only ever-accepted submissions are synced -
// an active account can have thousands of failed attempts, and replaying all
// of those would flood the repo and burn through GitHub's rate limit for no
// real benefit. Unlike the GraphQL queries above, this endpoint hands back
// the submitted code directly, so no extra per-submission fetch is needed.
// Measured empirically against LeetCode's legacy submissions API: requests
// spaced under ~1s trip a 403 ("You do not have permission to perform this
// action") that has nothing to do with actual permissions - it's a request-
// frequency guard. 1s alone was clean in testing; these delays add headroom,
// and the retry helper below covers the rest in case the real threshold
// varies by account or load.
const BACKFILL_PAGE_SIZE = 20;
const BACKFILL_PAGE_DELAY_MS = 2500;
const BACKFILL_SYNC_DELAY_MS = 2500;
const MAX_BACKFILL_PAGES = 1000; // safety cap - about 20k submissions
const BACKFILL_RETRY_DELAYS_MS = [3000, 6000, 12000];
// The per-request delays above only guard against the short-window limit we
// actually measured (<1s between requests). A long, unbroken run against
// hundreds or thousands of submissions could still trip a longer-window quota
// we have no way to measure without tripping it - so every so often, pause
// for longer to break up sustained load as a defensive margin.
const BACKFILL_COOLDOWN_EVERY = 25;
const BACKFILL_COOLDOWN_MS = 15000;

async function withLeetcodeRetry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimited = err?.status === 403;
      if (!isRateLimited || attempt >= BACKFILL_RETRY_DELAYS_MS.length) throw err;
      const delay = BACKFILL_RETRY_DELAYS_MS[attempt];
      console.warn(`[LeetCode->GitHub] backfill: ${label} rate-limited (403), retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

async function backfillCooldownIfDue(requestCount) {
  if (requestCount > 0 && requestCount % BACKFILL_COOLDOWN_EVERY === 0) {
    console.log(`[LeetCode->GitHub] backfill: cooling down ${BACKFILL_COOLDOWN_MS}ms after ${requestCount} requests`);
    await patchBackfillStatus({ note: "Pausing briefly to stay under LeetCode's rate limit..." });
    await sleep(BACKFILL_COOLDOWN_MS);
    await patchBackfillStatus({ note: null });
  }
}

async function fetchSubmissionHistoryPage(offset, limit) {
  const url = new URL("/api/submissions/", location.origin);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url.toString());
  if (!response.ok) {
    const err = new Error(`LeetCode submissions API returned ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

// Every write stamps a heartbeat. A backfill lives in this content script, so
// closing the tab, navigating away, or reloading the extension kills it
// mid-run with no chance to clear `running` - without a heartbeat to age the
// lock out, that would leave the popup stuck on "Running..." forever with no
// way to start another backfill short of wiping storage.
async function patchBackfillStatus(patch) {
  const { backfillStatus } = await chrome.storage.local.get("backfillStatus");
  await chrome.storage.local.set({
    backfillStatus: { ...backfillStatus, ...patch, heartbeatAt: Date.now() },
  });
}

async function collectAcceptedSubmissions() {
  const accepted = [];
  let offset = 0;
  let scanned = 0;
  for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
    const data = await withLeetcodeRetry(
      () => fetchSubmissionHistoryPage(offset, BACKFILL_PAGE_SIZE),
      `submission history page (offset ${offset})`
    );
    const rows = data.submissions_dump || [];
    scanned += rows.length;
    for (const row of rows) {
      if (row.status_display === "Accepted") accepted.push(row);
    }
    await patchBackfillStatus({ scanned });
    if (!data.has_next || rows.length === 0) break;
    offset += BACKFILL_PAGE_SIZE;
    await sleep(BACKFILL_PAGE_DELAY_MS);
    await backfillCooldownIfDue(page + 1);
  }
  // Oldest first, so attempt numbers and the README index end up in solve
  // order instead of the newest-first order LeetCode's API returns them in.
  return accepted.sort((a, b) => a.timestamp - b.timestamp);
}

async function runBackfill() {
  await patchBackfillStatus({
    running: true,
    phase: "scanning",
    scanned: 0,
    totalAccepted: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    currentTitle: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  });

  let accepted;
  try {
    accepted = await collectAcceptedSubmissions();
  } catch (err) {
    console.error("[LeetCode->GitHub] backfill scan failed", err);
    await patchBackfillStatus({ running: false, phase: "error", error: String(err), finishedAt: Date.now() });
    return;
  }

  await patchBackfillStatus({ phase: "syncing", totalAccepted: accepted.length });

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < accepted.length; i++) {
    const submission = accepted[i];
    let meta = null;
    try {
      meta = await withLeetcodeRetry(
        () => getQuestionMeta(submission.title_slug),
        `question metadata (${submission.title_slug})`
      );
    } catch (err) {
      console.warn("[LeetCode->GitHub] backfill: metadata fetch failed for", submission.title_slug, err);
    }

    const payload = {
      submissionId: submission.id,
      titleSlug: submission.title_slug,
      questionFrontendId: meta?.questionFrontendId ?? submission.frontend_id ?? null,
      title: meta?.title ?? submission.title_slug,
      difficulty: meta?.difficulty ?? null,
      topicTags: meta?.topicTags?.map((tag) => tag.name) ?? [],
      statusDisplay: submission.status_display,
      lang: submission.lang_name || submission.lang,
      code: submission.code,
      runtimeDisplay: submission.runtime ?? null,
      memoryDisplay: submission.memory ?? null,
      timestamp: submission.timestamp,
    };

    try {
      // background.js's syncSubmission() already dedupes by submissionId, so
      // re-running a backfill (or overlapping with problems already synced
      // live) is safe - previously-synced attempts just come back skipped.
      const result = await chrome.runtime.sendMessage({ type: "SYNC_SUBMISSION", payload });
      if (result?.skipped) skipped++;
      else if (result?.ok) synced++;
      else failed++;
    } catch (err) {
      console.error("[LeetCode->GitHub] backfill sync failed for", submission.title_slug, err);
      failed++;
    }

    await patchBackfillStatus({ synced, skipped, failed, currentTitle: payload.title });
    await sleep(BACKFILL_SYNC_DELAY_MS);
    await backfillCooldownIfDue(i + 1);
  }

  await patchBackfillStatus({ running: false, phase: "done", finishedAt: Date.now(), currentTitle: null });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RUN_BACKFILL") {
    runBackfill().catch((err) => console.error("[LeetCode->GitHub] backfill crashed", err));
    sendResponse({ ok: true, started: true });
    return false; // response already sent synchronously; the backfill itself runs in the background
  }
  return false;
});

console.log("[LeetCode->GitHub] content script loaded on", location.href);
