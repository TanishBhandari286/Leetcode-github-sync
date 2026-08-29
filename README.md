# LeetCode to GitHub Sync

A Chrome extension that watches your LeetCode submissions and pushes them to a GitHub repo of your choice automatically. Every submission gets committed — not just the ones that pass — so your repo ends up as a real record of how you actually solved each problem, not just a highlight reel.

It also keeps a README in that repo up to date with a solved-problems index, two auto-generated stat visualizations (difficulty rings and a topics breakdown), so the repo is something you'd actually want to look back at.

**This is Chromium-only for now** — Chrome, Brave, Edge, Arc, that kind of thing. No Firefox support yet.

## Setup

### 1. Clone this repo

```
git clone https://github.com/TanishBhandari286/leetcode-github-sync.git
```

### 2. Turn on developer mode in Chrome

Extensions that aren't from the Chrome Web Store need developer mode turned on before Chrome will load them.

1. Open `chrome://extensions` in a new tab.
2. Look for the **Developer mode** toggle in the top-right corner of the page.
3. Turn it on. A few extra buttons will appear, including "Load unpacked".

### 3. Load the extension

1. Still on `chrome://extensions`, click **Load unpacked**.
2. In the file picker, select the `leetcode-github-sync` folder you just cloned (the one with `manifest.json` in it — not a file inside it, the folder itself).
3. It should show up in your extensions list with no errors. If Chrome complains, double check you selected the right folder.

### 4. Create a GitHub personal access token

The extension needs a token to push commits on your behalf. Here's how to make one:

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens/new) (or navigate manually: click your profile picture → **Settings** → scroll down to **Developer settings** on the left → **Personal access tokens** → **Tokens (classic)**).
2. Click **Generate new token** → **Generate new token (classic)**.
3. Give it a name you'll recognize later, like "leetcode-sync".
4. Set an expiration if you want one (or "No expiration" if you'd rather not think about it again).
5. Under **Select scopes**, check the box for **`repo`**. That's it — that one checkbox covers everything the extension needs (creating files, updating them, reading repo info). If your tracking repo is going to be public and you'd rather scope things down a bit, you can check just **`public_repo`** instead, which does the same thing but only for public repos.
6. Scroll down and click **Generate token**.
7. Copy the token now — GitHub only shows it to you once. If you lose it, you'll have to generate a new one.

We recommend the **classic** token over a fine-grained one here. Fine-grained tokens are more precise in theory, but GitHub's UI makes it easy to grant read-only access by mistake, and the permission changes don't always take effect without regenerating the token. Classic tokens with the `repo` scope just work.

### 5. Create the repo you want your solutions pushed to

This is separate from the extension's own repo — it's wherever *your* solved problems will actually live. Go to GitHub and create a new repo (public or private, your call). It can start completely empty; the extension will create everything it needs inside it.

### 6. Configure the extension

1. Go back to `chrome://extensions`, find "LeetCode to GitHub Sync", and open its options page (click **Details** → **Extension options**, or right-click the extension's icon in your toolbar and choose **Options**).
2. Paste in the personal access token you generated.
3. Enter your target repo in the form `your-username/your-repo-name`.
4. Optionally set a base folder name (defaults to `problems`).
5. Click **Validate & Save**. If everything's right, you'll see a confirmation message. If not, it'll tell you what's wrong (bad token, wrong repo name, missing permissions, etc.).

### 7. That's it

Go solve a problem on LeetCode like you normally would. Hit Submit. A minute or so later, check your repo — the solution should be sitting there, along with an updated README showing your progress. No further action needed on your end; it just runs in the background from here.

## A couple of things worth knowing

- The extension only acts when you click **Submit** on a LeetCode problem page. If you reload the extension itself (say, because you pulled an update), also reload any open LeetCode tabs — otherwise the page is still running the old version of the content script and nothing will sync until you refresh it.
- Click the extension's toolbar icon any time to see a log of recent syncs, including any that failed and why, with a retry button.
- If a sync fails repeatedly, it's almost always the token — check that it hasn't expired and still has the right scope.
