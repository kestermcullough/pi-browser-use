# pi-browser-use

Pi extension built on the [Browser Use SDK](https://github.com/browser-use/browser-use-pi). Adds shared dedicated Chrome, per-session tabs and REPLs, crash recovery, and automatic cleanup—without touching personal Chrome.

Designed against `@browser_use/pi` 0.1.0. Setup/update agents must review the current SDK/API and adjust integration and tests when needed; the SDK dependency is deliberately unpinned.

## Requirements and install

macOS on Apple Silicon, Node.js 22.19+, and Pi.

```sh
git clone https://github.com/kestermcullough/pi-browser-use.git
cd pi-browser-use
npm install
npm run setup
pi install .
```

Then run `/reload` in Pi.

## Use

`/browser open https://example.com`, `/browser status`, and `/browser close` manage your dedicated browser client. The `browser_use` tool accepts JavaScript with top-level await:

```js
await page.goto('https://example.com');
console.log(await page.info());
console.log(await page.snapshot());
```

Pi sessions share one browser with separate tabs and JavaScript state. The final session exit closes it automatically.

`page`, `tabs`, and `browser` persist within a client. `tabs.list()`/`tabs.get()` show your tabs and popups; use `/browser close`, not `Browser.close`, to release your client. Inspect results before retrying uncertain actions.

## Privacy and safety

This uses host-access JavaScript and raw CDP; it is not a sandbox. Treat website content as untrusted. The dedicated browser profile retains logins and is sensitive credential material; it is separate from personal Chrome. No nested model API key is required.
