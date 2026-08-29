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
  questionMetaCache.set(titleSlug, data.question);
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

console.log("[LeetCode->GitHub] content script loaded on", location.href);
