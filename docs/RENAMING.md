# Changing the name later

Today a rename takes about 15 minutes in code:

1. `src/config/brand.ts`: name, tagline, colors (every text and email uses this).
2. `apps/site/site.body.html`: the word "KeyHelm" in the logo, headings and copy (find and replace), then `npm run build:site`.
3. `EMAIL_FROM` in Railway variables.

It gets harder once these exist under the old name, so decide before doing them:

| Thing | Why it's sticky |
| --- | --- |
| Twilio A2P 10DLC brand and campaign registration | Registered under a business and brand name; changing it means re-registering and waiting again |
| Domain, and email sender reputation (Postmark) | A new domain has to warm up again |
| Stripe statement descriptor and business profile | Easy to edit, but owners and tenants see it on bank statements |
| Trademark, social handles, app store listings | Filing fees and lost search history |
