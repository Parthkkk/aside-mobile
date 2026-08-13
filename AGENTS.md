# Setting this up, as an agent

You have been handed this repo and asked to set it up on someone's Mac. This
file is the whole procedure. Work top to bottom. Every step has a check that
either passes or tells you what to do next.

Two rules that save time:

- **Stop and ask a human for exactly three things:** the admin password if
  Homebrew or Tailscale wants it, a Tailscale login on both the Mac and the
  phone, and the phone itself for the pairing scan. Nothing else needs them.
- **Do not skip a check because the command before it printed no error.**
  Most failures here are silent until the phone cannot connect.

## What this is

The Aside desktop agent, reachable from a phone. A Fastify server on the Mac
talks to the local Aside daemon; the phone runs the same web app either as an
installed web app (no build) or inside an Android shell (needs a build). The
two machines meet on a private Tailscale network, so nothing is exposed to
the internet.

Telegram is optional and off by default. Ignore every mention of it unless
the person asks.

## 0. Prerequisites

```bash
# macOS, Apple Silicon or Intel
sw_vers -productVersion
# Aside installed and signed in: https://aside.so
ls -d ~/.aside/u/0 && echo "aside present"
```

If Aside is missing, stop. Nothing here works without it; the server is a
front end for a daemon that has to be there.

## 1. Toolchain

```bash
which brew || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
export PATH="/opt/homebrew/bin:$PATH"
grep -q '/opt/homebrew/bin' ~/.zshrc || echo 'export PATH="/opt/homebrew/bin:$PATH"' >> ~/.zshrc
brew install node
```

**Check:** `node --version` prints v20 or newer.

## 2. Install and build

```bash
git clone https://github.com/Parthkkk/aside-mobile.git ~/aside-mobile
cd ~/aside-mobile/miniapp
npm run setup
```

`npm run setup` installs both workspaces, builds the server and the web app,
and then runs the doctor described below.

**Check:** the doctor's Toolchain, Build and Configuration sections are all
`ok`. Tailscale warnings at this point are expected; you have not done that
step yet.

If `npm install` dies inside `esbuild`'s postinstall with a SIGKILL, macOS
has quarantined the downloaded binary. Re-running `npm install` hits the
same wall, because it re-fetches and macOS re-quarantines. Install without
scripts first, clear the flag, then let the scripts run:

```bash
rm -rf node_modules
npm install --ignore-scripts
xattr -dr com.apple.quarantine node_modules
npm rebuild
```

## 3. Tailscale

This is the only way the phone reaches the Mac. It needs a human twice: once
to sign in on the Mac, once on the phone.

```bash
brew install --cask tailscale
open -a Tailscale
```

Ask the person to sign in on the Mac, then install Tailscale on the phone and
sign in with the same account.

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
$TS status
export ASIDE_TAILNET_HOST=$($TS status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
echo "export ASIDE_TAILNET_HOST=$ASIDE_TAILNET_HOST" >> ~/.zshrc
echo "$ASIDE_TAILNET_HOST"
```

**Check:** the hostname looks like `their-mac.tailXXXX.ts.net`, and the phone
appears in `$TS status`.

Turn on HTTPS certificates in the Tailscale admin console under DNS >
HTTPS Certificates. This is not optional: phone browsers reject self-signed
certificates, and Web Push requires real HTTPS.

Then put the server behind it:

```bash
$TS serve --bg 8790
$TS serve status
```

**Check:** `serve status` shows `https://<host> -> http://127.0.0.1:8790`.

**Never add a serve rule for port 8791.** That is the pairing page, and it is
loopback-only on purpose. Proxying it would hand a working pairing QR to
everyone on the tailnet.

## 4. Run it

```bash
cd ~/aside-mobile/miniapp/server
npm start
```

Leave it running, or install the launchd job so it survives a reboot:

```bash
cd ~/aside-mobile/miniapp
npm run launchd          # npm run launchd -- off  to remove
```

**Check:**

```bash
curl -s http://127.0.0.1:8790/api/health                 # {"ok":true}
curl -sI "https://$ASIDE_TAILNET_HOST/app" | head -1     # HTTP/2 200
```

If the second fails, Tailscale HTTPS is not on yet. Go back to step 3.

## 5. Verify the whole install

```bash
cd ~/aside-mobile/miniapp && npm run doctor
```

Exit code is the number of hard failures, so you can branch on it. Fix every
`FAIL` before continuing. `warn` lines are safe to leave: they cover
optional things like the Android toolchain.

One check matters more than the rest: the doctor asserts that
`http://127.0.0.1:8790/pair` returns **403**. If it returns 200, the pairing
page is being served on the proxied port and anyone on the tailnet can pair
themselves. Do not hand out the tailnet address until that reads 403.

## 6. Pair the phone

On the Mac:

```bash
open http://127.0.0.1:8791/pair
```

Port 8791, not 8790. Ask the person to scan the QR with their phone. That is
the only step that needs the device in hand.

- **Android:** the QR opens the app and pairs in one step. In Chrome, menu >
  Add to Home screen, then launch from the icon.
- **iPhone:** Safari only. Share > Add to Home Screen > Add, open it from the
  home screen, then paste the pairing link into the prompt. Pairing inside a
  Safari tab and then installing does not carry over; iOS gives the installed
  app separate storage.

**Check:** the app opens the session list and a message you send gets a reply.

## 7. Android APK, only if asked

The installed web app is the default and needs none of this. Build the native
shell only if the person specifically wants the Android app with the in-app
browser.

```bash
brew install --cask temurin@21
brew install --cask android-commandlinetools
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
export ANDROID_HOME=$HOME/Library/Android/sdk
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"

cd ~/aside-mobile
./build-android.sh
```

**Check:** the script prints the APK path and its size, roughly 99MB.

The APK it publishes to the tailnet carries a baked pairing key so a fresh
install self-pairs. That is fine on a personal tailnet and wrong on a shared
one. If the tailnet has other people on it, do not publish the APK there.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `cannot read miniapp config` | old build | rebuild; a missing config is normal now |
| `/pair` returns 200 on 8790 | running an old build | rebuild and restart the server |
| Phone says "can't reach your Mac" | Mac asleep, or server stopped | wake it, `npm start`, consider `npm run launchd` |
| iPhone asks to pair every launch | running in a Safari tab | install to the home screen first |
| `npm install` killed in esbuild | macOS quarantine | `xattr -dr com.apple.quarantine node_modules` |
| Gradle "failed to find target android-36" | SDK 35 installed | `sdkmanager "platforms;android-36" "build-tools;36.0.0"` |

## What you are allowed to change

Nothing, unless asked. This repo is someone's running system. If a step
fails, report the exact command and output rather than editing source to
route around it.
