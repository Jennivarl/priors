# Priors

**A forecasting coach that remembers how *you* are wrong.**

*Your priors are the beliefs you walk in with. Good forecasters update them with evidence. Priors keeps the evidence, so you actually do.*

Every other pick tracker asks *"which tipster can I trust?"*. Priors asks *"can I trust myself?"*
You log a pick before the event with your confidence and your reason. Priors seals it with the live
Sui checkpoint (so nobody can claim a pick after the fact), stores it in **Walrus Memory on Mainnet**,
and learns your blind spots from every result. Before your next pick it pushes back:

> Your gut says **80%**. You overrate Arsenal by 41 pts (5 past picks). On Football you run hot. Walrus found 5 past picks where you argued the same way, and 2 won.
> Coach, from your record: **24%**. Market: **51%**. *Corrected for your bias, the market is more right than you. Pass or size down.*

**Live app:** https://usepriors.vercel.app. Connect a Sui wallet to keep your own record in your own Walrus Memory, or browse the demo record without signing in.

Track: **Markets & Sports Prediction** (Total Recall, Tatum x Walrus).

## Use it on the live site

1. Install a Sui wallet such as [Slush](https://slush.app) and hold a little SUI for gas (0.01 SUI covers setup).
2. Open https://usepriors.vercel.app and click **Connect wallet**.
3. Approve in your wallet: Priors finds your Walrus Memory account or creates it (one transaction), then adds a delegate key for Priors to it (one transaction). The key can read and write your memories only; it cannot move funds, and you can revoke it at any time on memory.walrus.xyz.
4. Log a pick. It is sealed on Sui and written to **your** Walrus Memory. Crypto calls settle themselves while the page is open; Polymarket picks settle when their market resolves.
5. Open the site on another device, connect the same wallet, and click **Rebuild from Walrus** to get your record back.

Already have a Walrus Memory delegate key (for example from signing in with Google on memory.walrus.xyz)? Choose **I already have a Walrus Memory delegate key** in the connect dialog instead.

---

## What it does

1. **Log a pick, with your reason.** Sports or politics (live **Polymarket** prediction-market prices, no key needed) or crypto (a price call on SUI or WAL).
2. **Sealed on Sui.** The pick is stamped with the latest Sui Mainnet checkpoint (height, digest, time), read through Tatum, and a sha256 commitment of its content is written to Walrus. Exactly what that proves is explained under Architecture.
3. **Remembered on Walrus.** The pick, your reason, the result and every lesson the coach learns are written to Walrus Memory (Mainnet).
4. **Settled without trusting you.** Crypto calls settle themselves at the deadline from **onchain pool state** (Cetus SUI/USDC and WAL/SUI pools on Sui, read through Tatum). Sports and politics picks settle themselves when their **Polymarket market resolves** (resolved onchain through the UMA oracle). The server re-quotes the price itself, so the user cannot type a fake price. Manual picks (no market) still exist, and are labelled *self-reported* everywhere.
5. **Learns your bias fingerprint**, from results:
   - overall calibration (on the demo record: you say 71%, 50% happens)
   - per team ("you overrate Arsenal")
   - per category ("you are sharp on tennis, overconfident on NBA")
   - **tilt** ("right after a loss you hit 29% vs 57% and take longer odds")
   - you vs the market ("when you fight the market by 10+ points, the market wins")
6. **Learns from how you think.** Walrus **semantic recall** finds past picks whose *reason means the same thing* as your new one ("great form, they're due" matches "Arsenal are flying, they owe us one") and shows how that line of thinking worked out. Walrus **Analyze** extracts facts from your reasoning text.
7. **Second opinion before you commit.** Your gut, minus what your history says you get wrong, next to the market price.
8. **Portable.** Wipe the app's local data and rebuild everything from Walrus alone. The same memory can be read by any agent (for example Claude Code through the Walrus Memory MCP server).
9. **Yours, per wallet.** Anyone can sign in with a Sui wallet. Each person's picks go into their own Walrus Memory account, through a delegate key their wallet approves. Priors never sees the wallet's own key.

## How it maps to the judging criteria

| Criterion (weight) | Where to see it |
|---|---|
| Walrus + Tatum integration (30%) | Walrus Memory is the core, not storage: semantic recall of your *reasoning* drives the coach ([server.js](server.js) `echoFor`, [lib/coach.js](lib/coach.js) `reasoningEcho`), Analyze extracts facts, lessons are memories, "rebuild from Walrus" restores the whole app ([lib/memory.js](lib/memory.js)). Tatum Sui gRPC stamps every pick and reads onchain pool state to settle crypto picks ([lib/sui.js](lib/sui.js), [lib/oracle.js](lib/oracle.js)). |
| Technical quality (30%) | Pure, tested coach logic shared by server and browser ([lib/coach.js](lib/coach.js)); result sources behind one interface ([lib/settle.js](lib/settle.js)); wallet sign-in on the Walrus Memory account contract with signed pick receipts ([lib/walrus-account.js](lib/walrus-account.js), [lib/receipt.js](lib/receipt.js)); Tatum rate limits handled (3 rps, retry on 429); idempotent Walrus writes with visible status; 26 unit tests ([test/](test/)). |
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

**Wallet sign-in.** The Walrus Memory contract (package `0xe7c16f…d7f5`) keeps an `AccountRegistry` whose table maps each wallet address to its one account. Priors derives the table entry from the address and reads it through Tatum, so a returning user is found directly. A new user's wallet signs `account::create_account`, then `account::add_delegate_key` for an Ed25519 key generated in the browser. The browser keeps that delegate key and sends it per request over HTTPS; the server checks it is authorised on the account onchain, uses it for that request, and never stores it. A wallet user's record lives in their browser and their own Walrus Memory; the coach runs in the browser from the same [lib/coach.js](lib/coach.js). Because the browser holds the record, the server signs every pick it seals (an HMAC over the pick's commitment), and settlement only accepts picks with a valid receipt, so a pick edited in the browser cannot be settled.

Memory layout on Walrus: the demo record uses namespace `gut-check` (plus `gut-check-reasons`); wallet users write to `priors` (plus `priors-reasons`) in their own account. Each memory is a human sentence followed by a tagged JSON payload, so it reads well in any agent *and* the app can rebuild its exact state from it.

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
- **Wallet users settle while the page is open.** Their record lives in their browser, so crypto calls and market picks settle the next time they open Priors, not in the background. The local app (`npm start`) settles its own record in the background.
- **The delegate key lives in the browser's storage.** It can only read and write that user's memories, and the user can revoke it on memory.walrus.xyz at any time.
- **Demo history.** `npm run seed` loads a demo forecaster (events marked "(demo)", illustrative results) through the real API, so every demo pick is still really sealed on Sui and written to Walrus.
- **Recall is capped at 100 results per query**, so "rebuild from Walrus" sweeps several queries; fine for hundreds of picks, not tens of thousands.

---

## How to Test

### Quickest way: run it locally with your own wallet (about 5 minutes)
You only need Node.js, a free Tatum key, and a Sui wallet (for example Slush). Your wallet creates your own Walrus Memory account, so no Walrus key is needed on the server.
```bash
git clone https://github.com/Jennivarl/priors.git
cd priors
npm install
```
Create a file called `.env` in the project folder with one line:
```
TATUM_API_KEY=your-tatum-key
```
Then start it:
```bash
npm start
```
Open http://localhost:3000, click **Connect wallet**, choose your wallet and approve twice (create your Walrus Memory, then the key for Priors). Mainnet needs about 0.01 SUI for gas; to try it for free, use testnet instead (step 11 below).
Expected: the connect dialog's four steps turn into ticks, the page shows **Your record**, and a pick you seal shows a green **Sealed** box, then `blob …` lines in the Memory timeline once Walrus has stored it.

The full walkthrough below also covers the operator's own record, the demo history and every feature. It needs a Walrus Memory key as well.

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
Expected: `pass 26`, `fail 0` (coach logic, onchain price math, settlement rules for all three sources, input checks, commitments, pick receipts, Walrus account parsing, rebuilding a record from memories, reasoning echo).

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
- **Bias fingerprint** shows lessons such as *You overrate Arsenal*, *You chase after a loss*, *You undersell yourself on Tennis*.
- **Memory timeline** fills up as writes land (pending → `blob ...`). About 50 writes take a few minutes.
- About a minute later the two **SUI calls settle by themselves** and show `verified onchain` with the settlement price and checkpoint.

### 7. See the coach push back
In **Log a pick**: Sports → Category `Football` → leave **Market** on `Not listed, type it yourself` (the default) → Event `Arsenal vs Spurs`, Your pick `Arsenal`, Odds `1.95`, Gut confidence `80`, Why you like it `Arsenal are on great form and they are due a win`.
Expected: your gut figure gets a red strike through it and the coach figure drops well below 80%, with reasons such as *You overrate Arsenal…* and a line **Walrus found N past picks where you argued the same way**, quoting your past reasons. Recall can take a few seconds; the box shows "Checking your record on Walrus" meanwhile.

### 8. Make a verified crypto call
Switch to **Crypto** → Asset `SUI` → Call `Above` → Target (pre-filled just above the live onchain price) → Minutes `2` → Odds `2` → a reason → **Seal on Sui and remember**.
Expected: a receipt with the Sui checkpoint link. After the deadline the pick settles itself from the Cetus pool price, marked `verified onchain`.

### 9. Prove the memory is portable
In the **Memory timeline** panel, click **Rebuild from Walrus** (it wipes the local data first).
Expected: "Rebuilt from N memories on Walrus", and the picks, results and fingerprint come back from Walrus alone. You can also delete `data/state.json` while the server is stopped, start it, and click the button.

### 10. Ask your past self
In **Ask your past self**, type `why do I lose after a bad week` and click **Recall**, or click one of the example questions under the search box (the first one runs once by itself when the page opens).
Expected: memories about chasing losses, ranked by meaning, each with its Walrus blob id.

### 11. Try wallet sign-in for free on Sui testnet
Wallet sign-in on Mainnet costs a little SUI for gas. To try the same flow with free test SUI, start the app on testnet (it uses Walrus Memory's testnet relayer and contract):
```bash
SUI_NETWORK=testnet PORT=3001 npm start
```
1. In a Sui wallet (for example Slush), switch to **Testnet** and get free SUI at https://faucet.sui.io.
2. Open http://localhost:3001 and click **Connect wallet**.
3. Approve twice in the wallet: creating your Walrus Memory account, then the key for Priors.

Expected: the four steps in the dialog turn into ticks, the page shows **Your record**, and a pick you seal shows `blob …` in the Memory timeline once Walrus has stored it. Prices and crypto calls read Mainnet pools, so on testnet log a sports pick by hand.

## Deploying your own (Vercel)
Set `TATUM_API_KEY`, `MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID` and `OWNER_TOKEN` as Production environment variables, run `npm run snapshot` to publish your current history to `demo/state.json`, then `vercel deploy --prod` (Vercel runs `npm run build`, which bundles the wallet sign-in). With `OWNER_TOKEN` set the demo record is read-only for visitors, who can connect their own wallet instead; enter the passcode in the box at the bottom of the page to log picks on the demo record. The demo record's background settlement needs a long-running server (`npm start`), since serverless hosts have no background loop. Pick receipts are signed with `RECEIPT_SECRET` if set, otherwise with a key derived from `OWNER_TOKEN`; set `RECEIPT_SECRET` if you plan to rotate the passcode, so open picks stay settleable.

## Project layout
```
server.js               HTTP API: demo record, wallet users (/api/u), write pool, settlement loop
api/index.js            Vercel entry (the same Express app)
lib/coach.js            bias fingerprint, calibration, second opinion, reasoning echo (pure, runs in the browser too)
lib/picks.js            sealing a pick: draft checks, market quote, Sui stamp, commitment, memory sentences
lib/memory.js           Walrus Memory per account: remember, recall, analyze, jobs, count, restore
lib/walrus-account.js   Walrus Memory accounts onchain: wallet lookup, delegate keys, transaction results
lib/receipt.js          server receipts for picks held in the browser
lib/settle.js           result sources: onchain price, market resolution (verified), self-reported (unverified)
lib/markets.js          Polymarket prices and resolutions (public API)
lib/oracle.js           onchain SUI / WAL price from Cetus pool objects
lib/sui.js              Tatum Sui gRPC client, checkpoint stamp, rate limiting
lib/store.js            the demo record on disk, rebuilding a record from memories
client/wallet.js        wallet sign-in bundle (built to public/vendor/ by npm run build)
public/                 the web app
scripts/                connection check, demo seed, real onchain test calls, demo snapshot
test/                   unit tests
```

## License
MIT
