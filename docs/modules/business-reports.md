# Business report emails (daily, weekly, monthly)

The owner gets three automatic emails. Each covers a period that has already
ended, on Nairobi time:

| Report | Sent (Nairobi) | Covers | Compared with |
| --- | --- | --- | --- |
| Daily | every day 07:00 | yesterday, 00:00–24:00 | the day before |
| Weekly | Mondays 07:05 | last Monday–Sunday | the week before |
| Monthly | 1st of the month 07:10 | last calendar month | the month before |

## What is in it

- **Sales and collections**: M-Pesa cash in (deposits included), paid orders,
  order value, items sold, average order, pickup vs delivery, new deposit
  holds, payment success rate, refunds, and a warning when a payment is
  waiting for manual review.
- **Inventory and listing**: items checked in, items published, what is on sale
  now and its total ticket price, items held in carts or by deposits, items
  still in digitisation, and the five listings that have gone longest unsold.
- **Warehouse**: parcels packed and handed over in the period, delivery
  failures, the current queue at each stage, paid orders more than 48 hours old
  and still not handed over, and picks and packs per employee.
- **Affiliate team growth (分销团队增长)**: see the next section.
- **Returns and customer service**: return requests, returns received, new
  cases, open and overdue cases, and refunds waiting for approval.

Period numbers are compared with the previous period. Numbers marked "现在"
(right now) describe the shop at the moment the email was built.

An order counts as sold when its last payment clears: the full payment, or the
balance on a deposit order. A deposit alone is counted as a new hold, not as a
sale.

The warehouse section also shows **期间已付骑手费**: rider pay sent in the
period, the sum of rider payouts recorded in 推广中心 → 周结付款 (by paidAt,
since 2026-10-14).

## Affiliate team growth (分销团队增长)

Added 2026-10-10. Code: `apps/storefront/src/reports/affiliate-team.ts`.
Every number uses the same definition as the 推广中心 page in the operations
app, so the two can be checked against each other:

| In the email | Meaning |
| --- | --- |
| 推广员总数 | Promoters created before the period end and not disabled by then |
| 新增推广员 | Promoters created in the period |
| 活跃推广员 | Promoters whose links got at least one click in the period |
| 总点击 | Affiliate link clicks in the period (one `AffiliateClick` row each) |
| 分销订单 | Paid orders carrying the promoter, counted when the last payment cleared (same rule as 成交订单) |
| 分销销售额 | Item subtotal of those orders, delivery fee excluded (like 带来销售额 on 推广中心, and the commission base) |
| 点击→下单转化率 | 分销订单 ÷ 总点击, with the previous period's rate beside it |
| 期间产生佣金 / 已付佣金 | Commission created in the period (rejected excluded) / commission paid in the period: weekly M-Pesa payouts recorded in 周结付款 (by paidAt, since 2026-10-14) plus any commission still marked paid one by one |
| 现在沉睡的推广员 | Right now: active promoters whose links got no click in the last 7 days, out of all active promoters. A promoter who never got a click counts too, with how long ago they joined |

Below the rows: a 全部 vs 外部 table (clicks, orders, sales, commission and
conversion for everyone and for external promoters only, the external figures
compared with the previous period), the top 10 promoters by orders then
clicks, and up to 10 dormant promoters with the days since their last click.

### Who counts as staff

There is no column linking an `Affiliate` to an `Employee` or `AdminUser`, so
staff promoters are recognised by contact details, against Employee and
AdminUser records whose status is `ACTIVE`, in this order:

1. **Phone**: the promoter's phone, or the phone of the shop account it was
   enabled from, equals a staff phone. Phones are compared after normalising
   `07xx…`, `7xx…` and `+2547xx…` to `2547xx…`, the same rule as checkout.
2. **Email**: the promoter's or its shop account's email equals a staff email,
   ignoring case. An AdminUser's login account also counts when it looks like
   a phone number or an email address.
3. **Full name**: only if neither matched, the display name equals a staff
   member's full name (two words or more, case and spacing ignored). A single
   first name is never enough.

Everyone else is external. The email ends the section with the list of
promoters counted as staff and which rule matched them (e.g. "Faith Nyambura
（手机号对上员工账号 Faith2026）"). If someone is missing or wrongly listed, fix
the phone or email on the promoter or the staff account; the next report
follows. A staff member who has left (Employee `LEFT`/`SUSPENDED`, AdminUser
`DISABLED`/`LOCKED`) counts as external from then on.

## How it runs

- Code: `apps/storefront/src/reports/` and the internal route
  `POST /api/internal/send-business-report?period=daily|weekly|monthly`,
  protected by `INTERNAL_CRON_SECRET` like the other scheduler routes.
- Schedule: three Cloud Scheduler jobs, `business-report-{daily,weekly,monthly}-production`,
  created by `scripts/gcloud/configure-production-scheduler.sh` during the
  production storefront deploy.
- Read only. It never changes an order, payment, garment or commission.
- Email is sent with [Resend](https://resend.com). Each send carries an
  idempotency key (`business-report/<period>/<first day>`), so a scheduler retry
  does not send the same report twice.

## One-time setup

1. Create a Resend account with the address that should receive the reports,
   and create an API key.
2. Store two secrets in Google Secret Manager in the production project (never
   in GitHub or in this repository):
   - `PRODUCTION_RESEND_API_KEY`: the Resend API key
   - `PRODUCTION_BUSINESS_REPORT_EMAIL_TO`: recipient addresses, comma-separated
3. Run the production storefront deploy once. It attaches both secrets and
   creates the three scheduler jobs.

Until a domain is verified in Resend, mail is sent from `onboarding@resend.dev`
and only reaches the Resend account owner's own address. To send to other people
as well, verify a domain in Resend (it adds a few DNS records), then set the
GitHub repository variable `BUSINESS_REPORT_EMAIL_FROM_PRODUCTION` to an address
on that domain, e.g. `Direct Loop Reports <reports@your-domain>`, and deploy
again. A sender address is not secret, so a plain variable is fine; left empty,
the Resend test sender is used.

If either secret is missing, the deploy prints a warning, the jobs still run,
and the route answers `sent: false` with the reason. Nothing else is affected.

## Checking or re-sending by hand

With the cron secret as the bearer token:

- `...?period=weekly&preview=1` returns the email as a web page and sends nothing.
- `...?period=daily&date=2026-09-20` builds the report for the period that holds
  that day. Re-sending the same period within 24 hours is ignored by Resend.
