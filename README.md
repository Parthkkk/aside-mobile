# Aside Mobile

Your Mac's [Aside](https://aside.so) agent as a real app on your phone.
Chat, watch the browser live, search your Mac's history, talk to it, and get
a push when a long task finishes.

This is the Mini App installed to a phone rather than opened in Telegram. It
talks to your Mac over Tailscale, so nothing is exposed to the internet.

**Android** gets a native APK with Google Search rendered inside the app.
**iPhone** gets a home-screen web app. Same server behind both.

This started inside
[aside-telegram-bridge](https://github.com/Parthkkk/aside-telegram-bridge)
and was split out, because the phone app has nothing to do with Telegram and
you should not need a bot token to run it. If you want the Telegram bot as
well, it lives there.

---

## Handing this to an AI agent

[AGENTS.md](AGENTS.md) is the procedure, written for an agent rather than a
reader: every step has a check, and it says where a human is genuinely
needed. Give an agent the repo link and say:

> Set this up. Follow AGENTS.md top to bottom. Ask me only when you need a
> password, my phone in my hand, or a decision.

When it is done, `cd miniapp && npm run doctor` verifies the whole install
and exits with the number of failures.

The rest of this README is the same thing for a person, with more of the
reasoning.

---

## What you need

**Mac:** macOS with [Aside](https://aside.so) installed and signed in. That
is the only thing assumed. Admin password once, for Tailscale. About 1GB
free, plus 4GB more to build the Android app.

**Phone:** the Tailscale app, signed into the same account, connected. The
Mac is only reachable over the tailnet, so without it the app has nothing to
talk to. Android 8.0+ or iOS 16.4+.

Free throughout. No Apple Developer account, no Play Console, no paid tunnel.

---

## 1. Toolchain

```bash
which brew || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
export PATH="/opt/homebrew/bin:$PATH"
echo 'export PATH="/opt/homebrew/bin:$PATH"' >> ~/.zshrc
brew install node
node --version   # v22.5 or newer
```

**v22.5 is a real floor, not a suggestion.** Browser history and the session
state cache read Chrome's SQLite through `node:sqlite`, which landed in
22.5. Both imports are wrapped in a try/catch, so an older Node starts
normally and then quietly has no history and no search. Nothing errors; the
feature is just gone.

Apple Silicon puts Homebrew in `/opt/homebrew`, which is not on the default
`PATH`, which is why that line is there.

## 2. Code

```bash
git clone https://github.com/Parthkkk/aside-mobile.git ~/aside-mobile
cd ~/aside-mobile/miniapp
npm run setup
```

Installs both workspaces, builds the server and the web app, then runs the
doctor. A couple of minutes.

No configuration file is needed. A fresh clone runs in standalone mode: no
Telegram, no bot token, pairing from the loopback page.

If `npm install` dies inside `esbuild` with a SIGKILL, macOS quarantined the
download, and re-running hits the same wall. Do this instead:

```bash
rm -rf node_modules
npm install --ignore-scripts
xattr -dr com.apple.quarantine node_modules
npm rebuild
```

## 3. Tailscale

This is what makes the Mac reachable from the phone without opening a port
to the internet.

```bash
brew install --cask tailscale
open -a Tailscale
```

Sign in, then do the same on the phone with the same account. Confirm:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale status
```

Capture the Mac's tailnet hostname, which several later steps want:

```bash
export ASIDE_TAILNET_HOST=$(/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
echo "export ASIDE_TAILNET_HOST=$ASIDE_TAILNET_HOST" >> ~/.zshrc
echo "$ASIDE_TAILNET_HOST"     # looks like your-mac.tail1234.ts.net
```

Turn on HTTPS in the [Tailscale admin console](https://login.tailscale.com/admin/dns)
under **HTTPS Certificates**. You get a real Let's Encrypt certificate for
that hostname. This is required: a phone browser rejects a self-signed
certificate, and Web Push needs genuine HTTPS.

Put the server behind it:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 8790
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
```

## 4. Server

```bash
cd ~/aside-mobile/miniapp/server
npm start
```

First run generates its own signing secret at
`~/.aside-mobile/miniapp-secret.json`, `chmod 600`. It never enters the
repo. (A machine that also runs the Telegram bridge keeps using the
bridge's own state directory instead, so the two do not collide.)

With no bot token configured the server runs in standalone mode, and `/`
redirects to `/app`. There is one address to remember and it is the bare
hostname.

```bash
curl -s http://127.0.0.1:8790/api/health              # {"ok":true}
curl -sI "https://$ASIDE_TAILNET_HOST/app" | head -1  # HTTP/2 200
```

If the second fails, Tailscale HTTPS is not on yet. Back to step 3.

### Keeping it up

The phone needs the Mac awake and the server running.

- **Stop the Mac sleeping.** [Amphetamine](https://apps.apple.com/app/amphetamine/id937984704)
  is free, or System Settings, Battery, prevent sleeping while on power.
- **Keep the server alive.** Leave `npm start` in a terminal, or install the
  launchd job so it survives a reboot:

  ```bash
  cd ~/aside-mobile/miniapp
  npm run launchd            # npm run launchd -- off  to remove
  ```

  It writes `~/Library/LaunchAgents/com.aside.mobile.plist`, starts the job,
  and waits until the server actually answers before reporting success.
  Logs land in `~/Library/Logs/com.aside.mobile.log`.

## 5. Pair

On the Mac, open <http://127.0.0.1:8791/pair>.

Note the port: 8791, not 8790. The pairing page runs on its own listener,
bound to loopback, and `tailscale serve` proxies only 8790. A device already
on your tailnet cannot reach it. Pairing requires access to the Mac itself.

(It lived on 8790 behind an IP check until an audit showed the check was
meaningless: Tailscale terminates TLS and proxies to loopback, so every
tailnet request presented as `127.0.0.1` and passed. Port 8790 now refuses
`/pair` for everyone and points here.)

It shows a QR code and a link. What happens next depends on the phone.

---

## Android

### Build it

```bash
brew install --cask temurin@21
brew install --cask android-commandlinetools
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
export ANDROID_HOME=$HOME/Library/Android/sdk
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"

cd ~/aside-mobile
./build-android.sh
```

The script resolves your tailnet hostname, bakes in a pairing key so the app
is already paired on first open, builds, and publishes to
`https://<your-tailnet-host>/Aside-mobile.apk`. Open that on the phone and
allow installs from unknown sources.

**Expect about 99MB.** Reason below.

**If Gradle gets killed on an 8GB Mac**, that is memory. The script already
passes what avoids it:

```
--no-daemon --max-workers=1 -Dorg.gradle.jvmargs="-Xmx1280m -XX:MaxMetaspaceSize=384m"
```

Leave those alone.

### About the scary install warnings

Android will warn you, more than once, and the warnings are worth reading
rather than clicking past. Here is what each one actually means.

**"Your browser is not allowed to install unknown apps."** Android only
trusts the Play Store by default. You are installing an APK you built
yourself from a link on your own machine, so it asks you to grant that one
app permission to install. This is the same prompt F-Droid and every beta
build trigger. Grant it to whichever app opened the link, and revoke it
afterwards if you like.

**"This type of file can harm your device."** Chrome says this about every
`.apk`, always, regardless of what is in it. It is a blanket message about
the file extension.

**"App scanned, no problems detected"** or **"Send app for scanning?"** This
is Play Protect. Let it scan. It is checking the app against Google's
malware set and it will pass, because there is nothing in it to find.

**"Unsafe app blocked" or an install that just fails.** Play Protect
sometimes blocks sideloaded apps it has never seen before, which is a
statement about popularity rather than about content. Choose "Install
anyway" if you are offered it. If not, Settings, Google, Play Protect, then
turn off scanning long enough to install and turn it back on afterwards.

**Why it is unsigned.** Publishing an app that installs without any warning
means paying Google $25 for a Play Console account and going through review,
or distributing a release build signed with a certificate you have to manage
and trust anyway. For an app that only talks to your own Mac over your own
private network, that ceremony buys nothing. So this is a debug build, and
Android is right to tell you it came from outside the store.

**How to check you got what you think you got.** The APK never leaves your
tailnet, so the realistic risk is not interception. If you want certainty
anyway, compare the checksum of what your phone downloaded against what your
Mac built:

```bash
shasum -a 256 ~/aside-mobile/miniapp/web/android/app/build/outputs/apk/debug/app-debug.apk
```

**What the app can actually do.** It asks for microphone (voice input) and
internet: those are the only two permissions in the manifest, alongside
audio-mode control that the mic needs. Push (the alert when a task finishes)
arrives through Web Push inside the browser engine, so it is a site
permission you grant in the app, not a native Android one. It has no
contacts, location, camera, SMS or storage access. The code is in this repo; the
permissions are declared in
`miniapp/web/android/app/src/main/AndroidManifest.xml` and you can read the
whole list in a minute.

**If you would rather have no warnings at all**, use the iPhone instructions
below on an iPhone, or just open `https://<your-tailnet-host>/` in Chrome
on Android and add it to your home screen. That gets you the same app as a
web app with no APK involved. You lose the in-app GeckoView search and keep
everything else.

### Why 99MB

Search runs inside the app, and staying signed into Google is what costs the
space.

Android's WebView stamps every request with an `X-Requested-With` header
naming the host app. Google reads it and refuses to sign you in. The header
cannot be removed; the opt-out was withdrawn in 2025. Google also
fingerprints the JS environment and the TLS handshake, so spoofing the user
agent fails too.

A Chrome Custom Tab stays signed in, and ordinary links still use one. Its
toolbar cannot be hidden, because showing the true origin is the point of it.

So search renders with [GeckoView](https://mozilla.github.io/geckoview/),
Firefox's engine embedded as an Android view. Google sees a real browser,
your account works, and it paints in a window the app owns with nothing on
top. Gecko's native libraries are the size.

Only `arm64-v8a` ships, covering phones from roughly 2017 on. Add ABIs in
`miniapp/web/android/app/build.gradle` for an emulator.

---

## iPhone

No App Store, no Xcode, no developer account. It installs as a home-screen
web app.

Apple requires WebKit for every iOS browser, so the GeckoView approach
cannot be ported. Alternative engines exist only under an EU-restricted
entitlement. A native wrapper would also need re-signing every 7 days on a
free Apple ID. The web app avoids all of that and costs nothing.

### Install

1. On the iPhone, open **Safari** and go to
   `https://<your-tailnet-host>/` (or `/app`, they are the same page). It
   has to be Safari. Chrome and Firefox on iOS have no Add to Home Screen.
2. **Share**, then **Add to Home Screen**, then **Add**.
3. Open Aside from the home screen. Not from Safari.
4. It asks to be paired. On the Mac, open <http://127.0.0.1:8791/pair> and
   press **Copy** next to the link, then paste it into the app. Universal
   Clipboard makes that a copy on one device and a paste on the other.

Do **not** pair by scanning the QR on an iPhone. That pairs the Safari tab,
and the app you install afterwards gets its own storage and will ask again.
The pairing page spells both orders out.

**Step 3 matters, and step 4 is the consequence.** iOS gives a Safari tab
and an installed web app separate storage. Pairing in Safari then installing
leaves you with an app that has never seen your key, so it asks directly.
Paste the whole link; it extracts the key.

Installing also earns two things a tab never gets:

- **Push notifications.** WebKit exposes the Push API only to installed web
  apps.
- **Storage that survives.** Safari wipes script-writable storage for idle
  sites after 7 days. Installed web apps are exempt, so you stay paired.

### Difference from Android

Chat, voice, history, browser view, push and uploads all behave the same.
Search differs: a result opens iOS's in-app browser overlay, signed in and
without leaving the app, but carrying a small toolbar. Apple's engine rules
make the Android behaviour unavailable.

---

## Layout

```
AGENTS.md          Setup procedure, written to be executed by an agent
miniapp/
  server/    Fastify API on :8790, talks to the Aside daemon
             (the pairing page is a second listener on :8791, loopback only)
  web/       React + Vite front end, and the Capacitor Android shell
    android/ Native project; GeckoView lives in BrowserActivity.java
    scripts/ gen-splash.mjs regenerates the iOS launch screens
  scripts/   doctor.mjs verifies an install; install-launchd.mjs keeps it up
build-android.sh   Builds and publishes the APK
```

Runtime state (the signing secret, media, an archived APK, and Tailscale's
socket and logs if you run a userspace tailscaled) is created per-machine
under `~/.aside-mobile/`. None of it is part of this repo.

```bash
cd miniapp/web && npx vitest run      # 198 tests
cd miniapp/server && npx vitest run   # 553 tests
cd miniapp && npm run typecheck       # both workspaces
cd miniapp && npm run doctor          # verifies a real install end to end
```

GitHub Actions runs the tests, the typecheck and both builds on node 22 and
24 for every push and pull request, plus two guards for regressions that
have already happened once each: no committed home-directory paths, and no
writes into the Telegram bridge's directory.

---

## Security

- Nothing listens on the public internet. The server binds loopback by
  default (`MINIAPP_HOST` can widen it: do not); Tailscale is the only way
  in.
- The pairing page is on a second listener, hardwired to loopback on 8791,
  which `tailscale serve` does not proxy. Tailnet access alone cannot pair a
  device. Do not add a `serve` rule for that port.
- The APK that `build-android.sh` publishes to your tailnet carries a baked
  pairing key so a fresh install self-pairs. On a solo tailnet that is fine.
  If you ever share the tailnet, stop publishing it there: anyone who can
  download the APK can read the key out of `assets/capacitor.config.json`.
- Telegram is off unless you configure it, and `/api/auth` is refused
  outright in that state. That route validates Telegram's `initData` by
  HMAC with the bot token as the key, so an empty token would be a key
  anyone can reproduce. No token means no route, and pairing is the only
  way in.
- The signing secret is per-install, `chmod 600`, outside the repo, and
  gitignored.
- **The pairing key is not one-time.** It is `sha256(secret + tag)`, so the
  pairing page shows the same key every time and it stays valid until the
  secret changes. Treat the link like a password: anyone holding it who is
  also on your tailnet can mint a 90-day session.
- Rate limits are keyed on the socket address, never on a header, which is
  the only key a client cannot choose. Behind a proxy that means every
  request shares one bucket, so a client hammering `/api/pair` spends the
  limit for everyone including you. That is the right trade for a
  single-owner server: the alternative is trusting `X-Forwarded-For`, which
  makes the limits meaningless. Worth knowing if you ever put this behind a
  public tunnel rather than a tailnet.

### Rotating the key

There is no rotate command; there is a file.

```bash
rm ~/.aside-mobile/miniapp-secret.json    # or the bridge path, if you use it
# restart the server, then re-pair each device
```

The secret is also the JWT signing key, so deleting it invalidates every
session token at the same time. Every paired phone will ask to pair again,
and an APK built with a baked key needs rebuilding with `./build-android.sh`.
Do this if a pairing link ever leaves your control.
- Sessions are JWTs with a cookie fallback, so an evicted browser store does
  not force re-pairing.
- No Anthropic credentials live here. It talks to the Aside daemon already
  running on the Mac.

### Please check this yourself

You are about to give something access to your agent, your browser history
and your microphone, on a machine you care about. Reading it first is the
right instinct, and you are very welcome to. Nothing here is obfuscated,
minified or fetched from somewhere you cannot see.

A good half hour, roughly in order of value:

- **`miniapp/server/src/auth.ts`** and **`app.ts`** are where tokens are
  minted and every route is guarded. If something is wrong with the trust
  model, it is wrong here.
- **`miniapp/web/android/app/src/main/AndroidManifest.xml`** is the complete
  list of what the Android app can touch. It is short on purpose.
- **`build-android.sh`** is every command that runs during a build, in
  order, with nothing hidden behind a wrapper.
- **`package.json`** in `server/` and `web/`, then `npm audit`, for the
  dependency surface.

Useful things to run:

```bash
# Known CVEs in the dependency tree
cd miniapp/server && npm audit
cd ../web && npm audit

# Every outbound host the code talks to
grep -rInE "https?://[a-z0-9.-]+" miniapp/*/src --include=*.ts --include=*.tsx \
  | grep -v localhost | sort -u

# Confirm nothing is listening beyond loopback once it is running
lsof -nP -iTCP -sTCP:LISTEN | grep 8790
```

That last one is the claim most worth testing rather than taking on trust:
the server should bind `127.0.0.1` only, with Tailscale as the sole route in
from anywhere else.

**Found something?** Open an issue, or send a pull request. A security
report is a favour, and it will be treated as one. If you would rather not
discuss it in public first, say so in the issue without the details and we
will find another way.

**Do not trust a link, including this one.** If you did not clone this
yourself from a URL you typed, verify the remote before you run anything:

```bash
git remote -v          # expect github.com/Parthkkk/aside-mobile
git log --oneline -5   # read what you are about to run
```

Forking it and building from your own copy is a completely reasonable way to
use this, and it costs you nothing.

---

## When it breaks

**Blank screen on open.** The Mac is unreachable. Check Tailscale on both
devices, that the Mac is awake, and that
`curl -sI https://$ASIDE_TAILNET_HOST/app` returns 200.

**"Can't reach your Mac."** Server stopped or the Mac slept. `npm start`
again and turn on Amphetamine.

**Pairing rejected.** The key is derived from the signing secret, so the
page shows the same one every time and a mistyped or truncated paste is the
usual cause. Reload <http://127.0.0.1:8791/pair> and copy the whole link.
If it still fails, the server was restarted against a different secret file;
check the path the doctor prints.

**iPhone asks to pair every launch.** You are in a Safari tab. Install to
the home screen, then pair inside the installed app.

**Gradle killed.** Out of memory. Keep the flags, close other apps, do not
enable the Gradle daemon.

**APK will not install.** Allow unknown sources for whichever app opens the
link, and remove any older copy signed with a different key.

---

Built on [SaiAmartya/aside-telegram-bridge](https://github.com/SaiAmartya/aside-telegram-bridge).
MIT, copyright SaiAmartya and Parth Khavate. See [LICENSE](LICENSE).
