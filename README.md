# Money Road Map

<img src="icon-512.png" alt="Money Road Map icon" width="96" align="right">

A budget tracker built for people with **two incomes** — a fixed biweekly paycheck plus gig work (Uber) — who need to hit a hard savings goal without living in financial stress.

Instead of just recording what you spent, it answers the question that actually matters every week: **"How much do I need to earn on Uber this week so that my bills, my savings goal, and my upcoming events are all covered?"**

Built with **vanilla HTML/CSS/JavaScript — zero frameworks, zero dependencies, no build step.** Installable on a phone as a PWA and fully functional offline.

## What it does

- **Weekly Uber target** — one concrete number per week ("drive for $780 ≈ 26 hours"), solved so that bills, living costs, weekly savings, and event funds are always covered
- **Daily log** — enter what you earned and spent each day; it tells you how much is left for the week and what tomorrow needs to look like ("$204/day over the remaining 5 days")
- **Automatic bill calendar** — rent on the 1st, insurance on the 10th, car payment on payday Fridays… the app knows what's coming and warns you the night before
- **Event sinking funds** — a vacation or a birthday gets pre-funded over the weeks before it, so when the day comes the money is already there
- **Sunday check-in** — a weekly confirm (pre-filled from your daily logs) that updates your balances and re-solves the entire plan from what actually happened
- **Reimbursable work expenses** — out-of-pocket work costs tracked separately as "boss owes you," never counted against your budget
- **Roadmap view** — a week-by-week projection to the goal date, recalculated after every check-in

## The interesting part: the planning engine

The core of the app is a small constraint solver ([app.js](app.js)):

1. The year is split into **segments** at each event deadline (vacation → gifts → finish line).
2. For each segment, the app **binary-searches the smallest flat weekly gig-income target** such that a week-by-week simulation of the whole segment — salary weeks, every bill on its real calendar day, living costs, savings transfers, event contributions, event payouts — never lets the bank balance fall below a safety floor.
3. Because early segments carry the near-term events, targets naturally **step down over time** ("push now, coast later"), and every check-in re-solves the remaining plan from real balances, so the plan self-corrects instead of guilt-tripping.

Other engineering details:

- **Idempotent check-ins** — each weekly check-in snapshots balances before applying, so re-saving a week rolls back and reapplies instead of double-counting
- **Offline-first PWA** — network-first service worker with cache fallback, versioned assets, installable with a generated icon (the icon itself is rendered by a dependency-free Node script that rasterizes and encodes the PNG by hand)
- **All data stays on-device** in `localStorage`, with JSON export/import for moving between devices

## Run it

Any static file server works:

```bash
python -m http.server 8000
# open http://localhost:8000
```

Or just open `index.html` in a browser. To install on a phone, host the folder anywhere (GitHub Pages, Netlify) and use "Add to Home Screen."

## Screens

| Tab | Purpose |
|---|---|
| Dashboard | Goal progress ring, this week's plan, event funds, advice |
| Daily Log | Log today's earnings/spending; day-by-day targets and the next 7 days of bills |
| Sunday Check-in | Weekly confirm; shows next week's marching orders |
| Roadmap | Every week from now to the goal date, with projected balances |
| Settings | Balances, income, bills, events, data export/import |

*All numbers in the demo are sample data.*
