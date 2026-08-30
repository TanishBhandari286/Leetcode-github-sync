// Owns all GitHub API calls. The content script never touches the PAT directly —
// it sends a structured payload here via chrome.runtime.sendMessage.

importScripts("crypto-utils.js");

const PLATFORM_TOTALS_CACHE_MS = 24 * 60 * 60 * 1000;
const ALL_QUESTIONS_COUNT_QUERY = "query { allQuestionsCount { difficulty count } }";

// Problem titles and topic tags come from LeetCode's API, not directly from
// an attacker - but they still end up embedded in generated SVG/Markdown, so
// they get escaped defensively rather than trusted as safe-by-origin.
function escapeXmlText(str) {
  return String(str ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch])
  );
}

function escapeMarkdownCell(str) {
  // Escapes both the table's own structural characters (|, backslash) and
  // raw HTML angle brackets/ampersand - GitHub renders Markdown to real HTML,
  // so a stray <tag> in a cell isn't just visual noise, it's live markup.
  return String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function escapeMarkdownLinkText(str) {
  return escapeMarkdownCell(str).replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

// Real LeetCode slugs are lowercase alphanumerics and hyphens. Everything else
// is either a malformed URL or something hostile, and it must not reach the
// repo: the slug lands in a Markdown link target, in the `<!-- id:... -->`
// marker used to find a problem's existing row, and in the committed file
// path. A slug carrying ")" closes the link early, one carrying "-->" closes
// the comment and lets the rest render as live HTML, and one carrying "/" or
// ".." walks the write out of its intended folder. Stripping to the known-safe
// charset is a no-op for every genuine slug, so this costs nothing in practice.
function sanitizeSlug(slug) {
  return String(slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

// Same idea for the problem number, which is only ever digits.
function sanitizeFrontendId(id) {
  return String(id ?? "").replace(/[^0-9]/g, "");
}

// GitHub's contents API takes the file path in the URL, so each segment has to
// be encoded - the separators must survive, everything inside them must not.
function encodeRepoPath(path) {
  return String(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// Keys that would reach through a plain object into Object.prototype. These
// come from LeetCode's API rather than an attacker directly, but they are used
// as object keys unchecked, and the blast radius (every object in the worker)
// is far worse than the cost of rejecting them.
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeObjectKey(key) {
  return typeof key === "string" && key.length > 0 && !UNSAFE_OBJECT_KEYS.has(key);
}

// LeetCode's per-difficulty question counts, used as the ring denominators
// (solved-of-this-difficulty vs. how many exist at all) - this is public,
// unauthenticated data, so it's fetched here directly rather than routed
// through the content script's session.
async function fetchPlatformTotals() {
  const response = await fetch("https://leetcode.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: ALL_QUESTIONS_COUNT_QUERY }),
  });
  const json = await response.json();
  const rows = json?.data?.allQuestionsCount || [];
  const totals = {};
  rows.forEach((row) => {
    if (["Easy", "Medium", "Hard"].includes(row.difficulty)) totals[row.difficulty] = row.count;
  });
  return totals;
}

async function getPlatformTotals() {
  const { platformTotals } = await chrome.storage.local.get("platformTotals");
  if (platformTotals && Date.now() - platformTotals.fetchedAt < PLATFORM_TOTALS_CACHE_MS) {
    return platformTotals.totals;
  }
  try {
    const totals = await fetchPlatformTotals();
    await chrome.storage.local.set({ platformTotals: { totals, fetchedAt: Date.now() } });
    return totals;
  } catch (err) {
    console.warn("[LeetCode->GitHub] could not refresh LeetCode question totals", err);
    return platformTotals?.totals || null;
  }
}

const LANG_EXTENSIONS = {
  python: "py",
  python3: "py",
  java: "java",
  cpp: "cpp",
  c: "c",
  csharp: "cs",
  javascript: "js",
  typescript: "ts",
  golang: "go",
  ruby: "rb",
  swift: "swift",
  kotlin: "kt",
  rust: "rs",
  scala: "scala",
  php: "php",
  mysql: "sql",
  mssql: "sql",
  oraclesql: "sql",
  racket: "rkt",
  erlang: "erl",
  elixir: "ex",
  dart: "dart",
};

const README_PATH = "README.md";
const STATS_SVG_PATH = "leetcode-stats.svg";
const TOPICS_SVG_PATH = "leetcode-topics.svg";
const STATS_BLOCK_START = "<!-- leetcode-stats:start -->";
const STATS_BLOCK_END = "<!-- leetcode-stats:end -->";
const TABLE_HEADER_LINES = ["| # | Title | Difficulty | Tags | Status |", "| --- | --- | --- | --- | --- |"];
const DIFFICULTY_ORDER = ["Easy", "Medium", "Hard"];
const DIFFICULTY_COLORS = { Easy: "#00b8a3", Medium: "#ffc01e", Hard: "#ff375f" };
const TOPIC_COLORS = [
  "#58a6ff", "#3fb950", "#f778ba", "#d29922", "#a371f7",
  "#39c5cf", "#f85149", "#79c0ff", "#e3b341", "#56d364",
];
const OTHER_TOPIC_COLOR = "#6e7681";
const MAX_TOPIC_SLICES = 8;

function buildStatsBlock() {
  return [
    STATS_BLOCK_START,
    "# LeetCode Solutions",
    "",
    "Auto-synced by LeetCode to GitHub Sync.",
    "",
    `![LeetCode Stats](./${STATS_SVG_PATH})`,
    `![Topics Breakdown](./${TOPICS_SVG_PATH})`,
    STATS_BLOCK_END,
  ].join("\n");
}

function slugifyStatus(statusDisplay) {
  return (statusDisplay || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fileExtensionFor(lang) {
  const key = (lang || "").toLowerCase().replace(/\s+/g, "");
  return LANG_EXTENSIONS[key] || "txt";
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// With the passphrase lock off, the token sits in local storage as before.
// With it on, only ciphertext is on disk and the key lives in session storage
// (memory-only, cleared on browser restart) - so "locked" is the normal state
// after every restart until the user unlocks from the popup.
async function resolveGithubToken() {
  const { githubToken, encryptedToken } = await chrome.storage.local.get(["githubToken", "encryptedToken"]);
  if (!encryptedToken) return { token: githubToken, locked: false };

  const { tokenKey } = await chrome.storage.session.get("tokenKey");
  if (!tokenKey) return { token: null, locked: true };

  try {
    return { token: await LcgsCrypto.decryptToken(encryptedToken, tokenKey), locked: false };
  } catch (err) {
    // A key that no longer decrypts means the passphrase was changed elsewhere
    // (or the record was replaced) - drop it and make the user unlock again.
    console.warn("[LeetCode->GitHub] stored key no longer decrypts the token, re-locking", err);
    await chrome.storage.session.remove("tokenKey");
    return { token: null, locked: true };
  }
}

async function getSettings() {
  const { githubRepo, basePath, syncFailedAttempts } = await chrome.storage.local.get([
    "githubRepo",
    "basePath",
    "syncFailedAttempts",
  ]);
  const { token, locked } = await resolveGithubToken();
  return {
    githubToken: token,
    locked,
    githubRepo,
    basePath: basePath || "problems",
    // Defaults to true (existing behavior) - only off if the user explicitly unchecked it.
    syncFailedAttempts: syncFailedAttempts !== false,
  };
}

// Attempt numbers are tracked per problem so we never overwrite a prior
// accepted attempt, and don't need to list the repo on every submission.
// The number is only persisted once its commit actually succeeds - otherwise
// a failed sync would permanently burn a number, and a retry would land on
// the wrong filename instead of reusing the one that never got created.
async function peekNextAttemptNumber(titleSlug) {
  const { attemptCounters = {} } = await chrome.storage.local.get("attemptCounters");
  return (attemptCounters[titleSlug] || 0) + 1;
}

async function commitAttemptNumber(titleSlug, number) {
  const { attemptCounters = {} } = await chrome.storage.local.get("attemptCounters");
  attemptCounters[titleSlug] = Math.max(attemptCounters[titleSlug] || 0, number);
  await chrome.storage.local.set({ attemptCounters });
}

async function alreadySynced(submissionId) {
  const { syncedSubmissionIds = {} } = await chrome.storage.local.get("syncedSubmissionIds");
  return Boolean(syncedSubmissionIds[submissionId]);
}

async function markSynced(submissionId) {
  const { syncedSubmissionIds = {} } = await chrome.storage.local.get("syncedSubmissionIds");
  syncedSubmissionIds[submissionId] = true;
  await chrome.storage.local.set({ syncedSubmissionIds });
}

const MAX_ACTIVITY_ENTRIES = 10;

async function logActivity(entry) {
  const { activityLog = [] } = await chrome.storage.local.get("activityLog");
  activityLog.unshift({ timestamp: Date.now(), ...entry });
  await chrome.storage.local.set({ activityLog: activityLog.slice(0, MAX_ACTIVITY_ENTRIES) });
}

async function setLastFailedSync(entry) {
  await chrome.storage.local.set({ lastFailedSync: { timestamp: Date.now(), ...entry } });
}

async function clearLastFailedSync() {
  await chrome.storage.local.remove("lastFailedSync");
}

// Carries enough detail (status, Retry-After) for the retry logic below to
// tell a transient failure (rate limit, server hiccup) from a permanent one
// (bad token, no permission) without re-parsing the message string.
class GithubApiError extends Error {
  constructor(status, body, path, retryAfterSeconds) {
    super(`GitHub API ${status} for ${path}: ${body}`);
    this.name = "GithubApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function githubRequest(token, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    const retryAfterHeader = response.headers.get("retry-after");
    const remainingHeader = response.headers.get("x-ratelimit-remaining");
    const resetHeader = response.headers.get("x-ratelimit-reset");
    let retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    if (retryAfterSeconds === undefined && remainingHeader === "0" && resetHeader) {
      retryAfterSeconds = Math.max(1, Number(resetHeader) - Math.floor(Date.now() / 1000));
    }
    throw new GithubApiError(response.status, body, path, retryAfterSeconds);
  }
  return response;
}

function isRetryableError(err) {
  if (err instanceof GithubApiError) {
    if (err.status >= 500) return true;
    if (err.status === 429) return true;
    // A 403 with rate-limit headers is GitHub's secondary rate limit, not a
    // permission problem - those come back with no Retry-After info at all.
    if (err.status === 403 && err.retryAfterSeconds != null) return true;
    return false;
  }
  // Anything else (fetch rejecting outright - offline, DNS, etc.) is almost
  // always transient, so give it the same benefit of the doubt.
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRY_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 15000;

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === MAX_RETRY_ATTEMPTS) throw err;
      const delayMs = Math.min(
        err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 1000 * 2 ** (attempt - 1),
        MAX_RETRY_DELAY_MS
      );
      console.warn(
        `[LeetCode->GitHub] ${label} failed (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}), retrying in ${delayMs}ms`,
        err.message
      );
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function getFile(token, repo, path) {
  const response = await githubRequest(token, `/repos/${repo}/contents/${encodeRepoPath(path)}`);
  if (response.status === 404) return null;
  const json = await response.json();
  return { content: fromBase64(json.content), sha: json.sha };
}

async function putFile(token, repo, path, content, message, sha) {
  const body = { message, content: toBase64(content) };
  if (sha) body.sha = sha;
  await githubRequest(token, `/repos/${repo}/contents/${encodeRepoPath(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function updateStats(payload) {
  const {
    stats = {},
    solvedProblems = {},
    topicCounts = {},
    topicsRecorded = {},
  } = await chrome.storage.local.get(["stats", "solvedProblems", "topicCounts", "topicsRecorded"]);
  const difficulty = payload.difficulty;
  // Difficulty is the key for both the stats object and the ring denominators,
  // and LeetCode only ever has these three - anything else is bad data and
  // would silently distort the charts, so it doesn't get recorded at all.
  if (!DIFFICULTY_ORDER.includes(difficulty)) {
    console.warn("[LeetCode->GitHub] unrecognised difficulty, not recording stats for it", difficulty);
    return { stats, solvedProblems, topicCounts };
  }
  const safeSlug = sanitizeSlug(payload.titleSlug);
  if (!stats[difficulty]) stats[difficulty] = { accepted: 0, total: 0 };

  stats[difficulty].total += 1;
  if (payload.statusDisplay === "Accepted") {
    stats[difficulty].accepted += 1;
    solvedProblems[safeSlug] = difficulty;

    // Tracked separately from solvedProblems (and keyed by its own flag, not
    // by "already solved") so a problem solved before this feature existed
    // still gets its topics backfilled the next time it's (re-)submitted -
    // and a later resolve of the same problem never double-counts it.
    if (!topicsRecorded[safeSlug]) {
      topicsRecorded[safeSlug] = true;
      (payload.topicTags || []).filter(isSafeObjectKey).forEach((tag) => {
        topicCounts[tag] = (topicCounts[tag] || 0) + 1;
      });
    }
  }

  await chrome.storage.local.set({ stats, solvedProblems, topicCounts, topicsRecorded });
  return { stats, solvedProblems, topicCounts };
}

const CARD_BG = "#0d1117";
const CARD_BORDER = "#30363d";
const TRACK_COLOR = "#21262d";
const TEXT_PRIMARY = "#f0f6fc";
const TEXT_SECONDARY = "#8b949e";
const TEXT_BODY = "#e6edf3";
const CARD_FONT = "Segoe UI, Helvetica, Arial, sans-serif";
const CARD_WIDTH = 560;
const LEGEND_X = 320;
const LEGEND_ROW_HEIGHT = 46;
const LEGEND_ROW_GAP = 12;

function polarToCartesian(cx, cy, r, angleDeg) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function donutSlicePath(cx, cy, outerR, innerR, startAngle, endAngle) {
  const outerStart = polarToCartesian(cx, cy, outerR, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, endAngle);
  const innerStart = polarToCartesian(cx, cy, innerR, endAngle);
  const innerEnd = polarToCartesian(cx, cy, innerR, startAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  return [
    `M ${outerStart.x.toFixed(2)},${outerStart.y.toFixed(2)}`,
    `A ${outerR},${outerR} 0 ${largeArcFlag} 1 ${outerEnd.x.toFixed(2)},${outerEnd.y.toFixed(2)}`,
    `L ${innerStart.x.toFixed(2)},${innerStart.y.toFixed(2)}`,
    `A ${innerR},${innerR} 0 ${largeArcFlag} 0 ${innerEnd.x.toFixed(2)},${innerEnd.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

// A soft glow behind each progress arc/slice - the one bit of "shine" that
// separates a flat data readout from something that feels designed.
function glowFilterDefs(id, stdDeviation) {
  return (
    `<defs><filter id="${id}" x="-60%" y="-60%" width="220%" height="220%">` +
    `<feGaussianBlur stdDeviation="${stdDeviation}" result="blur" />` +
    `<feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>` +
    `</filter></defs>`
  );
}

function cardShell(width, height, title) {
  return (
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="20" fill="${CARD_BG}" stroke="${CARD_BORDER}" stroke-width="1" />` +
    `<text x="30" y="42" fill="${TEXT_PRIMARY}" font-family="${CARD_FONT}" font-size="17" font-weight="700">${title}</text>`
  );
}

// A small bordered "chip" per legend row instead of bare dot+text - reads as
// a deliberately designed panel rather than a debug printout.
function legendChip(x, y, width, color, title, subtitle) {
  return (
    `<rect x="${x}" y="${y}" width="${width}" height="${LEGEND_ROW_HEIGHT}" rx="10" fill="#161b22" stroke="${CARD_BORDER}" stroke-width="1" />` +
    `<circle cx="${x + 18}" cy="${y + LEGEND_ROW_HEIGHT / 2}" r="6" fill="${color}" />` +
    `<text x="${x + 34}" y="${y + LEGEND_ROW_HEIGHT / 2 - 3}" fill="${TEXT_BODY}" font-family="${CARD_FONT}" font-size="14" font-weight="600">${title}</text>` +
    `<text x="${x + 34}" y="${y + LEGEND_ROW_HEIGHT / 2 + 14}" fill="${TEXT_SECONDARY}" font-family="${CARD_FONT}" font-size="11.5">${subtitle}</text>`
  );
}

// These rings show coverage of LeetCode's full problem set per difficulty,
// so fractions are almost always small (a few solved out of ~1000+) - a
// round linecap's own radius would swallow a dash that short and render as
// a plain dot, so this uses a flat "butt" cap instead. A small floor on the
// dash length keeps a real-but-tiny fraction visible as an actual sliver
// rather than an invisible hairline (exact numbers are in the legend text
// regardless, so this is a legibility choice, not a misrepresentation).
// A fraction of exactly 0 still skips the overlay entirely - no sliver to show.
const MIN_VISIBLE_RING_DASH_PX = 4;

function ringMarkup(cx, cy, radius, strokeWidth, fraction, color, glowId) {
  const track = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${TRACK_COLOR}" stroke-width="${strokeWidth}" />`;
  const clamped = Math.max(0, Math.min(1, fraction));
  if (clamped <= 0) return track;
  const circumference = 2 * Math.PI * radius;
  const dash = Math.max(clamped * circumference, MIN_VISIBLE_RING_DASH_PX);
  const progress =
    `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" ` +
    `stroke-linecap="butt" stroke-dasharray="${dash.toFixed(2)} ${circumference.toFixed(2)}" ` +
    `transform="rotate(-90 ${cx} ${cy})" filter="url(#${glowId})" />`;
  return track + progress;
}

// Ring fill = how much of LeetCode's actual problem set at that difficulty
// has been solved (platformTotals), NOT an acceptance rate - a handful of
// solved Easy problems should read as a thin sliver of ~960 Easy problems,
// not a full ring, same as LeetCode's own profile page.
function buildStatsSvg(stats, solvedProblems, platformTotals) {
  const cx = 150;
  const cy = 172;
  const radii = { Easy: 104, Medium: 78, Hard: 52 };
  const width = CARD_WIDTH;
  const height = 340;
  const legendWidth = width - LEGEND_X - 30;
  const totals = platformTotals || {};

  const solvedByDifficulty = { Easy: 0, Medium: 0, Hard: 0 };
  Object.values(solvedProblems || {}).forEach((difficulty) => {
    if (solvedByDifficulty[difficulty] !== undefined) solvedByDifficulty[difficulty] += 1;
  });
  const totalSolved = Object.values(solvedByDifficulty).reduce((a, b) => a + b, 0);

  const rings = DIFFICULTY_ORDER.map((key) => {
    const platformTotal = totals[key] || 0;
    const fraction = platformTotal > 0 ? solvedByDifficulty[key] / platformTotal : 0;
    return ringMarkup(cx, cy, radii[key], 16, fraction, DIFFICULTY_COLORS[key], "stats-glow");
  }).join("");

  const legend = DIFFICULTY_ORDER.map((key, i) => {
    const d = stats[key] || { accepted: 0, total: 0 };
    const platformTotal = totals[key];
    const y = 96 + i * (LEGEND_ROW_HEIGHT + LEGEND_ROW_GAP);
    const coverage = platformTotal
      ? `${solvedByDifficulty[key]} of ${platformTotal.toLocaleString()} solved`
      : `${solvedByDifficulty[key]} solved`;
    const subtitle = d.total > 0 ? `${coverage} &#183; ${d.accepted}/${d.total} attempts` : coverage;
    return legendChip(LEGEND_X, y, legendWidth, DIFFICULTY_COLORS[key], key, subtitle);
  }).join("");

  const overallTotal = DIFFICULTY_ORDER.reduce((sum, key) => sum + (stats[key]?.total || 0), 0);
  const overallAccepted = DIFFICULTY_ORDER.reduce((sum, key) => sum + (stats[key]?.accepted || 0), 0);
  const acceptanceRate = overallTotal > 0 ? Math.round((overallAccepted / overallTotal) * 100) : 0;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    glowFilterDefs("stats-glow", 4) +
    cardShell(width, height, "LeetCode Stats") +
    rings +
    `<text x="${cx}" y="${cy - 8}" text-anchor="middle" fill="${TEXT_PRIMARY}" font-family="${CARD_FONT}" font-size="42" font-weight="700">${totalSolved}</text>` +
    `<text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="${TEXT_SECONDARY}" font-family="${CARD_FONT}" font-size="13">problems solved</text>` +
    legend +
    `<text x="30" y="${height - 24}" fill="${TEXT_SECONDARY}" font-family="${CARD_FONT}" font-size="12">` +
    `${overallAccepted}/${overallTotal} submissions accepted (${acceptanceRate}%)</text>` +
    `</svg>`
  );
}

async function commitStatsSvg(token, repo, stats, solvedProblems, platformTotals) {
  const svg = buildStatsSvg(stats, solvedProblems, platformTotals);
  const existing = await getFile(token, repo, STATS_SVG_PATH);
  await putFile(token, repo, STATS_SVG_PATH, svg, "Update LeetCode stats", existing?.sha);
}

function buildTopicsSvg(topicCounts) {
  const entries = Object.entries(topicCounts || {}).sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, MAX_TOPIC_SLICES);
  const restTotal = entries.slice(MAX_TOPIC_SLICES).reduce((sum, [, count]) => sum + count, 0);
  const slices = restTotal > 0 ? [...top, ["Other", restTotal]] : top;
  const total = slices.reduce((sum, [, count]) => sum + count, 0);

  const width = CARD_WIDTH;
  const cx = 150;
  const cy = 172;
  const outerR = 104;
  const innerR = 62;
  const legendWidth = width - LEGEND_X - 30;
  const height = Math.max(340, 96 + slices.length * (LEGEND_ROW_HEIGHT + LEGEND_ROW_GAP) + 30);

  let angle = 0;
  const slicePaths = [];
  slices.forEach(([topic, count], i) => {
    const color = topic === "Other" ? OTHER_TOPIC_COLOR : TOPIC_COLORS[i % TOPIC_COLORS.length];
    const sliceAngle = total > 0 ? (count / total) * 360 : 0;
    if (slices.length === 1) {
      slicePaths.push(`<circle cx="${cx}" cy="${cy}" r="${outerR}" fill="${color}" />`);
    } else if (sliceAngle > 0) {
      slicePaths.push(
        `<path d="${donutSlicePath(cx, cy, outerR, innerR, angle, angle + sliceAngle)}" fill="${color}" stroke="${CARD_BG}" stroke-width="2" />`
      );
    }
    angle += sliceAngle;
  });
  const donut =
    total > 0
      ? `<g filter="url(#topics-glow)">${slicePaths.join("")}</g><circle cx="${cx}" cy="${cy}" r="${innerR}" fill="${CARD_BG}" />`
      : `<circle cx="${cx}" cy="${cy}" r="${outerR}" fill="none" stroke="${TRACK_COLOR}" stroke-width="16" />`;

  const legend = slices
    .map(([topic, count], i) => {
      const color = topic === "Other" ? OTHER_TOPIC_COLOR : TOPIC_COLORS[i % TOPIC_COLORS.length];
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      const y = 96 + i * (LEGEND_ROW_HEIGHT + LEGEND_ROW_GAP);
      return legendChip(LEGEND_X, y, legendWidth, color, escapeXmlText(topic), `${count} solved &#183; ${pct}%`);
    })
    .join("");

  const centerLabel =
    total > 0
      ? `<text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="${TEXT_PRIMARY}" font-family="${CARD_FONT}" font-size="36" font-weight="700">${total}</text>` +
        `<text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="${TEXT_SECONDARY}" font-family="${CARD_FONT}" font-size="12">topics tagged</text>`
      : `<text x="${cx}" y="${cy}" text-anchor="middle" fill="${TEXT_SECONDARY}" font-family="${CARD_FONT}" font-size="13">No data yet</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    glowFilterDefs("topics-glow", 3) +
    cardShell(width, height, "Topics Breakdown") +
    donut +
    centerLabel +
    legend +
    `</svg>`
  );
}

async function commitTopicsSvg(token, repo, topicCounts) {
  const svg = buildTopicsSvg(topicCounts);
  const existing = await getFile(token, repo, TOPICS_SVG_PATH);
  await putFile(token, repo, TOPICS_SVG_PATH, svg, "Update topics breakdown", existing?.sha);
}

function indexRowMarker(titleSlug) {
  return `<!-- id:${sanitizeSlug(titleSlug)} -->`;
}

function buildIndexRow(payload, finalStatus) {
  const slug = sanitizeSlug(payload.titleSlug);
  const link = `https://leetcode.com/problems/${encodeURIComponent(slug)}/`;
  const title = escapeMarkdownLinkText(payload.title);
  const tags = (payload.topicTags || []).map(escapeMarkdownCell).join(", ");
  const difficulty = escapeMarkdownCell(payload.difficulty ?? "");
  const statusLabel = finalStatus === "Accepted" ? "✅ Accepted" : `⏳ ${escapeMarkdownCell(finalStatus)}`;
  return (
    `| ${sanitizeFrontendId(payload.questionFrontendId)} | [${title}](${link}) | ` +
    `${difficulty} | ${tags} | ${statusLabel} |${indexRowMarker(slug)}`
  );
}

// Read-modify-write of the root README index. Never downgrades a problem's
// status once it has been marked Accepted, even if a later attempt fails.
// Also self-heals the stats block + table header into a README that predates
// this feature, or one that was never generated by this extension at all.
async function updateIndex(token, repo, payload) {
  const existing = await getFile(token, repo, README_PATH);
  const marker = indexRowMarker(payload.titleSlug);
  let finalStatus = payload.statusDisplay;
  let lines = existing ? existing.content.split("\n") : [];

  const statsBlockLines = buildStatsBlock().split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === STATS_BLOCK_START);
  const endIdx = lines.findIndex((line) => line.trim() === STATS_BLOCK_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    lines.splice(startIdx, endIdx - startIdx + 1, ...statsBlockLines);
  } else {
    lines = [...statsBlockLines, "", ...lines];
  }

  let headerIdx = lines.findIndex((line) => line.trim() === TABLE_HEADER_LINES[0]);
  if (headerIdx === -1) {
    lines.push("", ...TABLE_HEADER_LINES);
    headerIdx = lines.length - TABLE_HEADER_LINES.length;
  }

  // The table body is whatever "| ... |" lines sit directly below the header +
  // separator, with no gap. A new row MUST be spliced in right after the last
  // of those — pushing it to the end of the file instead leaves a blank-line
  // gap that breaks GitHub's Markdown table parsing (the row then renders as
  // plain text below the table instead of as part of it).
  let tableEndIdx = headerIdx + 2;
  while (tableEndIdx < lines.length && lines[tableEndIdx].trim().startsWith("|")) {
    tableEndIdx++;
  }

  const rowIndex = lines.findIndex(
    (line, idx) => idx >= headerIdx + 2 && idx < tableEndIdx && line.includes(marker)
  );
  if (rowIndex !== -1 && lines[rowIndex].includes("Accepted")) {
    finalStatus = "Accepted";
  }
  const newRow = buildIndexRow(payload, finalStatus);
  if (rowIndex !== -1) {
    lines[rowIndex] = newRow;
  } else {
    lines.splice(tableEndIdx, 0, newRow);
  }

  const newContent = lines.join("\n") + "\n";
  await putFile(token, repo, README_PATH, newContent, `Update index: ${payload.title}`, existing?.sha);
}

async function commitAttemptFile(token, repo, path, content, message) {
  await putFile(token, repo, path, content, message);
}

function activityBase(payload) {
  return {
    submissionId: payload.submissionId,
    titleSlug: payload.titleSlug,
    title: payload.title,
    difficulty: payload.difficulty,
    statusDisplay: payload.statusDisplay,
  };
}

async function syncSubmission(payload) {
  if (await alreadySynced(payload.submissionId)) {
    console.log("[LeetCode->GitHub] already synced, skipping", payload.submissionId);
    await logActivity({ ...activityBase(payload), outcome: "skipped" });
    return { ok: true, skipped: true };
  }

  const { githubToken, githubRepo, basePath, syncFailedAttempts, locked } = await getSettings();
  if (locked) {
    setBadge("🔒", "#c0392b");
    chrome.action.setTitle({ title: "LeetCode to GitHub Sync: locked - unlock to sync" });
    console.warn("[LeetCode->GitHub] token is locked - unlock from the extension popup");
    await logActivity({ ...activityBase(payload), outcome: "locked" });
    // Parked in the same slot the retry button already drains, so unlocking
    // and hitting Retry replays this submission instead of losing it.
    await setLastFailedSync({
      payload,
      title: payload.title,
      errorMessage: "Token is locked - unlock in the popup, then retry",
    });
    return { ok: false, reason: "locked" };
  }
  if (!githubToken || !githubRepo) {
    setBadge("!", "#c0392b");
    chrome.action.setTitle({ title: "LeetCode to GitHub Sync: not configured - open options" });
    console.warn("[LeetCode->GitHub] settings not configured yet - open the options page");
    await logActivity({ ...activityBase(payload), outcome: "not_configured" });
    return { ok: false, reason: "not_configured" };
  }

  if (payload.statusDisplay !== "Accepted" && !syncFailedAttempts) {
    console.log("[LeetCode->GitHub] failed-attempt syncing disabled, skipping", payload.titleSlug);
    await logActivity({ ...activityBase(payload), outcome: "disabled" });
    return { ok: true, skipped: true, reason: "failed_sync_disabled" };
  }

  const safeSlug = sanitizeSlug(payload.titleSlug);
  if (!safeSlug) {
    console.warn("[LeetCode->GitHub] refusing to sync a submission with an unusable slug", payload.titleSlug);
    await logActivity({ ...activityBase(payload), outcome: "failed", errorMessage: "Unrecognised problem slug" });
    return { ok: false, reason: "invalid_slug" };
  }

  const attemptNumber = await peekNextAttemptNumber(safeSlug);
  const statusSlug = slugifyStatus(payload.statusDisplay);
  const extension = fileExtensionFor(payload.lang);
  const problemFolder = `${basePath}/${sanitizeFrontendId(payload.questionFrontendId) || "0"}-${safeSlug}`;
  const filePath = `${problemFolder}/attempt-${attemptNumber}-${statusSlug}.${extension}`;
  const commitMessage = `${payload.statusDisplay}: ${payload.title} (attempt ${attemptNumber})`;

  try {
    await withRetry(
      () => commitAttemptFile(githubToken, githubRepo, filePath, payload.code, commitMessage),
      "commit attempt file"
    );
    await commitAttemptNumber(safeSlug, attemptNumber);
    await markSynced(payload.submissionId);
    console.log("[LeetCode->GitHub] synced", filePath);

    if (payload.difficulty) {
      try {
        const { stats, solvedProblems, topicCounts } = await updateStats(payload);
        const platformTotals = await getPlatformTotals();
        await withRetry(
          () => commitStatsSvg(githubToken, githubRepo, stats, solvedProblems, platformTotals),
          "stats svg update"
        );
        try {
          await withRetry(() => commitTopicsSvg(githubToken, githubRepo, topicCounts), "topics svg update");
        } catch (err) {
          console.error("[LeetCode->GitHub] topics svg update failed", err);
        }
      } catch (err) {
        console.error("[LeetCode->GitHub] stats svg update failed", err);
      }
    }

    try {
      await withRetry(() => updateIndex(githubToken, githubRepo, payload), "index update");
    } catch (err) {
      console.error("[LeetCode->GitHub] index update failed", err);
    }

    setBadge("", null);
    chrome.action.setTitle({ title: "LeetCode to GitHub Sync" });
    await clearLastFailedSync();
    await logActivity({ ...activityBase(payload), outcome: "success", repo: githubRepo, filePath });
    return { ok: true, path: filePath };
  } catch (err) {
    console.error("[LeetCode->GitHub] commit failed", err);
    setBadge("!", "#c0392b");
    chrome.action.setTitle({
      title: `LeetCode to GitHub Sync: last sync failed - ${String(err).slice(0, 150)}`,
    });
    await setLastFailedSync({ payload, title: payload.title, errorMessage: String(err) });
    await logActivity({ ...activityBase(payload), outcome: "failed", errorMessage: String(err) });
    return { ok: false, reason: "commit_failed", error: String(err) };
  }
}

async function retryLastFailedSync() {
  const { lastFailedSync } = await chrome.storage.local.get("lastFailedSync");
  if (!lastFailedSync) return { ok: false, reason: "nothing_to_retry" };
  return syncSubmission(lastFailedSync.payload);
}

// A running backfill heartbeats on every progress write. The widest legitimate
// gap between two writes is one cooldown plus a worst-case run of LeetCode and
// GitHub retry backoffs, which lands around a minute - so a lock older than
// this means the tab it was running in is gone, not that it's still working.
const BACKFILL_STALE_MS = 3 * 60 * 1000;

function isBackfillStale(status) {
  return Date.now() - (status?.heartbeatAt ?? 0) > BACKFILL_STALE_MS;
}

// The actual history fetch + per-submission sync loop lives in content.js -
// it runs in LeetCode's own page context, which is what lets it read the
// session cookie needed for LeetCode's submissions API and GraphQL endpoint.
// This just finds a LeetCode tab to relay the request to and kicks it off;
// progress after that is reported via chrome.storage.local ("backfillStatus"),
// which the popup listens to directly.
async function startBackfill() {
  const { backfillStatus } = await chrome.storage.local.get("backfillStatus");
  if (backfillStatus?.running && !isBackfillStale(backfillStatus)) {
    return { ok: false, reason: "already_running" };
  }

  const tabs = await chrome.tabs.query({ url: "https://leetcode.com/problems/*" });
  const tab = tabs[0];
  if (!tab) {
    return { ok: false, reason: "no_leetcode_tab" };
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "RUN_BACKFILL" });
    return { ok: true };
  } catch (err) {
    console.error("[LeetCode->GitHub] could not reach content script for backfill", err);
    return { ok: false, reason: "content_script_unreachable", error: String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SYNC_SUBMISSION") {
    syncSubmission(message.payload).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (message?.type === "RETRY_LAST_FAILED") {
    retryLastFailedSync().then(sendResponse);
    return true;
  }
  if (message?.type === "START_BACKFILL") {
    startBackfill().then(sendResponse);
    return true;
  }
  return false;
});
