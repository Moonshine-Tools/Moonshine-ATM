# 🌙 Moonshine Asset Manager

**An all-in-one stock market tool for Torn City, built for Torn PDA.**

In Torn, cash on hand gets mugged, so most players keep their money in the stock market. Moonshine makes that fast and smart. Get cash out in a couple of taps, put it back just as quickly, and let the script look for small, tested trades that can grow your money faster than the market.

It fills in the numbers. **You always press Torn's own Buy, Sell or give button.**

---

## Screenshots

<p align="center">
  <img src="screenshots/growth-chart.jpg" alt="Growth chart: your stocks (gold line) against the market (blue dashed line) from Oct 2 to Oct 12. The gold line climbs from about -0.45% to +0.22% after Moonshine's trade suggestions start, while the market drifts down to -0.21%." width="360">
</p>

**Growth chart, Oct 2 – Oct 12, 2026.** The arrow marks when I started following Moonshine's trade suggestions. Before that, my stocks trailed the market. After 45 rotation trades, they're up **+0.22%** while the market is down **-0.21%**, a lead of **+0.43%**.

*Early days: this is about 10 days of data, and past results don't guarantee future ones.*

---

## Features

### 💵 Quick withdraw
Type how much cash you need, like `5m`, `750k` or `1.2b`. The script picks which stock to sell, opens its panel and fills in the exact number of shares, including the 0.1% selling fee and a small safety margin for price changes.

- **It sells stocks that are in profit first.** The script knows what you paid for your shares, and picks a stock worth more than you paid even after the 0.1% fee, so using the market as a bank doesn't cost you money. If every stock is below what you paid, it picks the smallest loss and tells you how much.
- Among those, it sells the stock with the weakest outlook.
- It never sells shares that are holding a benefit block. If it can't avoid that, it warns you and offers other stocks.
- If no single stock has enough spare shares, it splits the withdrawal into separate sales and walks you through each one.

### 🏦 Quick deposit
One tap reads the cash you're carrying and buys as many whole shares as it covers of the stock with the best outlook. Extra weight goes to purchases that complete a benefit block.

- **Only good buys.** If no stock is expected to rise, it says *No good buys right now* and suggests the faction vault instead of buying into a falling stock.
- **Leftover cash.** After a purchase, if there's enough left for more shares of a good buy, it offers to buy them. Otherwise it offers the faction vault, or the church for small amounts.
- **Faction vault.** Deposit to your faction's vault in one tap. The script opens Faction → Armory (the revolver tab) and fills in the money box; you tap **Deposit Money**. Only shown if you're in a faction, and not while you're in hospital, jail or traveling.
- **Church.** Cash too small for a share can be donated to the church. The script opens the Donate tab and fills in the amount. A last resort: only suggested when the cash can't buy even one share of any stock, and only up to $500, because a donation gives the money away. A cheap share keeps it.

### 📈 Trade ideas
The script looks for chances to **sell a little of one stock and buy another** for a small expected gain. Each idea shows:

- How much to sell and what to buy
- The estimated gain after the fee
- How strong the evidence is
- A plain-English reason, such as *"ABC is 2.1 standard deviations below its 7-day normal price; when it was here before, it rose 68% of the time"*

You confirm the sale, then confirm the purchase. Nothing happens without your two taps.

### 📊 Growth tracking
A chart shows how your stocks have grown compared with the whole market, over 1 day, 7 days, 30 days or all time. It ignores cash you add or take out, so a withdrawal never looks like a loss. If your line stays above the market's over weeks, your trades are working.

### 🌙 Out of the way
Everything sits behind one small moon icon. Drag it to any edge of the screen. Tap it to open **Market**, **Withdraw** and **Deposit**.

- 🟠 An orange dot means you're carrying cash.
- 🟢 A green dot means there's a trade idea.

The panels follow Torn's light or dark mode, and they collapse into a thin bar at the top so they never cover Torn's buttons.

---

## How it works

### 1. Collecting prices
- **From Torn:** While any Torn page is open, the script reads stock prices from the official Torn API about once a minute and saves them on your phone.
- **History:** On first run it downloads up to 2 years of hourly prices from [tornsy.com](https://tornsy.com/api), a free public Torn stock-history site. This takes about 5–10 minutes with Torn open, and picks up where it left off if interrupted.
- **Storage:** Raw minute prices are kept for 90 days. Hourly prices are kept indefinitely. Nothing is sent to any server of ours; there isn't one.

### 2. Learning each stock's personality
For every stock, the script tracks its **normal price** (a 7-day moving average) and how far it usually strays from it. Every price is turned into a score: how many of its own standard deviations it is above or below normal. A 3% move is huge for a calm stock and ordinary for a jumpy one, and the score accounts for that.

It then looks back through history: *when this stock was this far from normal, what happened over the next 6 hours, 1 day and 7 days?* The cut-offs for "far from normal" come from the data, not fixed rules. Stocks with little history of their own lean on market-wide patterns until they have enough examples.

### 3. Testing itself
Before it recommends anything, the model has to prove itself on data it hasn't seen:

1. It learns from the first 70% of the price history.
2. It's tested on the last 30%, against buy-and-hold, a momentum strategy and a simple "buy the dip" strategy, with fees charged on every sale.
3. To pass, it must:
   - rank stocks better than chance,
   - beat buy-and-hold after fees,
   - and keep beating it in at least 5 of 9 different settings, so one lucky setting can't fake a pass.

If it doesn't pass, the Market panel shows **No action** and explains why. On purely random prices, the model correctly fails.

### 4. Finding a trade
Every few minutes it compares every pair of stocks: *is the expected return of B, minus the expected return of A, minus the 0.1% fee, big enough and certain enough to be worth moving money?* The size of the trade grows with the strength of the evidence, and one stock can't take more than 20% of your portfolio. If nothing clears the bar, it shows the closest idea and how far it is from qualifying.

### 5. Learning from results
Every recommendation is logged. Once its time horizon has passed, the script checks what actually happened and shows the track record in **Market → Details**: predicted versus actual gain, and how often it was right.

---

## Installation

### Torn PDA (Android / iOS)
1. In Torn PDA, open the menu → **Settings → Advanced Browser Settings → Manage scripts** and make sure custom user scripts are on.
2. Tap **+**, choose the **Remote** tab and paste this link:
   ```
   https://raw.githubusercontent.com/Moonshine-Tools/Moonshine-Asset-Manager/main/moonshine-asset-manager.user.js
   ```
   Remote install also gets you update notices from Torn PDA.
   - Or paste the code in directly. If your phone can't copy it all at once, use the four files in `parts/`, pasting them one after another in order.
3. Set injection time to **End** if asked, then save.
4. Open any Torn page. The 🌙 appears on the right edge.

Your API key is filled in automatically by Torn PDA.

### PC (Tampermonkey / Violentmonkey)
Open [this link](https://raw.githubusercontent.com/Moonshine-Tools/Moonshine-Asset-Manager/main/moonshine-asset-manager.user.js) and Tampermonkey will offer to install it. Then open **Market → Settings** and paste a **Limited Access** API key.

### Updates
The script checks GitHub for a newer version every 6 hours. When one is out, the Market panel shows **Update available**, and the menu shows *(update)* next to Market. You can also check any time in **Market → Settings → Check for updates**. Your settings and price history are kept when you update.

**Installing the update in Torn PDA:**
1. Menu → **Settings → Advanced Browser Settings → Manage scripts**.
2. Tap the check-for-updates button at the top. A green bar appears: *"1 script update available"*.
3. Tap **REVIEW**, tick **Moonshine Asset Manager** and apply. Reload Torn.

This only works if the script was added with **+ → Remote** and the link above. A pasted-in script can't update itself; delete it and add it again from the link.

**Tampermonkey** updates the script automatically, or tap **Update now** to install it straight away.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| Keep cash on hand | $0 | Cash that Deposit leaves in your pocket |
| Parking stock | none | Where deposits go while the model is still learning |
| Offer faction vault | on | Show the faction vault option when you're in a faction |
| Church limit | $500 | Largest amount the script will suggest donating to the church, and only when it can't buy a single share |
| Never trade these | none | Stocks the script will never buy or sell |
| Price safety margin | 0.25% | Extra room so a price tick doesn't leave you short |
| Minimum gain after fees | 0.25% | Smallest expected gain worth suggesting |
| Evidence required | 1.2× | How much bigger the gain must be than its uncertainty |
| Most in one stock | 20% | Cap on any single stock's share of your portfolio, so money is spread over at least five stocks to rotate between |
| Smallest trade | $250k | Trades smaller than this aren't suggested |
| Days of history | 730 | How far back to download prices |

---

## Rules and privacy

- **Follows Torn's scripting rules.** The script never presses Buy, Sell, Confirm, Yes or give, and never sends a trade request. It only opens panels and types numbers into boxes, the same as you would.
- **Read-only API.** It only reads from the official Torn API, at about two calls a minute.
- **Stays on your phone.** Your key and data are stored on your device. The only outside site contacted is tornsy.com, for public price history, and no key or personal data is sent there.
- **Checks before you confirm.** When Torn asks "Are you sure you want to sell N shares", the script checks N against its own number and warns you if they differ.

---

## Limitations

- **Only runs with Torn open.** Torn PDA can't run scripts in the background. Gaps are filled from tornsy.com history.
- **Benefits are protected, not valued.** The script never sells shares a benefit needs, but it doesn't put a dollar value on benefits.
- **No guarantees.** Past patterns may not repeat. If the market has no reliable edge, the honest answer is **No action**, and the script will give it.
- **Torn's pages can change.** If a box can't be found, the script tells you the number to type and offers a Copy button.

---

## Publishing an update

1. Change the `@version` line at the top of `moonshine-asset-manager.user.js`, for example `2.3.0` → `2.3.1`.
2. Change `SCRIPT_VERSION` near the top of the code to the same number.
3. Upload the new file to the `main` branch of this repository.

Everyone running the script will see the update within 6 hours. If the version number isn't raised, nobody is told about the update.

---

## Roadmap

- [ ] Put a value on stock benefits in trade decisions

---

*Built for fun. It's a game: trade wisely, and keep an eye on the numbers before you tap confirm.*
