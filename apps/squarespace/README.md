# KeyHelm website on Squarespace

Each `.html` file here is one paste-in **Code Block** for one Squarespace page. Each block brings its
own styles, KeyHelm's nav and footer, and hides Squarespace's header and footer on that page.
Don't edit these files by hand. Edit `apps/site/site.body.html` or `src/api/legal.ts`, then rebuild:

```
BUSINESS_EMAIL=help@yourdomain.com npm run build:squarespace
```

| File | Squarespace page | URL slug | Page title (SEO) |
| --- | --- | --- | --- |
| `home.html` | Home (set as homepage) | `/` | KeyHelm: rental management software for Colorado landlords |
| `privacy.html` | Privacy policy | `privacy` | Privacy policy, KeyHelm |
| `terms.html` | Terms of service | `terms` | Terms of service, KeyHelm |
| `sms.html` | Text messages | `sms` | KeyHelm text messages |
| `cookies.html` | Cookie policy | `cookies` | Cookie policy, KeyHelm |
| `refunds.html` | Refund and cancellation policy | `refunds` | Refund and cancellation policy, KeyHelm |
| `accessibility.html` | Accessibility | `accessibility` | Accessibility, KeyHelm |

The slugs must match exactly: the pages link to each other at `/privacy`, `/terms`, `/sms` and so on.
Home page SEO description: "For Colorado landlords with 1 to 50 homes. KeyHelm answers tenants 24/7 and
handles repairs, rent reminders, renewals and move-outs. You just approve. One flat price per door, from $8 a month."

## Steps in Squarespace

The plan must be **Core or higher**: code blocks that run scripts need it (the home page's savings
calculator and signup window use a small script).

1. **Pages** → **+** → **Blank page**. Name it **Home**. Click the gear → **Set as homepage**.
2. Click **Edit** → **Add block** → **Code**. Delete the sample text and paste the whole of `home.html`.
   Turn **Display source** off. Drag the block's edges so it spans the full width of the section. **Save**.
3. For each legal page: **Pages** → **+** (under **Not linked**) → **Blank page** → name it from the table →
   gear → **URL slug** from the table → **Edit** → **Add block** → **Code** → paste the file → **Save**.
4. Each page's gear → **SEO** → paste the page title from the table.
5. Search the dashboard for **Browser icon** and upload `keyhelm-logo-512.png`.
6. **Settings** → **Cookies & visitor data** → turn the **Cookie banner** on with Accept and Decline.
   The cookie policy on this site says there is a banner, so this step is required.
7. **Settings** → **Domains**: connect or buy the KeyHelm domain.
8. Delete Squarespace's sample pages so they don't show up in search.

## What works differently from the Railway site

- **Book a demo call** opens Calendly directly.
- **Get started** opens the same signup window. Submitting it sends the form to the KeyHelm app
  (`APP_URL`, today the Railway address) and the app sends the visitor to Stripe Checkout. While the
  app is down, the visitor sees the browser's error page instead of checkout.
- The cookie and privacy pages name Squarespace and Google Fonts, because Squarespace sets cookies and
  the fonts load from Google here.
