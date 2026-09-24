# Zoho Books Sales Order → Purchase Order Widget

> **Purpose:** Convert a Zoho Books Sales Order into one or more Purchase Orders while ensuring that the total quantity purchased through related Purchase Orders never exceeds the original Sales Order quantity.

---

## 1. Overview

The **Sales Order → Purchase Order Widget** is a custom Zoho Books widget launched from a Sales Order.

The widget reads the Sales Order, finds all related Purchase Orders, calculates how much quantity has already been purchased, and determines how much quantity is still available for purchase.

The user can then:

- Select a Vendor
- Review Sales Order items
- Edit Purchase Order details
- Edit description, rate, tax, discount, etc.
- Enter a partial or full remaining quantity
- Validate the latest quantity before creation
- Create the Purchase Order

### Important Business Rule

**The Sales Order is the master quantity.**

The widget does **not** modify the original Sales Order.

```text
Sales Order Quantity
        -
Total Related Purchase Order Quantity
        =
Remaining Quantity Available for Purchase
```

---

# 2. Business Flow

```mermaid
flowchart TD

    A["📄 SALES ORDER<br/><b>Master Quantity</b>"]
    B["🧩 Open Purchase Order Widget"]
    C["🔍 Read Sales Order"]
    D["📦 Fetch All Related Purchase Orders"]
    E["🔗 Match Purchase Orders<br/>PO Reference = Sales Order Number"]
    F["📊 Calculate Already Purchased Quantity"]
    G["➗ Calculate Remaining Quantity"]
    H["👤 Select Vendor"]
    I["📝 Review / Edit Purchase Order"]
    J["🔢 Enter Required Quantity"]
    K["🔄 Refresh Latest Sales Order + Purchase Orders"]
    L{"Quantity Valid?"}
    M["❌ Reject Request<br/>Show Available Quantity"]
    N["🛒 Create Purchase Order"]
    O["✅ Purchase Order Created"]

    A --> B
    B --> C
    C --> D
    D --> E
    E --> F
    F --> G
    G --> H
    H --> I
    I --> J
    J --> K
    K --> L

    L -- "No" --> M
    M --> J

    L -- "Yes" --> N
    N --> O
```

---

# 3. Simple Explanation for Non-Technical Users

Suppose the Sales Order contains:

```text
Item A = 10 Qty
```

The first Purchase Order purchases:

```text
PO-001 = 6 Qty
```

The widget calculates:

```text
Sales Order Quantity = 10
Already Purchased    = 6
Remaining Quantity   = 4
```

Therefore, the next Purchase Order can purchase a maximum of:

```text
4 Qty
```

If another Purchase Order purchases 4:

```text
10 - 6 - 4 = 0
```

The item becomes:

```text
FULLY PURCHASED
```

No additional quantity can be purchased against that Sales Order item.

---

# 4. Complete Quantity Lifecycle

```mermaid
flowchart LR

    SO["📄 SALES ORDER<br/><b>Item A = 10</b>"]

    PO1["📦 PO-001<br/><b>Qty = 6</b>"]
    R1["Remaining<br/><b>10 - 6 = 4</b>"]

    PO2["📦 PO-002<br/><b>Qty = 2</b>"]
    R2["Remaining<br/><b>4 - 2 = 2</b>"]

    PO3["📦 PO-003<br/><b>Qty = 2</b>"]
    R3["Remaining<br/><b>2 - 2 = 0</b>"]

    COMPLETE["✅ FULLY PURCHASED"]

    SO --> PO1
    PO1 --> R1
    R1 --> PO2
    PO2 --> R2
    R2 --> PO3
    PO3 --> R3
    R3 --> COMPLETE
```

---

# 5. Core Quantity Formula

For every Sales Order item:

```text
Remaining Quantity
=
Sales Order Quantity
-
Total Allocated Purchase Order Quantity
```

### Example

```text
Sales Order Quantity = 20

PO-001 = 5
PO-002 = 7
PO-003 = 3

Total Allocated = 5 + 7 + 3
                = 15

Remaining = 20 - 15
          = 5
```

Therefore:

```text
Maximum quantity for next PO = 5
```

---

# 6. Main Business Rules

## 6.1 Sales Order Is the Master

The Sales Order contains the original required quantity.

The widget:

- Reads the Sales Order
- Uses its quantity as the maximum allowed quantity
- Never increases the Sales Order quantity
- Never changes the original Sales Order

---

## 6.2 Related Purchase Orders

Purchase Orders are related to the Sales Order using:

```text
Purchase Order Reference Number
=
Sales Order Number
```

The comparison must be exact.

Example:

```text
Sales Order = SO-001
```

Matches:

```text
PO Reference = SO-001
```

Does not match:

```text
SO-0010
SO-01
SO-001-A
```

---

# 7. Purchase Order Status Allocation

The widget counts quantities from Purchase Orders with the configured statuses:

```javascript
const COUNTED_PO_STATUSES = [
    'draft',
    'open',
    'partially_received',
    'received',
    'billed'
];
```

These statuses consume Sales Order allocation.

```mermaid
flowchart TD

    PO["📦 Purchase Order"]
    STATUS{"PO Status"}

    DRAFT["Draft"]
    OPEN["Open"]
    PARTIAL["Partially Received"]
    RECEIVED["Received"]
    BILLED["Billed"]

    CANCELLED["Cancelled / Void / Deleted"]

    COUNT["✅ Count PO Quantity<br/>towards allocation"]
    IGNORE["❌ Do Not Count"]

    PO --> STATUS

    STATUS --> DRAFT
    STATUS --> OPEN
    STATUS --> PARTIAL
    STATUS --> RECEIVED
    STATUS --> BILLED
    STATUS --> CANCELLED

    DRAFT --> COUNT
    OPEN --> COUNT
    PARTIAL --> COUNT
    RECEIVED --> COUNT
    BILLED --> COUNT

    CANCELLED --> IGNORE
```

> The exact status behavior is controlled by `COUNTED_PO_STATUSES` in the implementation.

---

# 8. Zero Remaining Quantity

Example:

```text
Sales Order = 10
Allocated   = 10
Remaining   = 0
```

The widget should display:

```text
FULLY PURCHASED
```

The user should not be able to add more quantity for that item.

---

# 9. Partial Purchase

Partial purchasing is supported.

Example:

```text
Sales Order = 10
Allocated   = 6
Remaining   = 4
```

The user can create:

```text
1
2
3
4
```

But cannot create:

```text
5+
```

If the user creates:

```text
PO Qty = 2
```

The next remaining quantity becomes:

```text
10 - 6 - 2 = 2
```

---

# 10. Over-Allocation

The widget must not silently hide an over-allocation problem.

Example:

```text
Sales Order = 10
Allocated   = 12
Remaining   = -2
```

The item should be identified as:

```text
⚠ OVER-ALLOCATED
```

Additional purchasing should be blocked for that item.

---

# 11. Main Business Logic Diagram

```mermaid
flowchart TD

    SO["📄 SALES ORDER<br/><b>Original Quantity = 100</b>"]

    PO1["📦 Purchase Order 1<br/><b>Purchased = 40</b>"]
    PO2["📦 Purchase Order 2<br/><b>Purchased = 25</b>"]

    ALLOCATED["📊 TOTAL PURCHASED<br/><b>40 + 25 = 65</b>"]

    REMAINING["🧮 REMAINING QUANTITY<br/><b>100 - 65 = 35</b>"]

    NEWPO["🛒 NEW PURCHASE ORDER<br/><b>Maximum Quantity = 35</b>"]

    VALIDATE{"Quantity ≤ 35?"}

    CREATE["✅ CREATE PURCHASE ORDER"]
    REJECT["❌ REJECT<br/>Quantity exceeds available amount"]

    SO --> PO1
    SO --> PO2

    PO1 --> ALLOCATED
    PO2 --> ALLOCATED

    SO --> REMAINING
    ALLOCATED --> REMAINING

    REMAINING --> NEWPO
    NEWPO --> VALIDATE

    VALIDATE -- "YES" --> CREATE
    VALIDATE -- "NO" --> REJECT
```

---

# 12. User Journey

```mermaid
journey
    title Sales Order to Purchase Order Journey

    section Sales Order
      Open Sales Order: 5: User
      Click Purchase Order Widget: 5: User

    section Quantity Calculation
      Widget reads Sales Order: 5: Widget
      Widget finds existing Purchase Orders: 5: Widget
      Widget calculates purchased quantity: 5: Widget
      Widget calculates remaining quantity: 5: Widget

    section Purchase Order
      Select Vendor: 5: User
      Review items: 5: User
      Edit description and rate: 4: User
      Edit tax and discount: 4: User
      Enter required quantity: 5: User

    section Final Validation
      Refresh latest data: 5: Widget
      Validate available quantity: 5: Widget

    section Completion
      Create Purchase Order: 5: User
      Purchase Order created: 5: Widget
```

---

# 13. High-Level System Architecture

```mermaid
flowchart TD

    subgraph BOOKS["☁️ ZOHO BOOKS"]
        SO["Sales Order"]
        PO["Purchase Orders"]
        VENDORS["Vendor Master"]
    end

    subgraph WIDGET["🧩 SALES ORDER → PURCHASE ORDER WIDGET"]

        INIT["init()"]

        CONTEXT["loadOrganizationContext()"]

        FETCH_SO["fetchSalesOrder()"]

        NORMALIZE["normalizeSalesOrder()"]

        FETCH_PO["getAllPurchaseOrders()"]

        FILTER["filterRelatedPurchaseOrders()"]

        ALLOCATION["calculateAllAllocations()"]

        HEADER["renderHeader()"]

        ITEMS["renderItems()"]

        VENDOR["loadVendors()<br/>selectVendor()"]

        FORM["collectFormData()"]

        VALIDATE["validateBeforeCreate()"]

        PAYLOAD["buildPurchaseOrderPayload()"]

        CREATE["createPurchaseOrder()"]

        SUCCESS["showSuccessScreen()"]
    end

    INIT --> CONTEXT

    CONTEXT --> FETCH_SO
    CONTEXT --> FETCH_PO

    SO --> FETCH_SO
    PO --> FETCH_PO
    VENDORS --> VENDOR

    FETCH_SO --> NORMALIZE
    FETCH_PO --> FILTER

    NORMALIZE --> FILTER
    FILTER --> ALLOCATION

    ALLOCATION --> HEADER
    ALLOCATION --> ITEMS

    HEADER --> FORM
    ITEMS --> FORM
    VENDOR --> FORM

    FORM --> VALIDATE
    VALIDATE --> PAYLOAD
    PAYLOAD --> CREATE
    CREATE --> SUCCESS

    CREATE --> PO
```

---

# 14. Main Technical Flow

```mermaid
flowchart TD

    INIT["init()"]

    ORG["loadOrganizationContext()"]

    LOAD["loadAllocationData()"]

    SO["fetchSalesOrder()"]

    NORMALIZE["normalizeSalesOrder()"]

    PO["getAllPurchaseOrders()"]

    FILTER["filterRelatedPurchaseOrders()"]

    ALLOCATION["calculateAllAllocations()"]

    HEADER["renderHeader()"]

    ITEMS["renderItems()"]

    INIT --> ORG
    ORG --> LOAD

    LOAD --> SO
    SO --> NORMALIZE

    LOAD --> PO

    NORMALIZE --> FILTER
    PO --> FILTER

    FILTER --> ALLOCATION

    ALLOCATION --> HEADER
    ALLOCATION --> ITEMS
```

---

# 15. Function Reference

## `init()`

Main startup function.

Responsibilities:

- Initialize Zoho Books SDK
- Wire UI events
- Resize widget
- Load organization context
- Load Sales Order
- Load Purchase Orders
- Calculate allocations
- Render the UI
- Set default dates
- Load notes and terms
- Register vendor events

---

## `loadOrganizationContext()`

Loads the organization/API context required for Books API operations.

Stores the required organization information in application state.

---

## `fetchSalesOrder()`

Reads the Sales Order from the current Zoho Books context.

```javascript
ZFAPPS.get('salesorder')
```

The widget must be opened from a valid Sales Order context.

---

## `normalizeSalesOrder(so)`

Converts the Sales Order response into a consistent internal structure.

Typical information includes:

- Sales Order ID
- Sales Order Number
- Customer
- Reference Number
- Notes
- Terms
- Line Item ID
- Item ID
- Description
- Quantity
- Rate
- Tax
- Discount
- Unit
- Warehouse

---

## `getAllPurchaseOrders()`

Fetches Purchase Orders using pagination.

The implementation uses a page size such as:

```javascript
PER_PAGE = 200;
```

The function continues fetching until all relevant pages have been processed.

### Why this is important

The widget must not calculate allocation using only the first 200 Purchase Orders.

---

## `filterRelatedPurchaseOrders(allPOs, soNumber)`

Filters the Purchase Orders and keeps only those related to the current Sales Order.

Checks:

```text
PO Reference Number
        =
Sales Order Number
```

and:

```text
PO Status
        ∈
COUNTED_PO_STATUSES
```

---

## `calculateAllAllocations(salesOrder, relatedPOs)`

This is the core quantity calculation engine.

For each Sales Order item:

```text
Sales Order Quantity
        ↓
Find matching PO Item Lines
        ↓
Sum PO Quantities
        ↓
Allocated Quantity
        ↓
Calculate Remaining Quantity
```

Conceptually:

```text
Remaining
=
SO Quantity
-
Allocated PO Quantity
```

---

## `renderHeader(salesOrder)`

Displays Sales Order information and Purchase Order header information.

---

## `renderItems(allocations)`

Creates the editable item table.

Typical columns:

```text
Item
Description
SO Qty
Allocated Qty
Available Qty
PO Qty
Rate
Discount
Tax
Amount
```

The UI can also display:

```text
FULLY PURCHASED
OVER-ALLOCATED
```

---

## `loadVendors()`

Loads the Vendor Master records used by the Vendor selector.

---

## `openVendorDropdown()`

Displays the Vendor selection interface and allows vendor searching/filtering.

---

## `selectVendor(vendor)`

Stores the selected Vendor ID and displays the Vendor information in the Purchase Order form.

---

## `collectFormData()`

Collects user-entered Purchase Order information.

Typical data:

```text
Vendor
PO Number
Date
Delivery Date
Reference Number
Items
Description
Quantity
Rate
Discount
Tax
Notes
Terms
```

---

## `validateBeforeCreate(formData, freshAllocations)`

Performs the final business validation.

Checks include:

- Vendor selected
- Valid quantities
- Requested quantity is not greater than remaining quantity
- No invalid quantities
- No over-allocation
- Required fields are present

---

## `buildPurchaseOrderPayload(formData, salesOrderNumber)`

Builds the payload required to create the Purchase Order.

Typical header fields:

```text
vendor_id
date
delivery_date
reference_number
line_items
notes
terms
```

Typical line-item fields:

```text
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

---

## `createPurchaseOrder(payload)`

Sends the final Purchase Order request to Zoho Books.

Flow:

```text
Build Payload
      ↓
Send API Request
      ↓
Read Response
      ↓
Validate Response
      ↓
Get Created PO
```

---

## `handleCreatePurchaseOrder()`

Main controller for the Create Purchase Order button.

```mermaid
flowchart TD

    A["Click Create PO"]
    B["Disable Create Button"]
    C["Collect Form Data"]
    D["Validate Vendor"]
    E["Fetch Latest Sales Order"]
    F["Fetch Latest Purchase Orders"]
    G["Recalculate Allocation"]
    H["Validate Requested Quantity"]
    I["Build PO Payload"]
    J["Create Purchase Order"]
    K["Show Success"]

    A --> B
    B --> C
    C --> D
    D --> E
    E --> F
    F --> G
    G --> H
    H --> I
    I --> J
    J --> K
```

---

# 16. Final Re-Validation

Final validation is one of the most important protections in the widget.

The quantity shown when the widget opens can become outdated.

### Example

User A opens the widget:

```text
Available = 10
```

Then User B creates another Purchase Order:

```text
User B purchases = 7
```

Actual remaining quantity is now:

```text
10 - 7 = 3
```

User A's screen still shows:

```text
10
```

Therefore, before creating the Purchase Order, the widget fetches the latest data again.

```mermaid
sequenceDiagram

    actor UserA
    actor UserB
    participant Widget
    participant Books

    UserA->>Widget: Open Widget
    Widget->>Books: Fetch SO + POs
    Books-->>Widget: Available = 10
    Widget-->>UserA: Show Available = 10

    UserB->>Books: Create PO for 7
    Books-->>UserB: PO Created

    UserA->>Widget: Click Create PO

    Widget->>Books: Fetch Latest SO
    Books-->>Widget: Latest SO

    Widget->>Books: Fetch Latest POs
    Books-->>Widget: Includes User B's PO

    Widget->>Widget: Recalculate
    Note over Widget: Remaining = 10 - 7 = 3

    alt User requested <= 3
        Widget->>Books: Create PO
        Books-->>Widget: PO Created
    else User requested > 3
        Widget-->>UserA: Reject - only 3 available
    end
```

---

# 17. Duplicate Click Protection

The widget uses a state such as:

```javascript
state.creatingPurchaseOrder
```

When creation begins:

```text
Create Button
      ↓
DISABLED
```

If the user clicks again:

```text
Second Click
      ↓
Ignored
```

This prevents accidental duplicate Purchase Orders.

```mermaid
flowchart TD

    A["User clicks Create PO"]
    B{"Creation already in progress?"}

    C["Ignore second click"]
    D["Set creatingPurchaseOrder = true"]
    E["Disable Create Button"]
    F["Validate + Create PO"]
    G["Creation Complete"]
    H["Re-enable UI"]

    A --> B

    B -- "YES" --> C
    B -- "NO" --> D

    D --> E
    E --> F
    F --> G
    G --> H
```

---

# 18. Vendor Flow

```mermaid
flowchart LR

    A["Open Vendor Field"]
    B["Fetch Vendors"]
    C["Display Vendor List"]
    D["Search / Filter"]
    E["Select Vendor"]
    F["Store Vendor ID"]
    G["Display Selected Vendor"]

    A --> B
    B --> C
    C --> D
    D --> E
    E --> F
    F --> G
```

---

# 19. Editable Purchase Order

The widget provides an editable Purchase Order experience.

Users can review/change fields such as:

```text
Vendor
PO Details
Date
Delivery Date
Reference Number
Item Description
Purchase Quantity
Rate
Discount
Tax
Notes
Terms
```

### Quantity restriction

If:

```text
Available = 4
```

Then:

```text
Allowed:
1
2
3
4

Not Allowed:
5+
```

Other editable fields do not override the Sales Order quantity rule.

---

# 20. Purchase Order UI Flow

```mermaid
flowchart TD

    HEADER["Purchase Order Header"]

    VENDOR["Vendor Selection"]
    DETAILS["PO Details"]
    ITEMS["Item Table"]
    TOTALS["Subtotal / Discount / Tax / Grand Total"]
    NOTES["Notes / Terms"]
    ACTIONS["Cancel / Save / Create PO"]

    HEADER --> VENDOR
    HEADER --> DETAILS
    VENDOR --> ITEMS
    DETAILS --> ITEMS
    ITEMS --> TOTALS
    TOTALS --> NOTES
    NOTES --> ACTIONS
```

---

# 21. Totals

The widget calculates Purchase Order totals.

```text
Line Amount
    ↓
Subtotal
    ↓
Discount
    ↓
Tax
    ↓
Grand Total
```

Changing:

- Quantity
- Rate
- Discount
- Tax

updates the displayed totals.

---

# 22. Notes and Terms

Notes and Terms may be initialized from the Sales Order.

The user can review and edit them before creating the Purchase Order.

---

# 23. Cancel / Close

The widget tracks whether the user has made changes.

Example state:

```javascript
state.dirty
```

If unsaved changes exist, the user should receive a confirmation before closing.

```text
You have unsaved changes.

[Cancel] [Discard]
```

---

# 24. Success Flow

After successful Purchase Order creation:

```mermaid
flowchart TD

    CREATE["Create Purchase Order"]
    API["Zoho Books API"]
    SUCCESS["Purchase Order Created"]
    NUMBER["Display PO Number"]
    VENDOR["Display Vendor"]
    TOTAL["Display Total"]
    ACTION["Open Created PO / Close Widget"]

    CREATE --> API
    API --> SUCCESS

    SUCCESS --> NUMBER
    SUCCESS --> VENDOR
    SUCCESS --> TOTAL

    NUMBER --> ACTION
    VENDOR --> ACTION
    TOTAL --> ACTION
```

The created Purchase Order ID is stored in:

```javascript
state.createdPoId
```

---

# 25. Error Handling

The widget should provide:

- Loading overlay
- Error messages
- Retry action
- API response validation
- Console logging
- User-friendly error messages

Typical loading states:

```text
Loading Sales Order...
Loading Purchase Orders...
Calculating available quantities...
Refreshing Sales Order and Purchase Orders...
Creating Purchase Order...
```

---

# 26. Developer Debugging

Important log categories:

```text
[SALES_ORDER]
[PO_FETCH]
[VENDOR]
[ALLOCATION]
[VALIDATION]
[CREATE_PO]
[ERROR]
```

If the second Purchase Order still shows the original Sales Order quantity, check this chain:

```mermaid
flowchart LR

    A["fetchSalesOrder()"]
    B["getAllPurchaseOrders()"]
    C["filterRelatedPurchaseOrders()"]
    D["calculateAllAllocations()"]
    E["renderItems()"]

    A --> B
    B --> C
    C --> D
    D --> E
```

### Critical calculation

```text
Remaining
=
Sales Order Quantity
-
Allocated Purchase Order Quantity
```

---

# 27. Allocation Debugging Checklist

When remaining quantity is incorrect, verify the following in order:

### 1. Sales Order was fetched

```text
SO Number
SO ID
SO Line Items
SO Quantity
```

### 2. All Purchase Orders were fetched

Check pagination.

```text
Page 1
Page 2
Page 3
...
```

### 3. PO Reference Number matches

```text
PO.reference_number
        =
SalesOrder.salesorder_number
```

### 4. PO Status is counted

```text
COUNTED_PO_STATUSES
```

### 5. Item ID matches

```text
SO item_id
        =
PO item_id
```

### 6. PO quantity is added

```text
allocatedQty += poItem.quantity
```

### 7. Remaining is calculated

```text
remainingQty =
salesOrderQty - allocatedQty
```

### 8. UI uses remaining quantity

The UI must not overwrite the calculated remaining quantity with the original Sales Order quantity.

---

# 28. Data Relationship

```mermaid
flowchart TD

    SO["📄 SALES ORDER"]

    A["Item A<br/>Qty 10"]
    B["Item B<br/>Qty 20"]
    C["Item C<br/>Qty 5"]

    SO --> A
    SO --> B
    SO --> C

    PO["📦 RELATED PURCHASE ORDERS"]

    P1["PO-001<br/>Item A = 6"]
    P2["PO-002<br/>Item A = 2"]
    P3["PO-003<br/>Item B = 8"]

    PO --> P1
    PO --> P2
    PO --> P3

    A -. "allocation" .-> P1
    A -. "allocation" .-> P2
    B -. "allocation" .-> P3
```

Result:

```text
Item A:
10 - 6 - 2 = 2 remaining

Item B:
20 - 8 = 12 remaining

Item C:
5 - 0 = 5 remaining
```

---

# 29. Complete Allocation Engine

```mermaid
flowchart TD

    START["Sales Order Loaded"]

    SO_LINES["Read Sales Order Line Items"]

    PO_FETCH["Fetch ALL Purchase Orders"]

    PO_STATUS["Check PO Status"]

    STATUS_OK{"Status Counts?"}

    REFERENCE["Check PO Reference Number"]

    REF_OK{"Reference = Sales Order Number?"}

    ITEM_MATCH["Match PO Item ID with SO Item ID"]

    QTY["Read PO Quantity"]

    SUM["Add PO Quantity to Allocated Quantity"]

    SO_QTY["Read Sales Order Quantity"]

    CALC["Remaining = SO Qty - Allocated Qty"]

    RESULT{"Remaining Quantity"}

    AVAILABLE["🟢 Available<br/>Remaining > 0"]

    ZERO["🔵 Fully Purchased<br/>Remaining = 0"]

    OVER["🔴 OVER-ALLOCATED<br/>Remaining < 0"]

    START --> SO_LINES
    START --> PO_FETCH

    PO_FETCH --> PO_STATUS
    PO_STATUS --> STATUS_OK

    STATUS_OK -- "No" --> SKIP1["Ignore PO"]
    STATUS_OK -- "Yes" --> REFERENCE

    REFERENCE --> REF_OK

    REF_OK -- "No" --> SKIP2["Ignore PO"]
    REF_OK -- "Yes" --> ITEM_MATCH

    ITEM_MATCH --> QTY
    QTY --> SUM

    SO_LINES --> SO_QTY
    SO_QTY --> CALC
    SUM --> CALC

    CALC --> RESULT

    RESULT -- "> 0" --> AVAILABLE
    RESULT -- "= 0" --> ZERO
    RESULT -- "< 0" --> OVER
```

---

# 30. Create Purchase Order Sequence

```mermaid
sequenceDiagram
    autonumber

    actor User
    participant Widget
    participant Books as Zoho Books

    User->>Widget: Click Create Purchase Order

    Widget->>Widget: Disable Create Button
    Widget->>Widget: Collect Form Data

    Widget->>Books: Fetch Latest Sales Order
    Books-->>Widget: Latest Sales Order

    Widget->>Books: Fetch All Purchase Orders
    Books-->>Widget: Purchase Orders

    Widget->>Widget: Find Related POs
    Widget->>Widget: Calculate Latest Allocation
    Widget->>Widget: Calculate Remaining Quantity

    alt Requested Quantity > Remaining Quantity
        Widget-->>User: Reject Request
        Widget-->>User: Show Available Quantity
        Widget->>Widget: Re-enable Create Button
    else Requested Quantity is Valid
        Widget->>Widget: Build PO Payload
        Widget->>Books: Create Purchase Order
        Books-->>Widget: PO Created
        Widget-->>User: Show Success
        Widget-->>User: Show PO Number
    end
```

---

# 31. Developer Function Pipeline

```mermaid
flowchart LR

    INIT["init()"]

    ORG["loadOrganizationContext()"]

    SO["fetchSalesOrder()"]

    NORMALIZE["normalizeSalesOrder()"]

    PO["getAllPurchaseOrders()"]

    FILTER["filterRelatedPurchaseOrders()"]

    ALLOCATION["calculateAllAllocations()"]

    RENDER["renderItems()"]

    FORM["collectFormData()"]

    VALIDATE["validateBeforeCreate()"]

    PAYLOAD["buildPurchaseOrderPayload()"]

    CREATE["createPurchaseOrder()"]

    SUCCESS["showSuccessScreen()"]

    INIT --> ORG
    ORG --> SO
    SO --> NORMALIZE

    ORG --> PO

    NORMALIZE --> FILTER
    PO --> FILTER

    FILTER --> ALLOCATION
    ALLOCATION --> RENDER

    RENDER --> FORM
    FORM --> VALIDATE
    VALIDATE --> PAYLOAD
    PAYLOAD --> CREATE
    CREATE --> SUCCESS
```

---

# 32. Function Reference

| Function | Responsibility |
|---|---|
| `init()` | Initializes widget and starts application flow |
| `loadOrganizationContext()` | Loads organization/API context |
| `fetchSalesOrder()` | Reads current Sales Order |
| `normalizeSalesOrder()` | Normalizes Sales Order data |
| `getAllPurchaseOrders()` | Fetches all Purchase Orders with pagination |
| `filterRelatedPurchaseOrders()` | Finds POs related to the Sales Order |
| `calculateAllAllocations()` | Calculates allocated and remaining quantity |
| `renderHeader()` | Renders Purchase Order header |
| `renderItems()` | Renders editable item table |
| `loadVendors()` | Loads Vendor Master |
| `openVendorDropdown()` | Opens/searches vendors |
| `selectVendor()` | Stores selected Vendor |
| `collectFormData()` | Collects user input |
| `validateBeforeCreate()` | Performs final validation |
| `buildPurchaseOrderPayload()` | Builds Books API payload |
| `createPurchaseOrder()` | Creates Purchase Order |
| `handleCreatePurchaseOrder()` | Controls complete creation flow |
| `confirmDiscard()` | Handles unsaved changes |
| `showSuccessScreen()` | Displays successful creation |

---

# 33. Testing Scenarios

## Scenario 1 — No Existing PO

```text
SO = 10
Allocated = 0
Available = 10
```

Expected:

```text
Maximum PO Quantity = 10
```

---

## Scenario 2 — One Existing PO

```text
SO = 10
PO = 6
Available = 4
```

Expected:

```text
New PO <= 4
```

---

## Scenario 3 — Multiple Existing POs

```text
SO = 10

PO-001 = 3
PO-002 = 2
PO-003 = 1

Allocated = 6
Available = 4
```

Expected:

```text
New PO <= 4
```

---

## Scenario 4 — Fully Purchased

```text
SO = 10
Allocated = 10
Available = 0
```

Expected:

```text
FULLY PURCHASED
```

---

## Scenario 5 — Over-Allocated

```text
SO = 10
Allocated = 12
Remaining = -2
```

Expected:

```text
OVER-ALLOCATED
```

---

## Scenario 6 — Partial Next PO

```text
SO = 10
Existing = 6
New PO = 2
```

Expected:

```text
Next Available = 2
```

---

## Scenario 7 — Double Click

User clicks Create twice.

Expected:

```text
Only one Purchase Order creation request
```

---

## Scenario 8 — Concurrent Update

```text
Widget shows = 10

Another user purchases = 7

Actual remaining = 3
```

Expected:

```text
Final validation detects latest quantity.
A request greater than 3 is rejected.
```

---

# 34. Testing Matrix

| Test | SO Qty | Existing PO Qty | Remaining | Expected |
|---|---:|---:|---:|---|
| No PO | 10 | 0 | 10 | Allow up to 10 |
| One PO | 10 | 6 | 4 | Allow up to 4 |
| Multiple POs | 10 | 3 + 2 + 1 | 4 | Allow up to 4 |
| Fully purchased | 10 | 10 | 0 | Block |
| Over-allocated | 10 | 12 | -2 | Block + warning |
| Partial purchase | 10 | 6 + 2 | 2 | Allow up to 2 |
| Concurrent update | 10 | Latest data required | Dynamic | Revalidate |

---

# 35. Important Developer Assumptions

The implementation assumes:

1. Sales Order number is used as the Purchase Order reference number.
2. Related Purchase Orders are identified using an exact reference-number match.
3. Item IDs are available on Sales Order and Purchase Order lines.
4. Purchase Order line quantities consume Sales Order allocation.
5. `COUNTED_PO_STATUSES` determines which PO statuses consume quantity.
6. All relevant Purchase Orders are fetched using pagination.
7. The Sales Order itself is never modified by the widget.
8. Final validation uses fresh Zoho Books data before creating the PO.

---

# 36. Duplicate Items — Future Consideration

If the same item appears multiple times in one Sales Order, matching only by:

```text
item_id
```

may not uniquely identify each Sales Order line.

Example:

```text
Sales Order

Line 1 → Item A → Qty 10
Line 2 → Item A → Qty 20
```

Both lines have the same Item ID.

A future enhancement can use the Sales Order line-item ID and a corresponding Purchase Order line relationship for more precise allocation.

---

# 37. Data Integrity Principle

The widget follows this principle:

```text
DO NOT TRUST OLD SCREEN DATA
            ↓
REFRESH LATEST DATA
            ↓
RECALCULATE
            ↓
VALIDATE
            ↓
CREATE
```

The final Purchase Order creation should always be based on the latest available Sales Order and Purchase Order data.

---

# 38. Architecture Summary

```text
                         ┌──────────────────────┐
                         │    ZOHO BOOKS        │
                         │                      │
                         │    Sales Order       │
                         │    Purchase Orders   │
                         │    Vendor Master     │
                         └──────────┬───────────┘
                                    │
                                    ▼
                    ┌────────────────────────────┐
                    │       WIDGET               │
                    │                            │
                    │  Read Sales Order          │
                    │          ↓                 │
                    │  Fetch Purchase Orders    │
                    │          ↓                 │
                    │  Match Related POs        │
                    │          ↓                 │
                    │  Calculate Allocation     │
                    │          ↓                 │
                    │  Calculate Remaining       │
                    │          ↓                 │
                    │  Purchase Order UI         │
                    │          ↓                 │
                    │  Final Validation          │
                    │          ↓                 │
                    │  Create Purchase Order     │
                    └────────────┬───────────────┘
                                 │
                                 ▼
                    ┌────────────────────────────┐
                    │     PURCHASE ORDER         │
                    │        CREATED             │
                    └────────────────────────────┘
```

---

# 39. One-Line Business Summary

> **This widget converts a Sales Order into a Purchase Order while continuously checking related Purchase Orders so that the total purchased quantity never exceeds the Sales Order quantity.**

---

# 40. Quick Reference

| Area | Function / Configuration |
|---|---|
| Counted PO statuses | `COUNTED_PO_STATUSES` |
| API page size | `PER_PAGE` |
| Current Sales Order | `fetchSalesOrder()` |
| Normalize Sales Order | `normalizeSalesOrder()` |
| Fetch all POs | `getAllPurchaseOrders()` |
| Match POs | `filterRelatedPurchaseOrders()` |
| Calculate quantities | `calculateAllAllocations()` |
| Render items | `renderItems()` |
| Load vendors | `loadVendors()` |
| Vendor selection | `selectVendor()` |
| Read form | `collectFormData()` |
| Validation | `validateBeforeCreate()` |
| Build payload | `buildPurchaseOrderPayload()` |
| Create PO | `createPurchaseOrder()` |
| Main creation flow | `handleCreatePurchaseOrder()` |
| Startup | `init()` |
| Discard changes | `confirmDiscard()` |
| Success screen | `showSuccessScreen()` |

---

# 41. Final Flow — One View

```mermaid
flowchart TD

    START(["🚀 START"])

    SO["📄 SALES ORDER<br/><b>Master Quantity</b>"]

    READ["🔍 Read Sales Order"]

    POS["📦 Fetch ALL Purchase Orders"]

    MATCH["🔗 Match Related POs<br/><b>PO Reference = SO Number</b>"]

    ALLOCATE["📊 Sum Allocated Quantity"]

    CALCULATE["🧮 Calculate Remaining<br/><b>SO Qty - Allocated Qty</b>"]

    STATUS{"Remaining Quantity"}

    AVAILABLE["🟢 Quantity Available"]

    FULL["🔵 Fully Purchased"]

    OVER["🔴 Over-Allocated"]

    VENDOR["👤 Select Vendor"]

    EDIT["📝 Review / Edit PO"]

    QTY["🔢 Enter PO Quantity"]

    REFRESH["🔄 Refresh Latest SO + POs"]

    VALIDATE{"✅ Quantity Valid?"}

    CREATE["🛒 Create Purchase Order"]

    SUCCESS(["🎉 PO CREATED"])

    BLOCK(["🚫 BLOCK PURCHASE"])

    START --> SO
    SO --> READ
    READ --> POS
    POS --> MATCH
    MATCH --> ALLOCATE
    ALLOCATE --> CALCULATE
    CALCULATE --> STATUS

    STATUS -- "> 0" --> AVAILABLE
    STATUS -- "= 0" --> FULL
    STATUS -- "< 0" --> OVER

    AVAILABLE --> VENDOR
    VENDOR --> EDIT
    EDIT --> QTY
    QTY --> REFRESH
    REFRESH --> VALIDATE

    VALIDATE -- "YES" --> CREATE
    CREATE --> SUCCESS

    VALIDATE -- "NO" --> BLOCK

    FULL --> BLOCK
    OVER --> BLOCK
```

---

## 42. Final Principle

```text
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                    SALES ORDER                              │
│                    MASTER QUANTITY                          │
│                           │                                 │
│                           ▼                                 │
│              FIND RELATED PURCHASE ORDERS                  │
│                           │                                 │
│                           ▼                                 │
│                 SUM PURCHASED QUANTITY                     │
│                           │                                 │
│                           ▼                                 │
│             CALCULATE REMAINING QUANTITY                   │
│                           │                                 │
│                           ▼                                 │
│                 USER CREATES NEW PO                         │
│                           │                                 │
│                           ▼                                 │
│                  REFRESH LATEST DATA                        │
│                           │                                 │
│                           ▼                                 │
│                     VALIDATE                                │
│                           │                                 │
│                           ▼                                 │
│                 CREATE PURCHASE ORDER                       │
│                                                             │
│   SALES ORDER IS NEVER MODIFIED BY THIS WIDGET             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```
