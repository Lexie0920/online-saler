# MVP State Machines

This document defines the state machines that protect one-item inventory, payment
accuracy, fulfillment, returns, and commission integrity.

State transitions must be enforced by the backend. Frontends may request actions,
but they must not directly set final states.

## Global Rules

- All state changes write `AuditLog`.
- State changes must record actor, timestamp, source app, and reason when manual.
- Payment status and order status are separate.
- Product state and inventory state are separate.
- Inventory reservation and payment callback handlers must be idempotent.
- A terminal state can only be reopened through an explicit exception flow.
- High-risk manual overrides require an admin permission and reason.

## Product State

Product state describes the digital product record and content readiness.

```text
DRAFT
  -> PHOTOGRAPHED
  -> AI_PROCESSING
  -> AI_PROCESSED
  -> CALIBRATION_PENDING
  -> CALIBRATED
  -> BARCODE_ASSIGNED
  -> REVIEW_PENDING
  -> REWORK_REQUIRED
  -> APPROVED
  -> READY_FOR_STORAGE
  -> PUBLISHED
  -> UNPUBLISHED
  -> ARCHIVED
```

### Product State Definitions

| State | Meaning |
| --- | --- |
| `DRAFT` | Product shell exists but has no assigned barcode. |
| `PHOTOGRAPHED` | Required images are uploaded. |
| `AI_PROCESSING` | AI extraction job is running. |
| `AI_PROCESSED` | AI raw output is saved. |
| `CALIBRATION_PENDING` | AI values are ready for human calibration. |
| `CALIBRATED` | Human final data is saved; no formal barcode has been assigned yet. |
| `BARCODE_ASSIGNED` | Unique formal barcode is assigned after calibration. |
| `REVIEW_PENDING` | Calibrated and barcoded product is ready for review. |
| `REWORK_REQUIRED` | Review failed; product needs new photos, data, or condition correction. |
| `APPROVED` | Human reviewer approved final product data. |
| `READY_FOR_STORAGE` | Product is approved and ready for check-in. |
| `PUBLISHED` | Product is visible on Storefront. |
| `UNPUBLISHED` | Product is hidden but not archived. |
| `ARCHIVED` | Product record is closed for normal operations. |

### Product Transition Rules

- Formal barcode is assigned only after human calibration is complete.
- `DRAFT -> PHOTOGRAPHED` requires front, back, and label images tied to the product shell or capture batch item.
- Defect images are required if any defect is recorded.
- `PHOTOGRAPHED -> AI_PROCESSING` can be automatic or manual.
- `AI_PROCESSING -> AI_PROCESSED` saves AI output and confidence values.
- `AI_PROCESSED -> CALIBRATION_PENDING` exposes AI values to the human calibrator.
- `CALIBRATION_PENDING -> CALIBRATED` requires final category, price, condition, and measurements.
- `CALIBRATED -> BARCODE_ASSIGNED` requires unique formal barcode.
- `BARCODE_ASSIGNED -> REVIEW_PENDING` requires barcode and final data to be complete.
- `REVIEW_PENDING -> APPROVED` requires reviewer approval of final category, price, condition, measurements, and barcode.
- `REVIEW_PENDING -> REWORK_REQUIRED` requires reason.
- `REWORK_REQUIRED -> PHOTOGRAPHED` is allowed when new photos are required.
- `REWORK_REQUIRED -> CALIBRATION_PENDING` is allowed when only data or condition correction is required.
- `APPROVED -> READY_FOR_STORAGE` is allowed only when formal barcode and final data are complete.
- `READY_FOR_STORAGE -> PUBLISHED` requires inventory state `AVAILABLE`.
- `PUBLISHED -> UNPUBLISHED` is allowed for admin and system rules.
- `ARCHIVED` cannot return to normal states without admin exception.

## Inventory State

Inventory state describes the physical item's sale and warehouse position.

```text
PENDING_CHECKIN
  -> AVAILABLE
  -> RESERVED
  -> PAID
  -> PICKING
  -> PICKED
  -> PACKED
  -> SHIPPED
  -> DELIVERED
  -> RETURN_INSPECTION
  -> AVAILABLE

Any non-terminal operating state can move to:
  LOST
  DAMAGED
  ADMIN_HOLD
```

### Inventory State Definitions

| State | Meaning |
| --- | --- |
| `PENDING_CHECKIN` | Product approved but not yet scanned into an online location. |
| `AVAILABLE` | Item is physically online and can be sold. |
| `RESERVED` | Item is reserved for a payment attempt. |
| `PAID` | Order is paid and item is no longer for sale. |
| `PICKING` | Item is assigned to a picking task. |
| `PICKED` | Correct barcode was scanned for the order. |
| `PACKED` | Item is inside a parcel. |
| `SHIPPED` | Parcel has left warehouse or is out for pickup handoff. |
| `DELIVERED` | Item was delivered or picked up. |
| `RETURN_INSPECTION` | Returned item is waiting for warehouse inspection. |
| `LOST` | Item cannot be found after exception process. |
| `DAMAGED` | Item cannot be sold because it is damaged. |
| `ADMIN_HOLD` | Admin temporarily blocks sale or movement. |

### Inventory Transition Rules

- `PENDING_CHECKIN -> AVAILABLE` requires product state `READY_FOR_STORAGE` or `PUBLISHED`, a valid online location, and product barcode scan.
- `AVAILABLE -> RESERVED` is created only by payment initiation.
- Cart actions do not change inventory state.
- Reservation duration is 15 minutes.
- One phone number may hold at most 5 active reservations.
- `RESERVED -> AVAILABLE` happens when reservation expires or order is canceled before payment.
- `RESERVED -> PAID` happens only after valid payment confirmation.
- `PAID -> PICKING` happens when picking task is generated.
- `PICKING -> PICKED` requires correct location and product barcode scan.
- `PICKED -> PACKED` requires packer scan confirmation.
- `PACKED -> SHIPPED` requires pickup or delivery handoff.
- `SHIPPED -> DELIVERED` requires pickup code verification, delivery confirmation, or admin-approved evidence.
- `RETURN_INSPECTION -> AVAILABLE` requires inspection pass and optional new location.
- `LOST`, `DAMAGED`, and `ADMIN_HOLD` require reason and audit log.

### Deposit hold (added 2026-09-23)

A 50% deposit takes a garment off sale for seven days. It has its own inventory
state so the warehouse can tell it apart from a cart reservation that expires in
minutes. These names are the ones in the Prisma schema.

```text
AVAILABLE -> RESERVED -> DEPOSIT_HELD -> PAID
                           |
                           +-> AVAILABLE   (seven days lapsed, back on sale)
```

- `RESERVED -> DEPOSIT_HELD` happens only when a `DEPOSIT` payment is confirmed.
- `DEPOSIT_HELD` occupies a shelf and counts against warehouse capacity. It is
  never sellable, online or over the counter.
- `DEPOSIT_HELD -> PAID` happens only when the `BALANCE` payment is confirmed.
  This is the same settlement path a pay-in-full order takes, so a deposit order
  and a full order reach picking in exactly the same shape.
- `DEPOSIT_HELD -> AVAILABLE` happens when `Order.balanceDueAt` passes without
  the balance. The release and the refund request are one transaction, so the
  garment is never both off sale and unaccounted for.
- Every transition writes an `InventoryMovement` with its reason.

## Reservation State

Reservation is the short-lived lock created when a customer starts payment.

```text
ACTIVE
  -> PAID
  -> EXPIRED
  -> CANCELLED
  -> RELEASED_BY_ADMIN
```

### Reservation Rules

- Reservation is created when M-Pesa payment is initiated.
- Reservation expires after 15 minutes unless payment is confirmed.
- If M-Pesa callback arrives near expiry, payment handler must verify reservation and payment idempotently.
- Expired reservation releases inventory to `AVAILABLE`.
- Paid reservation moves inventory to `PAID`.
- Duplicate payment callback must not create another reservation or order item.

## Order State

Order state describes the customer order lifecycle.

```text
CREATED
  -> PAYMENT_PENDING
  -> PAID
  -> PICKING
  -> READY_FOR_PICKUP
  -> OUT_FOR_DELIVERY
  -> DELIVERED
  -> COMPLETED

Side paths:
PAYMENT_PENDING -> CANCELLED
PAID -> CANCEL_REQUESTED
PAID -> CANCELLED_BY_PLATFORM
Any active state -> EXCEPTION
DELIVERED -> RETURN_REQUESTED
RETURN_REQUESTED -> RETURN_APPROVED
RETURN_APPROVED -> RETURN_RECEIVED
RETURN_RECEIVED -> REFUNDED
```

### Order State Definitions

| State | Meaning |
| --- | --- |
| `CREATED` | Order shell exists before payment initiation. |
| `PAYMENT_PENDING` | Payment initiated and inventory reserved. |
| `PAID` | Payment confirmed. |
| `PICKING` | Warehouse is picking the order. |
| `READY_FOR_PICKUP` | Order is packed and ready for customer pickup. |
| `OUT_FOR_DELIVERY` | Order is with delivery process. |
| `DELIVERED` | Customer received order or pickup was completed. |
| `COMPLETED` | Delivery plus post-delivery waiting window is complete. |
| `CANCEL_REQUESTED` | Customer requested cancellation after payment. |
| `CANCELLED` | Unpaid order canceled or expired. |
| `CANCELLED_BY_PLATFORM` | Platform canceled due to missing item or exception. |
| `EXCEPTION` | Requires manual review. |
| `RETURN_REQUESTED` | Customer submitted return request. |
| `RETURN_APPROVED` | Return accepted under policy. |
| `RETURN_RECEIVED` | Returned barcode was received. |
| `REFUNDED` | Refund was executed. |

### Order Transition Rules

- Order amount is captured as a price snapshot.
- Order item prices do not change after order creation.
- Delivery fee snapshot is captured at checkout.
- `PAYMENT_PENDING -> CANCELLED` happens when reservation expires before payment.
- `PAID -> PICKING` can be automatic.
- `DELIVERED -> COMPLETED` happens after the return request window passes and no valid return is open.
- Return request must be within 24 hours after delivery.
- Platform-canceled paid orders require refund flow.
- `PENDING_PAYMENT -> DEPOSIT_PAID` on a confirmed deposit. The order carries
  `depositKsh`, `balanceKsh` and `balanceDueAt` from that moment. No picking
  task and no commission are created — only the balance does that.
- `DEPOSIT_PAID -> PAID` on a confirmed balance.
- `DEPOSIT_PAID -> DEPOSIT_EXPIRED` when the hold lapses. This is kept separate
  from `CANCELLED` because money is still open: 30% of the order total is owed
  back to the shopper as a `LAPSED_DEPOSIT` refund request.
- A balance prompt does **not** move the order to `PAYMENT_PROCESSING`. The
  seven-day hold is what the expiry sweep watches, and an unanswered prompt must
  not pause that clock.

### Who may work a task (added 2026-09-24)

Ownership is decided by `canWorkWarehouseTask` in
`apps/api/src/operations/operations-fulfillment-state.ts`, which both gates use.

| | Unassigned task | Assigned to me | Assigned to someone else |
| --- | --- | --- | --- |
| Picking (`orders.pick`) | allowed — the scan claims it | allowed | refused |
| Packing (`orders.pack`) | **refused** | allowed | refused |
| Either, with the matching assign permission | allowed | allowed | allowed |

- `scanItem` claims an unclaimed order for the scanner before verifying the
  barcode, so picking needs no separate claim call.
- Completing the picking assigns the parcel to the picker. Packing is assigned
  work, but assigned to nobody would stop a one-person warehouse dead: they would
  pick a trolley and be told to ask a supervisor who is themselves. A supervisor
  can still hand it to someone else before packing starts.
- `startPacking` and `completePacking` check the status first and ownership
  second, both before any lock is taken. A parcel that is not ready to pack is
  not ready for anyone, so answering "not assigned to you" would send a packer
  to find a supervisor who can do nothing for them.
- An admin account with no linked employee has a null actor id and is treated as
  "someone else" rather than matching a null assignment.

## Payment State

Payment state describes money movement and M-Pesa callback handling.

```text
INITIATED
  -> CUSTOMER_PROMPTED
  -> SUCCESS
  -> FAILED
  -> TIMEOUT
  -> MANUAL_REVIEW
  -> REFUND_PENDING
  -> REFUNDED
```

### Payment Rules

- Payment records are separate from orders.
- Each M-Pesa request has an idempotency key.
- M-Pesa callback transaction id must be unique.
- Duplicate callback returns success to M-Pesa but does not repeat state changes.
- Every payment records its leg: `FULL`, `DEPOSIT` or `BALANCE`.
- Payment amount must match the amount that leg is due — the order total for
  `FULL`, `Order.depositKsh` for `DEPOSIT`, `Order.balanceKsh` for `BALANCE`.
- Amount mismatch goes to `MANUAL_REVIEW`.
- A `BALANCE` callback is checked against the deposit hold window and
  `DEPOSIT_HELD` inventory, not against the five-minute cart reservation.
- Delayed callback after reservation expiry goes to `MANUAL_REVIEW` unless order can be safely paid.
- Refund execution requires restricted permission.
- Refund record must link to original payment.

## Fulfillment State

`OrderFulfillment.status` is the single operational order state machine used by
Operations. `Order.status` remains the high-level payment/completion envelope;
the Order Center must not introduce a second picking or delivery state machine.

```text
PAID
  -> PICKING
  -> READY_TO_PACK
  -> PACKED

Via a store node:
PACKED -> IN_TRANSIT_TO_NODE -> ARRIVED_AT_NODE

Pickup:
ARRIVED_AT_NODE -> READY_FOR_PICKUP -> COMPLETED
(PACKED -> READY_FOR_PICKUP when the handover is at the warehouse itself)

Delivery:
ARRIVED_AT_NODE -> READY_FOR_DISPATCH -> OUT_FOR_DELIVERY -> COMPLETED

Failed delivery:
OUT_FOR_DELIVERY -> DELIVERY_FAILED -> RETURNING_TO_NODE -> ARRIVED_AT_NODE
(and from there out again, with a new code)

Any non-completed active state -> EXCEPTION
```

### Fulfillment Rules

- A successful payment creates exactly one `OrderFulfillment` and one
  `FulfillmentItem` per order item.
- Picking is claimed or assigned at order level. Every item retains its barcode
  and warehouse location in the same order detail.
- A wrong barcode records a rejected scan event and cannot verify the item.
- The order reaches `READY_TO_PACK` only when every `FulfillmentItem` is
  `VERIFIED`.
- Packing records the start employee, completion employee, method, parcel count,
  note, and timestamps before moving to `PACKED`.
- Pickup and delivery paths are mutually exclusive.
- **No code, no completion.** Both `READY_FOR_PICKUP -> COMPLETED` and
  `OUT_FOR_DELIVERY -> COMPLETED` require a verified customer code. The state
  machine refuses the transition without one, so no route into `COMPLETED`
  bypasses it. Knowing the customer, a WhatsApp message saying the goods arrived,
  or a rider's word are not substitutes.
- Delivery requires a rider on the order before dispatch. Each assignment records
  the assigning admin, rider, assignment time, estimated delivery time, and note.
- Picker, packer, dispatch confirmer, rider, pickup confirmer, and after-sale owner
  are separate relations.
- Every action writes a `FulfillmentEvent` with old/new state, admin actor,
  related employee or rider, note, and timestamp. Transition events use an
  idempotency key so repeated clicks do not append duplicates.
- Exceptions record warehouse facts only. Refund decisions remain an after-sale
  responsibility.
- A failed delivery never cancels the order. The customer has paid, so the
  package returns to its node and waits for another attempt.

### Customer Codes

- The delivery code is four digits, generated **at dispatch** and never before.
  It is stored only as a salted pbkdf2 hash, so no API response, operations
  screen, event or log can show it. The plaintext exists inside the dispatch
  transaction and in the customer's SMS, and nowhere else.
- Five wrong codes lock the order. A locked order refuses even the correct code.
- A code is one-time: it is dead once the order completes, once the delivery
  fails, and once a replacement is issued.
- "Resend" issues a **new** code and voids the old one, because the old one
  cannot be read back. Customer service can therefore trigger a resend without
  ever being able to see a code.
- Every check, right or wrong, writes a `CustomerCodeAttempt` row with the order,
  the rider, the attempt number and the time. The digits that were typed are
  never recorded.
- Authorized drop-off (left with security, at reception, at the door) needs a
  photo **and** a valid code. The customer reading out their code over the phone
  is what makes the drop-off the customer's decision rather than the rider's.
- Pickup uses the same rule against `Order.pickupCode`. The order number and the
  customer's phone number are no longer proof on their own, because both are
  printed on the package sitting on the counter.

### Responsibility

`OrderFulfillment.currentHolderType` and `currentHolderId` record who physically
holds the package, so "where is this order and who is responsible for it" is one
read rather than a replay of the event log.

| Status | Holder |
| --- | --- |
| `PAID`, `PICKING`, `READY_TO_PACK`, `PACKED` | `WAREHOUSE` |
| `IN_TRANSIT_TO_NODE`, `RETURNING_TO_NODE` | `IN_TRANSIT` |
| `ARRIVED_AT_NODE`, `READY_FOR_PICKUP`, `READY_FOR_DISPATCH` | `NODE` |
| `OUT_FOR_DELIVERY`, `DELIVERY_FAILED` | `RIDER` |
| `COMPLETED` | `CUSTOMER` |

## Return State

Return state handles customer return requests and reverse inventory.

```text
REQUESTED
  -> REJECTED
  -> APPROVED
  -> RECEIVED
  -> INSPECTING
  -> ACCEPTED
  -> REFUND_PENDING
  -> REFUNDED

or

INSPECTING
  -> REJECTED_AFTER_INSPECTION
```

### Return Rules

- Return request must be submitted within 24 hours after delivery.
- Eligible reasons:
  - wrong item delivered
  - item materially different from photos
  - major undisclosed defect
  - key measurement differs by more than 3 cm
  - serious delivery damage
- Customer preference or size misunderstanding is not automatically eligible.
- Returned item must have matching barcode.
- Returned item cannot go directly to `AVAILABLE`; it must pass inspection.
- Accepted return revokes related commission.

## Commission State

Commission state describes affiliate earning lifecycle.

```text
ESTIMATED
  -> DELIVERY_WAITING
  -> CONFIRMED
  -> PAYABLE
  -> IN_SETTLEMENT_BATCH
  -> PAID

Side paths:
ESTIMATED -> VOIDED
DELIVERY_WAITING -> VOIDED
CONFIRMED -> REVERSED
PAYABLE -> REVERSED
```

### Commission Rules

- Commission is single-level in MVP.
- Commission is estimated after payment.
- Commission is not confirmed until 72 hours after delivery (2026-10-14; was 24 hours) and no valid return request exists.
- Refunded item revokes or reverses the related commission.
- Commission batch is paid weekly.
- Commission payment and commission calculation require separate permissions.
- Manual commission adjustment requires reason and audit log.

## Affiliate Attribution State

Attribution state records referral source, not payment eligibility.

```text
CAPTURED
  -> USED_ON_ORDER
  -> EXPIRED
  -> OVERRIDDEN_BY_NEW_VALID_SOURCE
  -> VOIDED
```

### Attribution Rules

- Last valid referral source wins.
- Attribution expires after 7 days.
- Attribution may be captured by referral code, link parameter, QR code, or checkout code.
- Admin edit is exceptional and requires permission, reason, and audit.
- Attribution does not guarantee commission if order is canceled, refunded, or returned.

## Required Audit Events

Audit is required for:

- Barcode assignment.
- Product review approval or rejection.
- Manual change to measurements, condition, price, or category.
- Inventory check-in, movement, count difference, missing, damaged, hold.
- Reservation creation, expiry, release, and paid conversion.
- Manual order cancellation.
- Payment manual review and refund.
- Picking and packing scan mismatch.
- Return approval, rejection, inspection, refund.
- Affiliate attribution manual edit.
- Commission confirmation, reversal, settlement, payment.
- Role and permission changes.

## Development Rule

Any change to these states requires a documented change request before
implementation. The change request must list affected modules, API changes,
database migration needs, test cases, and rollback plan.
