# Priors

**A forecasting coach that remembers how *you* are wrong.**

*Your priors are the beliefs you walk in with. Good forecasters update them with evidence. Priors keeps the evidence, so you actually do.*

Every other pick tracker asks *"which tipster can I trust?"*. Priors asks *"can I trust myself?"*
You log a pick before the event with your confidence and your reason. Priors seals it with the live
Sui checkpoint (so nobody can claim a pick after the fact), stores it in **Walrus Memory on Mainnet**,
and learns your blind spots from every result. Before your next pick it pushes back:

> Your gut says **80%**. You overrate Arsenal by 41 pts (5 past picks). On Football you run hot. Tilt alarm: your last pick lost.
> Coach, from memory: **30%**. Market: **51%**. *Corrected for your bias, the market is more right than you. Pass or size down.*

**Live demo:** https://usepriors.vercel.app (read-only: try the coach and "Ask your past self"; run it locally to log your own picks)

Track: **Markets & Sports Prediction** (Total Recall, Tatum x Walrus).

---

## What it does

1. **Log a pick, with your reason.** Sports or politics (live **Polymarket** prediction-market prices, no key needed) or crypto (a price call on SUI or WAL).
2. **Sealed on Sui.** The pick is stamped with the latest Sui Mainnet checkpoint (height, digest, time), read through Tatum, and a sha256 commitment of its content is written to Walrus. Exactly what that proves is explained under Architecture.
3. **Remembered on Walrus.** The pick, your reason, the result and every lesson the coach learns are written to Walrus Memory (Mainnet).
4. **Settled without trusting you.** Crypto calls settle themselves at the deadline from **onchain pool state** (Cetus SUI/USDC and WAL/SUI pools on Sui, read through Tatum). Sports and politics picks settle themselves when their **Polymarket market resolves** (resolved onchain through the UMA oracle). The server re-quotes the price itself, so the user cannot type a fake price. Manual picks (no market) still exist, and are labelled *self-reported* everywhere.
5. **Learns your bias fingerprint**, from results:
   - overall calibration (you say 73%, you hit 43%)
   - per team ("you overrate Arsenal")
   - per category ("you are sharp on tennis, overconfident on NBA")
   - **tilt** ("right after a loss you hit 29% vs 57% and take longer odds")
   - you vs the market ("when you fight the market by 10+ points, the market wins")
6. **Learns from how you think.** Walrus **semantic recall** finds past picks whose *reason means the same thing* as your new one ("great form, they're due" matches "Arsenal are flying, they owe us one") and shows how that line of thinking worked out. Walrus **Analyze** extracts facts from your reasoning text.
7. **Second opinion before you commit.** Your gut, minus what your history says you get wrong, next to the market price.
8. **Portable.** Wipe the app's local data and rebuild everything from Walrus alone. The same memory can be read by any agent (for example Claude Code through the Walrus Memory MCP server).

## How it maps to the judging criteria

| Criterion (weight) | Where to see it |
|---|---|
| Walrus + Tatum integration (30%) | Walrus Memory is the core, not storage: semantic recall of your *reasoning* drives the coach ([server.js](server.js) `echoFor`, [lib/coach.js](lib/coach.js) `reasoningEcho`), Analyze extracts facts, lessons are memories, "rebuild from Walrus" restores the whole app ([lib/memory.js](lib/memory.js)). Tatum Sui gRPC stamps every pick and reads onchain pool state to settle crypto picks ([lib/sui.js](lib/sui.js), [lib/oracle.js](lib/oracle.js)). |
| Technical quality (30%) | Pure, tested coach logic ([test/coach.test.js](test/coach.test.js)); result sources behind one interface ([lib/settle.js](lib/settle.js)); Tatum rate limits handled (3 rps, retry on 429); Walrus write pool with retries and visible status; clear error messages. |
| Creativity (20%) | Turns the credibility idea inward: the app scores *you*, including your reasoning patterns and tilt. |
| Presentation (20%) | This README, the live app, and the demo video. |

## Architecture

```
Browser (public/)            Node server (server.js)                   Networks
-----------------            -----------------------                   --------
Log pick + reason   ──►  parseDraft → market quote (lib/markets.js) ──►  Polymarket (prices + resolutions)
                         getStamp (lib/sui.js) ──────────────────────►  Tatum gRPC → Sui Mainnet checkpoint
                         echoFor: recall similar reasons ───────────►  Walrus Memory relayer (Mainnet)
Second opinion      ◄──  secondOpinion (lib/coach.js, pure)
                         writeMemory pool: pick, reason, result, lesson ► Walrus Memory (Mainnet)
                         autoSettle every 15s (lib/settle.js) ───────►  Tatum gRPC → Cetus pool objects
Fingerprint, chart  ◄──  fingerprint / calibration (lib/coach.js)
"Rebuild from Walrus" ─► restoreAll (lib/memory.js) ─────────────────►  Walrus Memory recall + restore
```

**Reasoning echo calibration (real Walrus recall distances, lower = closer in meaning).**
Query *"I need to win back my losses tonight"*: "Need to win back what I lost on Arsenal" 0.531, "Down this week so I need a big win" 0.546, "I have to make up for the last loss" 0.551, while a stats-based tennis reason scored 0.654 and "great form" reasons 0.71+.
Query *"Head to head record and serve statistics favour him"*: the three stats-based tennis reasons 0.49–0.52; everything else 0.65+.
Same line of thinking lands at 0.41–0.55 and unrelated reasoning at 0.65+, so the echo counts matches below **0.6** (`ECHO_MAX_DISTANCE`).

**What the seal proves.** Each pick stores the latest Sui checkpoint height and **digest**, plus a sha256 **commitment** over the pick's content and that digest. A digest cannot be known before its checkpoint exists, so the pick was made *after* that checkpoint. The Walrus memory carrying the commitment shows it existed *by* the time of the write. Editing any field later changes the commitment. (It does not anchor the pick in its own Sui transaction; that would need a funded wallet per user, see trade-offs.)

Memory layout on Walrus (namespace `gut-check`, plus `gut-check-reasons` for reasoning only):
each memory is a human sentence followed by a tagged JSON payload, so it reads well in any agent
*and* the app can rebuild its exact state from it.

## Who it is for, and the business

- **First user:** sports and fantasy players who already log picks (spreadsheets, Discord, notes apps) and want to know *why* they lose.
- **Problem:** people remember their wins and forget their losses. Priors keeps an honest, timestamped record and turns it into specific, personal corrections.
- **Money:** free for personal use; a paid coach tier (more categories, live odds alerts, weekly bias report); a B2B **safer-gambling** module for operators and tipster platforms: the tilt alarm and "you chase after a loss" signal is the kind of tool operators are increasingly expected to offer.
- **Ecosystem:** every user is a Walrus Memory account writing to Mainnet, and their bias profile is portable: any agent, app or wallet can read it with the user's permission. Every pick and settlement also reads Sui through Tatum.

## What we traded (honest limits)

- **Three result sources, one interface** ([lib/settle.js](lib/settle.js)): onchain price (crypto, verified), Polymarket resolution (sports/politics, verified), self-reported (manual picks, labelled unverified). A Sui-native prediction market can be added as a fourth source without touching anything else.
- **Polymarket lives on Polygon, not Sui.** It is the deepest public market for sports prices today; Sui prediction markets can replace it through the same interface.
- **Crypto "market" price is your own odds**, since no market exists for a one-off 3-minute price call. It is labelled as typed odds.
- **No per-pick Sui transaction.** Picks are time-bounded by a checkpoint digest and a Walrus write, not anchored in their own transaction (that needs a funded wallet and gas per user).
- **Single user per server.** Each server holds one Walrus delegate key. Multi-user means one delegate key per user (Walrus supports this) and per-user state.
- **Demo history.** `npm run seed` loads a demo forecaster (events marked "(demo)", illustrative results) through the real API, so every demo pick is still really sealed on Sui and written to Walrus.
- **Recall is capped at 100 results per query**, so "rebuild from Walrus" sweeps several queries; fine for hundreds of picks, not tens of thousands.

---

## How to Test

### What you need
- **Node.js 22.23.4+ (22.x), 24.22.1+ (24.x) or 26.12.1+ (26.x).** Check with `node -v`.
- **A Tatum API key** (free): sign up at https://dashboard.tatum.io and copy the Mainnet key.
- **A Walrus Memory account** (free): sign in at https://memory.walrus.xyz/dashboard, choose **Connect an app**, create a **delegate key** (save the private key, it is shown once), and copy the **accountId** from the quickstart snippet (step 03). It is *not* your wallet address.

### 1. Install
```bash
git clone https://github.com/Jennivarl/priors.git
cd priors
npm install
```

### 2. Add your keys
Create a file called `.env` in the project folder:
```
TATUM_API_KEY=your-tatum-key
MEMWAL_PRIVATE_KEY=your-delegate-private-key
MEMWAL_ACCOUNT_ID=0x-your-walrus-memory-account-id
MEMWAL_AGENT_ID=your-delegate-public-key
```
`.env` is git-ignored. Never commit it.

### 3. Check both networks work
```bash
npm run check
```
Expected (numbers will differ):
```
Tatum Sui OK: checkpoint #343744272 at 2026-11-10T14:31:23.620Z
Walrus Memory write OK: blob HBwuzwMM...
Memories stored in namespace "gut-check": 1
```
A Walrus write takes about 20 to 30 seconds. A `401 AUTH_REJECTED` means the account ID or key is wrong (most often the wallet address was used as the account ID).

### 4. Run the unit tests
```bash
npm test
```
Expected: `pass 18`, `fail 0` (coach logic, onchain price math, settlement rules for all three sources, input checks, commitments, reasoning echo).

### 5. Start the app
```bash
npm start
```
Open http://localhost:3000. Expected: the Priors page, with an empty fingerprint.

### 6. Load the demo history (second terminal)
```bash
npm run seed
```
Expected: 14 lines like `lost Arsenal 85% @ 1.8 sealed at Sui checkpoint #343744756`, then two open SUI calls. Refresh the page:
- **Your bias fingerprint** shows lessons such as *You overrate Arsenal*, *You chase after a loss*, *You undersell yourself on Tennis*.
- **Memory timeline** fills up as writes land (pending → `blob ...`). About 50 writes take a few minutes.
- About a minute later the two **SUI calls settle by themselves** and show `verified onchain` with the settlement price and checkpoint.

### 7. See the coach push back
In **Log a pick**: Sports → Football → pick `Arsenal`, odds `1.95`, confidence `80`, reason `Arsenal are on great form and they are due a win`.
Expected: the coach number drops well below 80%, with reasons such as *You overrate Arsenal…* and **Walrus recall: you argued like this N times before and won M**, quoting your past reasons.

### 8. Make a verified crypto call
Crypto → SUI → above → target (pre-filled just above the live onchain price) → deadline `2` minutes → odds `2` → a reason → **Seal on Sui & remember**.
Expected: a receipt with the Sui checkpoint link. After the deadline the pick settles itself from the Cetus pool price, marked `verified onchain`.

### 9. Prove the memory is portable
Click **Wipe local data & rebuild from Walrus**.
Expected: "Rebuilt from N memories on Walrus", and the picks, results and fingerprint come back from Walrus alone. You can also delete `data/state.json` while the server is stopped, start it, and click the button.

### 10. Ask your past self
In **Ask your past self**, type `why do I lose after a bad week?`.
Expected: memories about chasing losses, ranked by meaning, each with its Walrus blob id.

## Deploying your own (Vercel)
Set `TATUM_API_KEY`, `MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID` and `OWNER_TOKEN` as Production environment variables, run `npm run snapshot` to publish your current history to `demo/state.json`, then `vercel deploy --prod`. With `OWNER_TOKEN` set the site is read-only for visitors; enter the passcode in the box at the bottom of the page to log picks. Crypto auto-settlement needs a long-running server (`npm start`), since serverless hosts have no background loop.

## Project layout
```
server.js          HTTP API, write pool, auto-settlement loop
lib/coach.js       bias fingerprint, calibration, second opinion, reasoning echo (pure, tested)
lib/memory.js      Walrus Memory: remember, recall, analyze, count, restore
lib/sui.js         Tatum Sui gRPC client, checkpoint stamp, rate limiting
lib/oracle.js      onchain SUI / WAL price from Cetus pool objects
lib/settle.js      result sources: onchain price, market resolution (verified), self-reported (unverified)
lib/markets.js     Polymarket prices and resolutions (public API)
public/            the web app
scripts/           connection check and demo seed
test/              unit tests
```

## License
MIT
