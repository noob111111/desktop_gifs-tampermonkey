Release: Desktop GIFs — Tampermonkey standalone v2026-10-15

Tag: v2026-10-15

Files:
- desktop_gifs.user.js (root)
  https://raw.githubusercontent.com/noob111111/desktop_gifs-tampermonkey/main/desktop_gifs.user.js

Notes:
This release publishes a standalone Tampermonkey userscript that merges the original
Chrome/Firefox extension functionality into a single userscript. It implements:
- picker UI injected into YouTube comment boxes
- page hook that wraps window.fetch and rewrites armed markers into GIF comments
- Tenor API access and caching (uses stored keys read from tenor.com)
- favorites stored across tabs using GM storage
- update check against the repository releases

Install: open the raw URL and install with Tampermonkey/Greasemonkey.

Create the release with GitHub CLI (recommended):

  # create release with tag v2026-10-15 and upload the userscript as an asset
  gh release create v2026-10-15 ./desktop_gifs.user.js \
    --title "Desktop GIFs — Tampermonkey standalone v2026-10-15" \
    --notes "Standalone Tampermonkey userscript merging extension functionality (picker, Tenor searches, favorites, page hook to post GIFs). Install via Tampermonkey on https://www.youtube.com/."

If you don't have gh installed, use curl + the GitHub API (replace GITHUB_TOKEN):

  curl -H "Authorization: token YOUR_GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    https://api.github.com/repos/noob111111/desktop_gifs-tampermonkey/releases \
    -d '{"tag_name":"v2026-10-15","name":"Desktop GIFs — Tampermonkey standalone v2026-10-15","body":"Standalone Tampermonkey userscript merging extension functionality (picker, Tenor searches, favorites, page hook to post GIFs). Install via Tampermonkey on https://www.youtube.com/.","draft":false,"prerelease":false}'

Then upload the asset (replace UPLOAD_URL from the response and the path to the file):

  curl -H "Authorization: token YOUR_GITHUB_TOKEN" \
    -H "Content-Type: application/javascript" \
    --data-binary @desktop_gifs.user.js "UPLOAD_URL?name=desktop_gifs.user.js"

Fallback tag: v1.0.0
If you prefer a semantic version tag instead of today's date, use v1.0.0 (or tell me what tag you want) and run the same commands with that tag.

Notes about grants and installation:
- The userscript uses GM_xmlhttpRequest for cross-origin calls to Tenor and GitHub; install with Tampermonkey or another manager and accept the requested permissions when prompted.
- If your userscript manager exposes different GM APIs, the script includes simple fallbacks but GM_xmlhttpRequest is required for Tenor calls to avoid CORS.

If you want, I can:
- create a release draft file in the repo (this file already added),
- or prepare a zip containing desktop_gifs.user.js and upload it for you to attach.
