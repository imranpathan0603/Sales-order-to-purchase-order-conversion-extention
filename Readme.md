# Zoho Books Sales Order → Purchase Order Widget

## 1. Purpose

This widget is a custom Zoho Books tool used from a **Sales Order** to
create a **Purchase Order** while preventing the total purchased
quantity from exceeding the Sales Order quantity.

**Business rule:** The Sales Order is the master quantity. Related
Purchase Orders consume that quantity. The widget always calculates the
quantity still available for purchase.

The widget does **not** modify the original Sales Order.

------------------------------------------------------------------------

## 2. Simple Business Flow

``` text
Sales Order
    ↓
Open Purchase Order Widget
    ↓
Read Sales Order
    ↓
Find all related Purchase Orders
    ↓
Calculate already purchased quantity
    ↓
Calculate remaining quantity
    ↓
Select Vendor
    ↓
Review / edit Purchase Order
    ↓
Enter required quantity
    ↓
Refresh latest Sales Order + Purchase Orders
    ↓
Validate quantity
    ↓
Create Purchase Order
```

### Example

Sales Order:

  Item       SO Qty
  -------- --------
  Item A         10

Existing PO:

  PO         Qty
  -------- -----
  PO-001       6

The widget calculates:

``` text
SO Qty       = 10
Allocated    = 6
Available    = 10 - 6 = 4
```

The next PO can contain **4 or less**.

If another PO purchases 4:

``` text
10 - 6 - 4 = 0
```

The item becomes **Fully Purchased**.

------------------------------------------------------------------------

# 3. Main Business Rules

## 3.1 Sales Order Is the Master

The Sales Order quantity is the original allowed quantity.

The widget never increases or changes the Sales Order quantity.

## 3.2 All Related Purchase Orders Are Considered

The widget does not use only the latest PO. It fetches Purchase Orders
using pagination and considers every matching PO.

The current relationship is:

``` text
Purchase Order Reference Number
=
Sales Order Number
```

The match is exact, so `SO-1` does not match `SO-10`.

## 3.3 Purchase Order Statuses That Consume Quantity

The current configuration is:

``` js
const COUNTED_PO_STATUSES = [
    'draft',
    'open',
    'partially_received',
    'received',
    'billed'
];
```

Cancelled/void/deleted POs are not intended to consume allocation.

------------------------------------------------------------------------

# 4. Quantity Calculation

For every Sales Order item:

``` text
Remaining Quantity
=
Sales Order Quantity
-
Total Quantity Allocated in Related Purchase Orders
```

Example:

``` text
SO Qty       = 20
PO-001       = 5
PO-002       = 7
PO-003       = 3

Allocated    = 15
Remaining    = 20 - 15 = 5
```

The user can purchase up to 5.

------------------------------------------------------------------------

# 5. Over-Allocation

If existing POs already exceed the Sales Order quantity, the widget does
not silently hide the issue.

Example:

``` text
SO Qty       = 10
Allocated    = 12
Remaining    = -2
```

The item is shown as:

``` text
OVER-ALLOCATED
```

Additional purchasing should not be allowed for that item.

------------------------------------------------------------------------

# 6. Zero Remaining Quantity

Example:

``` text
SO Qty       = 10
Allocated    = 10
Remaining    = 0
```

The item is shown as:

``` text
Fully Purchased
```

No additional quantity should be allowed.

------------------------------------------------------------------------

# 7. Partial Purchase Is Allowed

If:

``` text
SO Qty       = 10
Allocated    = 6
Available    = 4
```

The user may create a PO for:

``` text
1, 2, 3 or 4
```

After creating 2:

``` text
10 - 6 - 2 = 2 remaining
```

The next widget opening should show 2 available.

------------------------------------------------------------------------

# 8. Main Technical Flow

``` text
init()
  ↓
loadOrganizationContext()
  ↓
loadAllocationData()
  ↓
fetchSalesOrder()
  ↓
normalizeSalesOrder()
  ↓
getAllPurchaseOrders()
  ↓
filterRelatedPurchaseOrders()
  ↓
calculateAllAllocations()
  ↓
renderHeader()
  ↓
renderItems()
```

------------------------------------------------------------------------

# 9. Function Reference

## `init()`

Main startup function.

Responsibilities:

-   Wire UI events
-   Initialize Zoho Books SDK
-   Resize the widget
-   Load organization/API context
-   Load Sales Order
-   Load Purchase Orders
-   Calculate allocation
-   Render UI
-   Set default dates
-   Load notes and terms
-   Register vendor events

## `loadOrganizationContext()`

Loads the organization/API context required before Books API requests.

Stores the organization ID and API endpoint in application state.

## `fetchSalesOrder()`

Reads the Sales Order from the current Books context:

``` js
ZFAPPS.get('salesorder')
```

If the widget is not opened from a valid Sales Order context, it throws
an error.

## `normalizeSalesOrder(so)`

Converts the raw Sales Order response into a consistent internal
structure.

It extracts:

-   Sales Order ID
-   Sales Order Number
-   Customer
-   Reference Number
-   Notes
-   Terms
-   Line item ID
-   Item ID
-   Description
-   Quantity
-   Rate
-   Tax
-   Discount
-   Unit
-   Warehouse

## `getAllPurchaseOrders()`

Fetches all Purchase Orders using pagination.

The current page size is:

``` js
PER_PAGE = 200
```

The function continues until the API reports that there are no more
pages.

This is important because the allocation must not be calculated from
only the first page of POs.

## `filterRelatedPurchaseOrders(allPOs, soNumber)`

Finds POs related to the current Sales Order.

It checks:

1.  Exact PO reference number = Sales Order number.
2.  PO status is in `COUNTED_PO_STATUSES`.

Every matching PO is included.

## `calculateAllAllocations(salesOrder, relatedPOs)`

This is the core quantity engine.

For each Sales Order line it determines:

``` text
Sales Order Quantity
Allocated Quantity
Remaining Quantity
Current PO Quantity
```

Conceptually:

``` text
SO Item
   ↓
Find matching PO item lines
   ↓
Sum PO quantities
   ↓
Compare against SO quantity
   ↓
Calculate remaining
```

## `renderHeader(salesOrder)`

Displays Sales Order information and initializes the Purchase Order
reference information.

## `renderItems(allocations)`

Creates the editable item table.

The table shows:

-   Item
-   Description
-   SO Qty
-   Allocated Qty
-   Available Qty
-   PO Qty
-   Rate
-   Discount
-   Tax

It also displays `Fully Purchased` and `OVER-ALLOCATED` states.

## `loadVendors()`

Loads vendor records for the vendor selector.

## `openVendorDropdown()`

Fetches and displays vendors when the Vendor field is opened/interacted
with.

## `selectVendor(vendor)`

Stores the selected vendor ID and displays the vendor name.

Vendor payment terms can also populate the Terms field when appropriate.

## `collectFormData()`

Reads the values entered by the user.

It collects:

-   Vendor
-   PO number
-   Date
-   Delivery date
-   Reference number
-   Items
-   Description
-   Quantity
-   Rate
-   Discount
-   Tax
-   Notes
-   Terms

## `validateBeforeCreate(formData, freshAllocations)`

Final business validation before creation.

Checks include:

-   Vendor selected
-   Valid quantities
-   Quantity does not exceed latest available quantity
-   Invalid/empty quantities
-   Over-allocation conditions

## `buildPurchaseOrderPayload(formData, salesOrderNumber)`

Converts the form into the Zoho Books Purchase Order API payload.

Typical fields include:

``` text
vendor_id
date
delivery_date
reference_number
line_items
notes
terms
```

Line items can contain:

``` text
item_id
name
description
quantity
rate
discount
tax_id
unit
salesorder_item_id
```

## `createPurchaseOrder(payload)`

Sends the final payload to Zoho Books.

It:

1.  Calls the PO API.
2.  Parses the response.
3.  Checks the API result.
4.  Extracts the created PO.
5.  Returns the PO ID, number, vendor and total.

## `handleCreatePurchaseOrder()`

Main controller for the Create Purchase Order button.

Flow:

``` text
Click Create
   ↓
Prevent duplicate click
   ↓
Disable button
   ↓
Collect form
   ↓
Check vendor
   ↓
Fetch latest Sales Order
   ↓
Fetch latest Purchase Orders
   ↓
Recalculate allocation
   ↓
Validate requested quantity
   ↓
Build payload
   ↓
Create PO
   ↓
Show success
```

------------------------------------------------------------------------

# 10. Why Final Re-Validation Is Required

The quantity shown when the widget opens can become outdated.

Example:

``` text
User A opens widget
Available = 10
```

Then User B creates a PO for 7.

Actual availability becomes:

``` text
10 - 7 = 3
```

User A's screen is now stale.

Before creating the PO, the widget refreshes:

``` text
Latest Sales Order
+
Latest Purchase Orders
```

and recalculates the allocation.

This prevents the widget from creating a PO using an old quantity.

------------------------------------------------------------------------

# 11. Duplicate Click Protection

The widget uses:

``` js
state.creatingPurchaseOrder
```

When creation starts:

``` text
Create button = disabled
```

If the user clicks again while creation is in progress, the second click
is ignored.

This protects against accidental duplicate Purchase Orders.

------------------------------------------------------------------------

# 12. Vendor Flow

``` text
Open Vendor field
      ↓
Fetch vendors
      ↓
Show vendor dropdown
      ↓
Search/filter
      ↓
Select vendor
      ↓
Store vendor ID
```

The widget also supports the vendor-saved event and can select the newly
saved vendor when its record ID is returned.

------------------------------------------------------------------------

# 13. Editable Purchase Order

The widget behaves like an editable Purchase Order editor.

Users can review/change fields such as:

-   Vendor
-   PO details
-   Date
-   Delivery date
-   Reference number
-   Item description
-   Purchase quantity
-   Rate
-   Discount
-   Tax
-   Notes
-   Terms

### Quantity restriction

If available quantity is 4:

``` text
Allowed:     1, 2, 3, 4
Not allowed: 5+
```

Other editable fields do not override the Sales Order quantity rule.

------------------------------------------------------------------------

# 14. Totals

The UI calculates:

``` text
Subtotal
Discount
Tax
Grand Total
```

Changing quantity, rate, discount or tax updates the displayed totals.

------------------------------------------------------------------------

# 15. Notes and Terms

Notes and Terms can be initialized from the Sales Order.

The user can edit them before creating the Purchase Order.

------------------------------------------------------------------------

# 16. Cancel / Close

The widget tracks unsaved changes using:

``` js
state.dirty
```

If changes exist, the user receives a confirmation before closing.

Options:

``` text
Cancel
Discard
```

------------------------------------------------------------------------

# 17. Success Flow

After successful creation:

``` text
PO Created
   ↓
Show PO Number
   ↓
Show Vendor
   ↓
Show Total
   ↓
Open Created PO OR Close Widget
```

The created PO ID is stored in:

``` js
state.createdPoId
```

------------------------------------------------------------------------

# 18. Error Handling

The widget provides:

-   Loading overlay
-   Error overlay
-   Retry action
-   API response validation
-   Console logging
-   User-friendly error messages

Typical loading messages:

``` text
Loading Sales Order...
Loading Purchase Orders...
Calculating available quantities...
Refreshing Sales Order and Purchase Orders...
Creating Purchase Order...
```

------------------------------------------------------------------------

# 19. Developer Debugging

Important log stages include:

``` text
[SALES_ORDER]
[PO_FETCH]
[VENDOR]
[VALIDATION]
[CREATE_PO]
[ERROR]
```

For a problem where the second PO still shows the original SO quantity,
check this chain first:

``` text
fetchSalesOrder()
      ↓
getAllPurchaseOrders()
      ↓
filterRelatedPurchaseOrders()
      ↓
calculateAllAllocations()
      ↓
renderItems()
```

The critical calculation is:

``` text
Remaining = SO Quantity - Allocated PO Quantity
```

------------------------------------------------------------------------

# 20. Data Relationship

``` text
Sales Order
│
├── Item A → Qty 10
├── Item B → Qty 20
└── Item C → Qty 5
        │
        ▼
Related Purchase Orders
│
├── PO-001 → Item A = 6
├── PO-002 → Item A = 2
└── PO-003 → Item B = 8
```

Result:

``` text
Item A: 10 - 6 - 2 = 2 remaining
Item B: 20 - 8     = 12 remaining
Item C: 5 - 0      = 5 remaining
```

------------------------------------------------------------------------

# 21. Testing Scenarios

## No existing PO

``` text
SO = 10
Allocated = 0
Available = 10
```

Expected: up to 10 can be purchased.

## One existing PO

``` text
SO = 10
PO = 6
Available = 4
```

Expected: new PO \<= 4.

## Multiple POs

``` text
SO = 10
PO-001 = 3
PO-002 = 2
PO-003 = 1
Allocated = 6
Available = 4
```

Expected: new PO \<= 4.

## Fully purchased

``` text
SO = 10
Allocated = 10
Available = 0
```

Expected: `Fully Purchased`.

## Over-allocated

``` text
SO = 10
Allocated = 12
Remaining = -2
```

Expected: `OVER-ALLOCATED`.

## Partial next PO

``` text
SO = 10
Existing = 6
New PO = 2
```

Expected next available:

``` text
2
```

## Double click

Expected: only one creation request.

## Concurrent update

``` text
Widget shows 10
Another user purchases 7
Actual available = 3
```

Expected: final validation detects the change and prevents a quantity
greater than 3.

------------------------------------------------------------------------

# 22. Important Developer Assumptions

The current implementation assumes:

1.  Sales Order number is used as the PO reference number.
2.  Related POs are identified by exact reference-number match.
3.  Item IDs are available on SO and PO lines.
4.  PO line quantities consume SO allocation.
5.  The configured PO statuses are the statuses that consume quantity.
6.  All relevant POs are fetched, including pagination pages.
7.  The Sales Order itself is never modified by the widget.

------------------------------------------------------------------------

# 23. Future Consideration: Duplicate Items

If the same item appears multiple times in one Sales Order, matching
only by `item_id` may not uniquely identify each Sales Order line.

A future enhancement could use the Sales Order line-item ID and a
corresponding PO line relationship for more precise allocation.

------------------------------------------------------------------------

# 24. High-Level Architecture

``` text
             ┌─────────────────────┐
             │   Sales Order       │
             └──────────┬──────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │ fetchSalesOrder()   │
             └──────────┬──────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │ getAllPurchaseOrders│
             └──────────┬──────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ filterRelatedPOs()   │
             └──────────┬───────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ calculateAllocation()│
             └──────────┬───────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ Purchase Order UI    │
             │ Vendor / Items / Qty  │
             │ Rate / Tax / Notes    │
             └──────────┬───────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ Final Live Validation│
             └──────────┬───────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ createPurchaseOrder()│
             └──────────┬───────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │ PO Created in Books │
             └─────────────────────┘
```

------------------------------------------------------------------------

# 25. Developer Quick Reference

  Area                   Function / Configuration
  ---------------------- ------------------------------------------
  Counted PO statuses    `COUNTED_PO_STATUSES`
  API page size          `PER_PAGE`
  Current SO             `fetchSalesOrder()`
  Normalize SO           `normalizeSalesOrder()`
  Fetch all POs          `getAllPurchaseOrders()`
  Match POs              `filterRelatedPurchaseOrders()`
  Calculate quantities   `calculateAllAllocations()`
  Render items           `renderItems()`
  Load vendors           `loadVendors()` / `openVendorDropdown()`
  Select vendor          `selectVendor()`
  Read form              `collectFormData()`
  Validate               `validateBeforeCreate()`
  Build payload          `buildPurchaseOrderPayload()`
  Create PO              `createPurchaseOrder()`
  Main create flow       `handleCreatePurchaseOrder()`
  Startup                `init()`
  Close/discard          `confirmDiscard()`
  Success screen         `showSuccessScreen()`

------------------------------------------------------------------------

# 26. One-Line Business Summary

**This widget converts a Sales Order into a Purchase Order while
continuously checking related Purchase Orders so the total purchased
quantity does not exceed the Sales Order quantity.**

------------------------------------------------------------------------

## Source

This README is based on the latest reviewed widget JavaScript source:

`Pasted code(20260924-055434).js`

The source contains the Sales Order loading, Purchase Order
pagination/filtering, allocation calculation, vendor handling,
validation, final live refresh, and Purchase Order creation flow
described in this document.
