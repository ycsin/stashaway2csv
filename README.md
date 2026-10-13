# stashaway2csv

Converts StashAway monthly statement PDFs into CSV or QIF files for a personal finance app.

**Use it at <https://ycsin.github.io/stashaway2csv/>**, or download `index.html` and open it
locally. Drop the PDFs, pick the months, download. It's one
self-contained file (pdf.js embedded, no network access); the PDFs never leave the browser.

Works with statements in any reporting currency: amounts are kept in the statement's base
currency (e.g. SGD, MYR), and USD amounts are converted at the statement's month-end rate
where a single-currency file needs it. Tested with Singapore (SGD) and Malaysia (MYR)
statements; other countries should work if their statements use the same layout. Load one
StashAway account at a time: statements in a different reporting currency are set aside.

**Unofficial, not affiliated with StashAway.** Check the results against your statements
before relying on them.

## Output, per portfolio

- **Cash-like** (listed under *Cash Management*, plus fixed-term placements): one transactions CSV with
  deposits, withdrawals, fees, rebates and a monthly *Returns (month-end adjustment)* row, so
  the running balance equals each statement's closing balance.
- **Investment** (listed under *Investment Portfolios*), one switch at the top for all of them:
  - *Balance only* (default): one adjusted transactions CSV, like cash-like portfolios
    (USD converted at the statement's month-end rate)
  - *Balance + trade log*: the same file plus every buy/sell as a 0.00 line
    (`Buy 1.5 VWRA @ USD 120.00 (USD 180.00)`): full activity, no ticker lookups or holdings needed
  - *With holdings*: trades CSV, transactions CSV, month-end balances CSV

A **QIF** per portfolio (Balance only and trade log; button, and included in the zip) has the
same transactions, including the monthly returns adjustments, starting with an *Opening
Balance* record (the balance just before the first entry). Trade lines aren't included; With
holdings has no QIF (QIF's bank format can't carry units and prices). QIF has no currency
field: import each file into an account of that currency. Dates are `YYYY-MM-DD`.

An **Accounts CSV** (button, and included in the zip) lists each exported portfolio as
`Account type,Name,Balance,Currency,Balance Date`: Investment/Savings, "StashAway <portfolio>", and
the starting balance just before the first exported entry (0 for a full history; the previous
month's closing when exporting from a later month).

A **Combined CSV** button puts all portfolios in one file with a leading `account` column (for
multi-account imports; names match the Accounts CSV). With holdings it's a zip with a combined
trades file and a combined transactions file.

Columns: trades `date,ticker,qty,price,currency,name` (negative qty = sell); transactions
`date,amount,currency,name` with inflows positive; month-end balances `date,balance,currency`.

Portfolios are detected from the statements, with no built-in list of names: a portfolio
keeps its identity across months by name (as written, apart from "™" and a "StashAway "
prefix) and reporting currency, and across renames, by StashAway or by you, when a new
name opens with exactly the closing balance of a portfolio that disappeared that month.
Same-named portfolios are told apart by currency ("Name (SGD)", "Name (USD)"); the
statement section decides investment vs cash-like; fixed-term placements are grouped into
one "Guaranteed" account. The **Portfolios** panel lets you rename an account, change its
type, merge it into another portfolio, or exclude it (saved in the browser).

The page also explains this grouping, and lists
what was skipped (internal FX conversions, fixed-deposit placements) or balanced
(months where a statement omits deposit rows).

## Development

- `src/parser.js`: statement parsing and CSV output, shared by the page and the tests
- `src/app.js`, `src/index.template.html`: the UI
- `vendor/`: pdf.js 3.11.174 (`pdf.min.js`, `pdf.worker.min.js`)
- `python3 build.py`: rebuilds `index.html` (inlines everything). Commit the result: GitHub
  Pages serves `index.html` as-is, and the *Build check* workflow fails if it's out of date.

Tests need your own statement PDFs and write private output (extracted statement text,
CSVs, screenshots); keep those outside the repo or in `test/out/`, which is git-ignored.

Tests (`cd test && npm install --ignore-scripts pdfjs-dist@3.11.174 playwright-core@1.57.0`):
- `node compare.js <pdf dir> <reference parsed.json>`: parse with pdf.js and compare to a
  reference parse (`DUMP=out.json` also saves the extracted text)
- `node adjusted.js out.json`: balance-only exports hit every statement closing balance
- `node gaps.js out.json`: same, with statements removed (missing months are bridged by one
  "Balance change not covered by statements" entry; the earliest statement's non-zero openings are reported)
- `CHROME=<chrome-headless-shell> node e2e.js <pdf dir> <out dir>`: drive the page, save the zips
- `DUMP=out.json CHROME=... node config-e2e.js <pdf dir> <out dir>`: drive the Portfolios panel
  (merge, rename, exclude, reload, reset) and check merged balances
- `compare.js` takes an optional third argument, a map file `{ names: {ours: reference}, config }`

## License

Apache License 2.0, see [LICENSE](LICENSE). Includes PDF.js (Mozilla Foundation,
Apache-2.0), see [NOTICE](NOTICE). Not affiliated with or endorsed by StashAway.
