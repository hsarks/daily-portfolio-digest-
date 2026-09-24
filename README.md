# Daily Portfolio Digest

A spreadsheet-driven Google Apps Script that emails a daily HTML summary of the holdings in a Google Sheet. It combines spreadsheet prices with Finnhub company news, Google News RSS results, and Gemini-generated market commentary.

Holdings are never hard-coded in the script. Add or remove rows in the spreadsheet and the next digest adapts automatically.

## Files in this repository

- [`Daily_Portfolio_Digest.gs`](Daily_Portfolio_Digest.gs) — the complete, sanitized Apps Script
- [`Daily_Portfolio_Digest_Sheet_Template.xlsx`](Daily_Portfolio_Digest_Sheet_Template.xlsx) — a blank portfolio template for import into Google Sheets
- [`Daily_Portfolio_Digest_Setup_Guide.pdf`](Daily_Portfolio_Digest_Setup_Guide.pdf) — illustrated setup walkthrough
- [`Daily_Portfolio_Digest_Example_Sanitised.pdf`](Daily_Portfolio_Digest_Example_Sanitised.pdf) — sanitized example of the finished email

## What you need

- A Google account with access to Google Sheets and Apps Script
- A Finnhub API key
- A Gemini API key
- The email address that should receive the digest

## Quick start

1. Upload `Daily_Portfolio_Digest_Sheet_Template.xlsx` to Google Drive and open it with Google Sheets.
2. Enter one exchange-qualified ticker per row in column A, such as `NASDAQ:MSFT`, `NYSE:DIS`, or `LON:SGLN`.
3. Confirm that Google Sheets fills columns B, C, and E. The formulas use [`GOOGLEFINANCE`](https://support.google.com/docs/answer/3093281?hl=en).
4. In the spreadsheet, open **Extensions → Apps Script**.
5. Replace the default editor contents with the full contents of `Daily_Portfolio_Digest.gs`.
6. Replace these three placeholders in your private Apps Script copy:
   - `YOUR_FINNHUB_KEY_HERE`
   - `YOUR_GEMINI_KEY_HERE`
   - `YOUR_EMAIL@gmail.com`
7. Save the project, select `dailySummary`, and run it once. Google will ask you to review and grant the permissions the script needs.
8. After the test email arrives, select `createDailyTrigger` and run it once to schedule the digest every day at approximately 08:07 in the Apps Script project's time zone.

Google's guides explain [Apps Script authorization](https://developers.google.com/apps-script/guides/services/authorization) and [installable triggers](https://developers.google.com/apps-script/guides/triggers/installable). Google's [Gemini API quickstart](https://ai.google.dev/gemini-api/docs/get-started) explains how to create and test a Gemini key.

## Spreadsheet layout

The `Portfolio` tab must be active when `dailySummary` runs.

| Column | Heading | Purpose |
| --- | --- | --- |
| A | Ticker | Exchange-qualified ticker entered by the user |
| B | Price | Current or delayed price from `GOOGLEFINANCE` |
| C | Change % | Percentage-point change from `GOOGLEFINANCE`; `1.25` means `+1.25%` |
| D | Headlines | Optional compatibility field; it may remain blank |
| E | Share Name | Instrument name from `GOOGLEFINANCE` |

The template contains formulas through row 101. Extend them farther down if the portfolio needs more rows.

## Privacy and safe sharing

The public files in this repository contain placeholders only. Do not add real API keys or a personal email address to a public repository.

- Put credentials only in your own private Apps Script copy.
- Do not publish a link to a private portfolio spreadsheet.
- Review screenshots and example emails before sharing them.
- If you publish through GitHub, enable GitHub's private email or `noreply` address before committing files.
- If a credential is accidentally exposed, revoke it immediately and issue a new one.

## Known limitations

- Free API plans can enforce request or daily quotas. A Finnhub `429` response means its rate limit was reached; the script stops further Finnhub calls for that run.
- Gemini model availability and quota vary by account. The script tries compatible models and falls back when needed.
- `GOOGLEFINANCE` quotes can be delayed, and some exchanges or instruments are unsupported.
- Currency detection is heuristic for unusual instruments. Add exceptional symbols to `CURRENCY_OVERRIDES` in your private copy.
- The time trigger runs under the Google account that created it. Apps Script may run a time-driven trigger within a small time window rather than at an exact second.
- News and generated commentary may be incomplete or incorrect. Treat the digest as informational, not financial advice.

## Troubleshooting

### No email arrives

Run `dailySummary` manually, complete any pending permission prompts, confirm the recipient placeholder was replaced, and review **Executions** in Apps Script for the error details.

### Prices or names stay blank

Use exchange-qualified tickers, confirm the formulas were imported into columns B, C, and E, and check whether the instrument is supported by `GOOGLEFINANCE`.

### Finnhub reports `429`

Wait for the provider's quota window to reset or reduce the number of holdings. Cached results and the script's stop-on-limit behavior help prevent repeated requests during the same run.

### The price uses the wrong currency

Add a specific entry to `CURRENCY_OVERRIDES`. The commented examples in the script show the expected format.

## Version and support

This repository is version 1.0, prepared in September 2026. Use the Issues area for reproducible bugs and setup questions. Never paste API keys or personal account details into an issue.

## License

Released under the [MIT License](LICENSE).
