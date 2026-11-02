# Customer Service

Customer service does not have its own chat system, and is not going to get
one. WhatsApp stays the channel customers talk to us on. What this module does
is everything around that conversation: find the customer, see the whole order
in one place, record what was done about it, and route what customer service
cannot finish itself to whoever can.

The goal is narrow and testable: **every customer problem can be traced to a
customer and an order, has a named owner, a deadline, a written record and a
final outcome — without Eric being in the loop for ordinary questions.**

## What customer service can and cannot do

This is the whole design. Customer service is a role with a lot of read access
and deliberately little write access.

| Can | Cannot |
| --- | --- |
| Search customers by phone, order number or name | See a pickup or delivery code |
| Open the Order 360 view | Force-complete a delivery or pickup |
| Resend a delivery code | Mark a payment as paid |
| Open a WhatsApp chat on the customer's own number | Move money without finance approval |
| Correct a phone number, WhatsApp number or delivery address | Change promoter attribution |
| Create, assign, prioritise and escalate a case | Change a commission |
| Add internal notes | Change a product price or touch stock |
| Request a return | |
| Request a refund | Approve or record one |

`apps/api/src/operations/operations-customer-service-access.spec.ts` asserts the
right-hand column against the role blueprints, so the boundary cannot be widened
by quietly adding a permission code to the role.

### Permissions

| Code | Held by | What it allows |
| --- | --- | --- |
| `action.customer-service.view` / `.create` / `.edit` | Customer service | Read, open and update cases |
| `customer-service.assign` | Customer service | Give a case an owner |
| `customer-service.escalate` | Customer service | Hand a case to fulfillment, finance or an admin |
| `customer-service.contact-update` | Customer service | Correct phone, WhatsApp and delivery address |
| `customer-service.refund-request` | Customer service | Ask finance to approve a refund |
| `customer-service.refund-approve` | **Finance only** | Approve or reject a refund request |
| `orders.refund` | **Finance only** | Record a refund already executed in M-Pesa |
| `orders.resend-code` | Customer service | Mint and text a replacement delivery code |

Finance deliberately does **not** hold `customer-service.refund-request`, and
customer service deliberately does **not** hold the two finance codes. A payout
always involves two people.

## Order 360

`GET /operations/customer-service/orders/:orderId/overview` returns, in one
payload: the customer, the order and its items, the payment with its M-Pesa
receipt number, the fulfillment status with the current node, rider and holder,
the promoter attribution, the open cases, the returns, the refund requests, and
a single merged timeline of payment, fulfillment and customer service events in
chronological order.

It exists so that an agent with a customer on the phone never has to ring the
warehouse, the store staff or the rider to answer "where is my order?".

**It never returns a pickup code, a delivery code, or the delivery code's
hash.** Four digits is ten thousand guesses, so a hash in a JSON response is the
code. The view is read-only; every write on the page goes through a separate
endpoint behind its own permission.

## Cases

A case has a specific **reason** (`caseType`), and the coarse queue
(`issueType`) is derived from it — never set by hand, so the two cannot drift
apart. The taxonomy and its routing live in
`packages/business-rules/src/customer-service.ts`.

| Group | Reasons |
| --- | --- |
| Payment | `PAYMENT_FAILED`, `PAID_BUT_ORDER_MISSING`, `DUPLICATE_PAYMENT`, `PAYMENT_PENDING`, `WRONG_AMOUNT` |
| Delivery | `ORDER_LATE`, `CUSTOMER_UNREACHABLE`, `WRONG_ADDRESS`, `RIDER_ISSUE`, `PACKAGE_MISSING`, `DELIVERY_CODE_NOT_RECEIVED` |
| Product | `WRONG_ITEM`, `DAMAGED_ITEM`, `MISSING_ITEM`, `SIZE_ISSUE`, `PRODUCT_NOT_AS_EXPECTED` |
| After-sales | `RETURN_REQUEST`, `EXCHANGE_REQUEST`, `REFUND_REQUEST` |
| Other | `OTHER` |

Status is only ever `OPEN → IN_PROGRESS → RESOLVED → CLOSED`. **Escalation is a
flag plus a destination, not a status** — an escalated case stays open and
customer service stays responsible for telling the customer what happened; it
has gained an extra owner, not a new state.

### SLA

Each priority carries a deadline, defaulting to URGENT 2h, HIGH 4h, NORMAL 12h,
LOW 24h. These are deliberately short: a customer who paid by M-Pesa and got
nothing does not wait a working day.

Operations can override them per priority without a deploy by setting the
`customer-service.sla-hours` key in `SystemSetting`, for example
`{"URGENT": 1, "HIGH": 3}`. Priorities the stored value does not mention keep
their default, and a malformed or hostile value falls back entirely rather than
producing a case with no real deadline.

A case is overdue only while it is `OPEN` or `IN_PROGRESS` — the dashboard
counts work outstanding, not history. Re-prioritising a case recomputes its
deadline from when the customer first raised it, not from now, so it cannot buy
back hours it has already burned.

## Refunds

Customer service **cannot refund anybody**. The flow is:

```
customer asks
  → customer service creates a RefundRequest      (PENDING_APPROVAL)
  → finance approves or rejects                   (APPROVED | REJECTED)
  → finance pays the customer in the M-Pesa portal, by hand
  → finance records the reference                 (REFUNDED)
```

`RefundRequest` is deliberately a separate model from `RefundRecord`. A
`RefundRecord` is evidence that money already moved; a `RefundRequest` is
permission for it to move at all. Keeping them apart means customer service can
never create the evidence, and finance can never pay out what nobody asked for.

Guardrails, all tested in `operations-refund-request.spec.ts`:

- The person who raised a request cannot approve it, even holding both permissions.
- A request cannot exceed what the customer actually paid, counting refunds
  already recorded **and** other requests still live — two agents cannot each
  promise the customer the full order value.
- A rejected or cancelled request releases the amount it was holding.
- Only an approved request can be recorded as refunded, and the recorded time
  cannot be before the approval or in the future.
- A request for a returned item is opened automatically when the warehouse
  accepts the item (with its photos). It cannot be recorded as refunded here:
  return refunds are recorded on the order page so the commission, the return
  status and the restock rules all follow. A manual request for a return is only
  possible once the item has been received, and not while another live one exists.
- The M-Pesa reference is unique; recording the same payout twice is refused.
- **Nothing in this system ever initiates an M-Pesa transfer.**

## Returns

The existing return state machine is unchanged:
`REQUESTED → APPROVED | REJECTED → RECEIVED → REFUND_RECORDED`, still inside the
24-hour post-delivery window. See `docs/architecture/state-machines.md`.

What is new is only where the item goes back to. A return request may name a
`returnNodeId`; that store then sees the item on its **returns to receive** list
on the node workbench, and checks the barcode when the customer walks in. A null
node means the central warehouse, which is where every return went before.

Exchange is **not implemented**. `EXCHANGE_REQUEST` exists as a case type so the
request can be recorded, owned and escalated, but there is no replacement
fulfillment linked to the original order yet.

## Audit

Every state-changing action writes an `AuditLog` row under module
`customer-service` with the actor, the timestamp, the before state, the after
state and a reason: case created, assigned, escalated and de-escalated, status
changed, customer contact changed, refund requested, approved, rejected,
cancelled and completed. Delivery code resends are recorded as
`RESEND_DELIVERY_CODE` fulfillment events with a send count, never the code.

## Screens

| Route | What it is |
| --- | --- |
| `/customer-service` | Dashboard counters plus the global search box |
| `/customer-service/cases` | The case queue, with filters, creation, assignment and escalation |
| `/customer-service/orders/[orderId]` | Order 360 |
| `/customer-service/refunds` | The refund approval queue, both sides of the desk |
| `/orders/node` | Gains the store's returns-to-receive list |

The case queue sorts unfinished cases first, then by nearest deadline, so
picking up the top row is always the right thing to do.
