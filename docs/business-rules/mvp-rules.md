# MVP Business Rules

These rules define the first 1,000-item Kikuyu MVP.

## Inventory

- Each second-hand clothing item is unique.
- The first 1,000 online items are fully isolated from store inventory.
- The cart does not reserve inventory.
- Inventory is reserved only after payment is initiated.
- Reservation duration is 5 minutes (2026-09-23; previously 15).
- The bag holds at most 50 pieces. Adding one more to a full bag is refused
  with a message telling the shopper to check out first; nothing is dropped
  silently (2026-10-05, owner decision; previously 10, with extras dropped).
- One phone number may have at most 50 pieces locked for payment at the same
  time (2026-10-05, owner decision; previously 5). Starting a new checkout
  first releases that phone's earlier unpaid attempts — and the same
  account's — back to sale, exactly as an expiry would. An earlier attempt
  whose M-Pesa prompt has been sent and may still be paid is kept until it
  is answered or its five minutes run out, and still counts against the 50.
- Deposit holds keep their own, separate allowance of 3 pieces per phone.
- Closing an order always settles its stock. An unpaid cancellation returns the
  garment to sale; a paid order that can never be fulfilled is written off with
  an explicit outcome — back on the shelf, or recorded as lost.
- A garment held by a paid deposit sits in its own inventory state,
  `DEPOSIT_HELD`, and must never be sold over the counter. It still occupies a
  shelf and still counts against warehouse capacity.

## Product intake (2026-09-28, owner decision)

- Cancelling a whole intake batch means the batch was never entered. Its items
  that are not yet on sale are permanently deleted with their inventory
  records; they do not remain as "rejected" (`ARCHIVED`) and do not appear in
  product management. Items already published or unpublished stay. An item
  that is tied to a customer order, or whose stock has moved beyond
  `PENDING_STOCK_IN`/`AVAILABLE`, is never deleted this way.
- The cancel dialog states how many items will be deleted before anything
  happens, and the deletion is written to the audit log.
- An item rejected at review (not by cancelling its batch) stays "rejected"
  and can be restored.
- There is no general "delete rejected items" button. Deletion happens only as
  part of cancelling a batch.

## Deposit plan (50% deposit, 7-day hold)

Added 2026-09-23. A shopper who cannot pay in full today may pay half and hold
the piece for a week.

- The choice is offered at checkout on every order of at least KSh 2: pay in
  full, or pay a 50% deposit.
- The deposit is half the order total including delivery, **rounded up**, so on
  an odd total the first payment is the larger half. The balance is the
  remainder. Both figures are frozen on the order at checkout; a later price
  edit cannot change what the shopper owes.
- The deposit itself is still an M-Pesa STK prompt inside the ordinary
  five-minute reservation window. The seven days start only once that money has
  actually landed.
- While the deposit holds, **nothing is picked, packed or dispatched, and no
  affiliate commission exists.** A deposit order is a sale that may still fall
  through. Only the balance completes it.
- The balance is one payment for the full remainder; it cannot be paid in
  instalments. A failed or cancelled balance prompt costs the shopper nothing
  and leaves the hold standing.
- One phone number may hold at most 3 items on deposit at a time. This is
  counted separately from, and applies on top of, the 5-item cart reservation
  cap.
- Reminders go out on day 4 and day 6.
- **There is no grace period.** At the seven-day mark the garment goes back on
  sale immediately.
- On lapse the shopper is refunded **30% of the order total** and the shop
  keeps **20% of the order total** for the week the piece spent off sale. On a
  KSh 1,000 order: KSh 500 deposit, KSh 300 refunded, KSh 200 kept. The refund
  is never more than what was actually collected.
- The refund is *raised*, not paid: the expiry sweep creates a
  `LAPSED_DEPOSIT` refund request in the finance queue, and someone executes it
  in M-Pesa by hand like every other refund.

## Payment

- Customers pay the platform, not the affiliate.
- M-Pesa is the first payment method.
- Payment callbacks must be idempotent.
- Payment status and order status are separate.
- A callback that does not match cleanly — late, wrong amount, duplicate
  receipt, no matching STK request — is never guessed at. It goes to manual
  review, where a reviewer settles it or marks it not received against the
  M-Pesa merchant statement.
- Every STK request whose callback never arrives is queried against Safaricom
  directly, so a lost callback cannot quietly expire on a shopper who has paid.
- Every payment records which leg of the order it is: `FULL`, `DEPOSIT` or
  `BALANCE`. An amount is only accepted when it matches that leg exactly, so a
  deposit can never be mistaken for a discounted full payment.

## Warehouse task ownership

Changed 2026-09-24. Picking and packing are both owned work, but they are
claimed differently, because the risks are different.

- **Picking is claimed by scanning.** The first barcode a picker scans on an
  order takes that order. From then on it is only in their queue and the server
  refuses anyone else. There is no separate "claim" press and no
  claim-everything button: one press that handed a single picker every order on
  the floor left every other phone empty for reasons nobody could see.
- An order nobody has scanned is visible to every picker. That is the pool.
- **The picker is the default packer.** Verifying the last barcode assigns the
  parcel to whoever picked it, so one person can pick a trolley and pack it
  without anyone handing it over. It is still assigned work with a name against
  it — which is the point — and a supervisor may reassign it until packing starts.
- **Packing is handed out, never taken.** A packer may only pack a parcel a
  supervisor assigned to them, and an unassigned parcel belongs to nobody. A
  trolley of loose garments is the last point at which what went into a bag can
  still be traced to a person, so it is not left to whoever reaches it first.
- Packers see only their own parcels. Supervisors — anyone holding
  `orders.assign-packer` — see the floor and may pack directly, otherwise a
  warehouse where nothing had been handed out yet could not start. A supervisor
  who packs an unassigned parcel is recorded as its packer.
- A parcel cannot be reassigned once packing has started. That is an exception,
  not a reassignment.

## Fulfillment

- Orders are served from fulfillment nodes: one central warehouse plus the
  stores. Nodes are configured in operations, not in code.
- Pickup orders carry the node the shopper chose at checkout, and a six
  character pickup code they read out at the counter. Delivery orders are
  routed to a node by operations before the package leaves the warehouse.
- A package bound for a store is sent, then scanned in on arrival, before it
  can be handed to anyone. Warehouse handovers skip both steps.
- Pickup at any store or the Kikuyu warehouse is free.
- Door-to-door delivery within Nairobi charges the customer a flat KSh 200
  (2026-09-26; it was KSh 50 from 2026-09-23 and 0 under the 2026-09-12 launch
  policy). The node pays the real Bolt fare, which is
  recorded per order; the difference is the company's delivery subsidy.
- Redelivery is arranged manually without an automatic delivery charge.
- A fulfillment exception remembers the step it interrupted, so a resolved
  exception rejoins the flow instead of ending the order.

## Returns

2026-09-26 (owner): a customer who is not satisfied may bring the item back to a
store within 3 days (72 hours) of completed delivery or pickup, for any reason,
and is refunded on M-Pesa. Staff record it in the Operations after-sales panel;
"Customer not satisfied" is a return reason alongside the earlier ones (wrong
item, photo mismatch, undisclosed defect, measurement more than 3 cm off,
delivery damage). Refunds stay manual; do not add automated decisions or refunds.

Until 2026-09-26 returns were accepted only for those five reasons and within
24 hours.

2026-11-02 (owner request): when the warehouse accepts a returned item it must
add 1 to 5 photos of it. Without a photo the item cannot be accepted. Photos are
stored in the private product-image bucket (only their path is in the database)
and are shown on the order's returns card to staff who can view orders. This
changes no money rule: refunds stay manual and are still recorded afterwards.

2026-11-02 (owner request, step 2): accepting a returned item also opens a
refund request for that item's price, raised by the person who accepted it. The
approver reviews the photos and approves or rejects it with a note; the person
who raised it cannot approve it. A refund for a returned item can only be
recorded once its request is approved, and only up to the approved amount. It is
recorded on the order page (not on the refund approvals page), because only that
path reverses the affiliate commission, updates the return status and applies
the restock rules. Returns accepted before this rule have no request and keep
the old behaviour. Refunds are still made by hand in M-Pesa.

2026-11-03 (owner request): the 售后订单 page has an 导出退货记录 button that
downloads a CSV (opens in Excel) with one line per returned garment in a date
window (default last 30 days): reason, who requested, received and approved it,
photo count, refund request status, amount approved and refunded, M-Pesa
reference. A tick-box limits it to approved refunds not yet paid out, which is
the list finance works from when sending refunds by hand. The file carries
customer names and phone numbers, so only accounts with a refund permission can
download it, and each download writes an audit entry
(`GET operations/after-sales/export`). It is read-only. Columns for exchanges are
already in the file and stay empty until exchanges exist.

## Exchanges

2026-11-03 (owner request): on the order page, a 换货 card swaps one garment on
an order for another. Exchange is its own action; the returns and refunds buttons
only handle returns.

It is allowed only when the order is fully paid and picking has not started (no
scan yet, the old garment still waiting as PAID), and the new garment is on sale.
A cheaper garment is refused (use a return and refund). An order that is
deposit-only, picking, packed or delivered is refused with the reason. The old
garment goes straight back to AVAILABLE and stays listed (it never left the
shelf, so it is not re-reviewed); the new garment becomes PAID for the order and
disappears from the shop. Both stock changes, the order line's snapshot, the
picking task's expected barcode and an `OrderExchange` history row are written in
one transaction under the order lock; the new garment is claimed with a
conditional update so two people cannot take it at once. It needs the
`orders.after-sale` permission and a reason, and writes an audit entry.

Same price: nothing is paid and the order total, payments and commission do not
change. Dearer garment: the customer pays the whole difference by M-Pesa (no
discount on an ordinary exchange). Staff enter the transaction code and the
amount, which must equal the difference; the code must be 10 letters and digits
and unused by any other exchange or recorded payment. The order line price, the
order item subtotal and total rise by the difference, and a commission that is
not yet paid out is recalculated on the new subtotal (a commission already paid
out, or in a payout batch, blocks the top-up). The top-up is stored on the
exchange row, not as a payment row, so it does not touch the M-Pesa payment
records; it is counted towards the amount a later refund may reach.

Planned, not built: exchanges on delivered orders within 3 days (old garment
returned with photos and reviewed before the new one is sent, then relisted
directly), a "return to exchange" option worth KSh 80 off the top-up, ticked by
staff with a reason, once per order, and a commission already paid out being
corrected as a negative adjustment line in the next commission export. Commission
is always calculated on what the customer actually paid.

## Refunds

- The system never moves money. A refund is executed in M-Pesa first and then
  recorded against the order with its reference and evidence.
- Refunds attach to the order, not only to a return, so an order that was paid
  for but can never be fulfilled can be refunded too.
- Recorded refunds can never exceed what was actually paid. Once they cover the
  full payment the order becomes REFUNDED.
- A lapsed deposit hold is the one refund the system raises by itself. It has
  no requesting admin user, because it is created by a timer, and it still
  waits for approval and manual execution like every other refund.

## Affiliate

- Affiliate distribution is single-level in the MVP.
- New commissions use 25% of the paid item subtotal, excluding delivery
  (2026-09-15); historical commission snapshots are preserved.
- Attribution uses the last valid referral source: the most recent tracked
  click within the window wins, including when a shopper clicks one affiliate's
  link and then another's before paying.
- Attribution expires after 7 days.
- Commission is estimated after payment.
- Commission is confirmed 72 hours (3 days) after delivery or pickup if no
  valid return request exists (owner, 2026-10-14; was 24 hours). This matches
  the 3-day return window, so commission is never confirmed while the garment
  can still come back. Commissions already confirmed under the 24-hour rule
  stay confirmed.
- Commission is paid weekly (2026-10-14, "做法一"): every Monday finance opens
  推广中心 → 周结付款 for the previous Monday–Sunday (Nairobi), sends each
  person their total by hand with M-Pesa Send Money, and records the M-Pesa
  transaction code against that person. One code marks all of that person's
  items in the sheet paid at once (commissions move CONFIRMED → PAID; rider fees
  are linked to the payout). A code can be recorded only once, an item already
  paid is never listed again, and the paying admin cannot record a payout to
  themselves. Only SUPER_ADMIN and FINANCE hold `finance.payout`.
- A commission belongs to the week it was confirmed in; a rider fee belongs to
  the week its delivery was completed with the customer's code.
- The payment list is exported from one place only, the 导出 panel on 周结付款
  (read-only, `GET operations/payouts/export`): a week, a date range, everything
  unpaid, or everything unpaid from before a week; promoters and riders; unpaid,
  paid or both; one line per person per week or one per order. Paid lines carry
  the M-Pesa code they were paid with. It does not change any payout or
  commission state.
- Refunded items revoke the related commission.
- A cancelled or written-off order reverses its commission: an unconfirmed one
  is rejected, a confirmed one is frozen with a hold reason so it cannot be
  paid out without review.

## Notifications

- Messages are queued in an outbox inside the transaction that earns them, so a
  provider outage can never roll back an order and a retried transition can
  never send twice.
- Customers are told: payment received, ready for pickup, dispatched,
  completed, refunded.
- Affiliates are told: first sale, new order, commission available, paid.
- Stores are told when a package is on its way and when one is waiting for a rider.
- With no SMS provider configured, messages stay queued and visible in
  operations rather than being dropped.

## Explicitly Out of Scope

- Multi-vendor marketplace.
- Multi-level distribution.
- Native app.
- AI recommendation.
- Nationwide delivery automation.
- General merchandise agency model.
