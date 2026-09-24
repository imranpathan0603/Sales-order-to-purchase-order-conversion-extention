/* ============================================================
 * Zoho Books Widget — Sales Order → Purchase Order Converter
 * ============================================================ */

'use strict';

// ============================================================
// CONFIGURATION
// ============================================================

const COUNTED_PO_STATUSES = ['draft', 'open', 'partially_received', 'received', 'billed'];
const PER_PAGE = 200;

const CONNECTION_LINK_NAME = 'bookconnectionwigdet';

// ============================================================
// GLOBAL STATE
// ============================================================

const state = {
    salesOrder: null,
    lineItems: [],
    vendors: [],
    vendorsLoading: false,
    creatingPurchaseOrder: false,
    dirty: false,
    createdPoId: null,
    apiRootEndPoint: null,
    organizationId: null
};

// ============================================================
// DOM CACHE
// ============================================================

const $ = (id) => document.getElementById(id);

const dom = {
    headerSoNumber: $('header-so-number'),
    validationErrors: $('validation-errors'),
    vendorComboBox: $('vendor-combobox'),
    vendorSearch: $('vendor-search'),
    vendorClear: $('vendor-clear'),
    vendorDropdown: $('vendor-dropdown'),
    vendorId: $('vendor-id'),
    orderDate: $('order-date'),
    deliveryDate: $('delivery-date'),
    referenceNumber: $('reference-number'),
    soNumberDisplay: $('so-number-display'),
    itemsTbody: $('items-tbody'),
    totalSubtotal: $('total-subtotal'),
    totalDiscount: $('total-discount'),
    totalTax: $('total-tax'),
    totalGrand: $('total-grand'),
    notes: $('notes'),
    terms: $('terms'),
    footerStatus: $('footer-status'),
    btnCancel: $('btn-cancel'),
    btnCreatePo: $('btn-create-po'),
    btnClose: $('btn-close'),
    loadingOverlay: $('loading-overlay'),
    loadingMessage: $('loading-message'),
    errorOverlay: $('error-overlay'),
    errorMessage: $('error-message'),
    btnErrorRetry: $('btn-error-retry'),
    btnErrorClose: $('btn-error-close'),
    successScreen: $('success-screen'),
    successPoNumber: $('success-po-number'),
    successPoDetails: $('success-po-details'),
    btnSuccessOpen: $('btn-success-open'),
    btnSuccessClose: $('btn-success-close'),
    app: $('app')
};

// ============================================================
// UTILITIES
// ============================================================

function log(stage, message, data) {
    console.log(`[${stage}] ${message}`, data !== undefined ? data : '');
}

function logError(stage, message, data) {
    console.error(`[${stage}] ${message}`, data !== undefined ? data : '');
}

function showLoading(msg) {
    dom.loadingMessage.textContent = msg || 'Loading...';
    dom.loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
    dom.loadingOverlay.classList.add('hidden');
}

function showError(msg, allowRetry) {
    dom.errorMessage.textContent = msg;
    dom.btnErrorRetry.style.display = allowRetry ? 'inline-flex' : 'none';
    dom.errorOverlay.classList.remove('hidden');
}

function hideError() {
    dom.errorOverlay.classList.add('hidden');
}

function todayISO() {
    return new Date().toISOString().split('T')[0];
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function markDirty() {
    state.dirty = true;
    dom.footerStatus.textContent = 'Unsaved changes';
}

function getUrlParameter(name) {
    return new URLSearchParams(window.location.search).get(name);
}

function withOrgId(extraParams) {
    return [
        { key: 'organization_id', value: String(state.organizationId) },
        ...(extraParams || [])
    ];
}

// ============================================================
// ORGANIZATION CONTEXT
// ============================================================

async function loadOrganizationContext() {
    const { organization } = await ZFAPPS.get('organization');

    if (!organization || !organization.api_root_endpoint) {
        throw new Error('Could not resolve organization API endpoint.');
    }

    state.apiRootEndPoint = organization.api_root_endpoint.replace(/\/+$/, '');
    state.organizationId = organization.organization_id;

    log('ORG', 'Context loaded', {
        apiRootEndPoint: state.apiRootEndPoint,
        organizationId: state.organizationId
    });
}

// ============================================================
// SALES ORDER
// ============================================================

async function fetchSalesOrder() {
    log('SALES_ORDER', 'Fetching context...');
    const response = await ZFAPPS.get('salesorder');
    const so = response && response.salesorder;

    if (!so) {
        throw new Error(
            'No Sales Order found. Ensure this widget is placed on a Sales Order detail page.'
        );
    }

    log('SALES_ORDER', 'Number: ' + so.salesorder_number);
    return so;
}

function normalizeSalesOrder(so) {
    const lineItems = (so.line_items || []).map((item, idx) => ({
        lineItemId: item.line_item_id || `so_line_${idx}`,
        itemId: item.item_id || null,
        name: item.name || 'Item',
        description: item.description || '',
        quantity: parseFloat(item.quantity) || 0,
        rate: parseFloat(item.rate) || 0,
        taxId: item.tax_id || null,
        taxPercentage: parseFloat(item.tax_percentage) || 0,
        discount: parseFloat(item.discount) || 0,
        unit: item.unit || '',
        warehouseId: item.warehouse_id || item.location_id || null
    }));

    return {
        id: so.salesorder_id,
        number: so.salesorder_number,
        customerId: so.customer_id || '',
        customerName: so.customer_name || '',
        referenceNumber: so.reference_number || '',
        notes: so.notes || '',
        terms: so.terms || '',
        lineItems
    };
}

// ============================================================
// PURCHASE ORDER FETCHING
// ============================================================

async function getAllPurchaseOrders() {
    let all = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        log('PO_FETCH', `Page ${page}`);
        const response = await ZFAPPS.request({
            url: `${state.apiRootEndPoint}/purchaseorders`,
            method: 'GET',
            url_query: withOrgId([
                { key: 'page', value: String(page) },
                { key: 'per_page', value: String(PER_PAGE) }
            ]),
            connection_link_name: CONNECTION_LINK_NAME
        });

        let data;
        try {
            data = JSON.parse(response.data.body);
        } catch (e) {
            throw new Error('Failed to parse PO response: ' + e.message);
        }

        if (data.code !== 0) {
            throw new Error(data.message || 'Failed to fetch Purchase Orders.');
        }

        all = all.concat(data.purchaseorders || []);
        hasMore = (data.page_context || {}).has_more_page === true;
        page++;
    }

    log('PO_FETCH', `Total fetched (summary/list records): ${all.length}`);
    return all;
}

/**
 * The LIST endpoint above does not reliably return line_items for each PO —
 * only the DETAIL endpoint does. This fetches the full record for one PO id.
 */
// async function fetchPurchaseOrderDetails(purchaseOrderId) {
//     const response = await ZFAPPS.request({
//         url: `${state.apiRootEndPoint}/purchaseorders/${purchaseOrderId}`,
//         method: 'GET',
//         url_query: withOrgId(),
//         connection_link_name: CONNECTION_LINK_NAME
//     });

//     let data;
//     try {
//         data = JSON.parse(response.data.body);
//     } catch (e) {
//         throw new Error('Failed to parse PO detail response: ' + e.message);
//     }

//     if (data.code !== 0) {
//         throw new Error(data.message || `Failed to fetch Purchase Order ${purchaseOrderId}.`);
//     }

//     return data.purchaseorder;
// }
/**
 * The LIST endpoint does not reliably return line_items for each PO —
 * only the DETAIL endpoint does. This fetches the full record for one PO id.
 *
 * IMPORTANT: without an explicit Accept: application/json header, this
 * endpoint can return the Purchase Order's PDF/print template HTML instead
 * of the JSON record (visible as "<!--The below style_start tag...").
 * The header below forces the JSON response.
 */
async function fetchPurchaseOrderDetails(purchaseOrderId) {
    const response = await ZFAPPS.request({
        url: `${state.apiRootEndPoint}/purchaseorders/${purchaseOrderId}`,
        method: 'GET',
        url_query: withOrgId(),
        header: [
            { key: 'Accept', value: 'application/json' }
        ],
        connection_link_name: CONNECTION_LINK_NAME
    });

    const rawBody = response && response.data && response.data.body;

    // Defensive check: if we still somehow get HTML back, fail fast with a
    // clear message instead of letting JSON.parse throw a cryptic error.
    if (typeof rawBody === 'string' && rawBody.trim().startsWith('<')) {
        logError('PO_DETAIL', `Received HTML instead of JSON for PO ${purchaseOrderId} — raw body below`, rawBody);
        throw new Error(`Received HTML (print template) instead of JSON for PO ${purchaseOrderId}.`);
    }

    let data;

    console.log('PO Detail raw response for',purchaseOrderId,rawBody,response.data);
    try {
        data = JSON.parse(rawBody);
    } catch (e) {
        logError('PO_DETAIL', `Non-JSON response for PO ${purchaseOrderId} — raw body below`, rawBody);
        throw new Error(`Failed to parse PO detail response for ${purchaseOrderId}: ` + e.message);
    }

    if (data.code !== 0) {
        throw new Error(data.message || `Failed to fetch Purchase Order ${purchaseOrderId}.`);
    }

    return data.purchaseorder;
}


/**
 * Filter list-summary POs to those referencing this Sales Order, then fetch
 * FULL DETAIL (with real line_items) for each match in parallel. Without
 * this step, line_items is empty/incomplete on list records and allocation
 * silently sees zero purchased quantity for every existing PO.
 */
async function getRelatedPurchaseOrdersWithLineItems(allPOs, soNumber) {
    const normalizedSoNumber = String(soNumber || '').trim();

    const summaryMatches = allPOs.filter((po) => {
        const ref = String(po.reference_number || '').trim();
        return ref !== '' && ref === normalizedSoNumber;
    });

    const countedSummaryMatches = summaryMatches.filter((po) => COUNTED_PO_STATUSES.includes(po.status));

    log('PO_FILTER', `Reference-matched: ${summaryMatches.length}, Counted status: ${countedSummaryMatches.length}`, {
        soNumber: normalizedSoNumber,
        matchedPoNumbers: summaryMatches.map((p) => p.purchaseorder_number)
    });

    if (countedSummaryMatches.length === 0) return [];

    const detailed = await Promise.all(
        countedSummaryMatches.map(async (po) => {
            try {
                const full = await fetchPurchaseOrderDetails(po.purchaseorder_id);
                log('PO_DETAIL', `Fetched line_items for ${full.purchaseorder_number}`, full.line_items);
                return full;
            } catch (err) {
                logError('PO_DETAIL', `Failed to fetch detail for PO ${po.purchaseorder_id}, excluding from allocation`, err);
                return null;
            }
        })
    );

    return detailed.filter(Boolean);
}


/**
 * Debug helper — prints every related PO's line items to the console
 * as a readable table: PO number, item name, item_id, quantity, status.
 */
function printPurchaseOrderLineItems(relatedPOs) {
    if (!relatedPOs || relatedPOs.length === 0) {
        log('PO_LINES', 'No related Purchase Orders to print.');
        return;
    }

    const rows = [];
    relatedPOs.forEach((po) => {
        (po.line_items || []).forEach((li) => {
            rows.push({
                'PO Number': po.purchaseorder_number,
                'PO Status': po.status,
                'Item Name': li.name,
                'Item ID': li.item_id,
                'SO Line Item ID': li.salesorder_item_id || '(none)',
                'Quantity': li.quantity,
                'Rate': li.rate
            });
        });
    });

    if (rows.length === 0) {
        logError('PO_LINES', 'Related POs found but none had any line_items — detail fetch may be failing.', relatedPOs);
        return;
    }

    log('PO_LINES', `Printing ${rows.length} line item(s) across ${relatedPOs.length} PO(s):`);
    if (console.table) {
        console.table(rows);
    } else {
        rows.forEach((r) => console.log(r));
    }
}

// ============================================================
// QUANTITY ALLOCATION ENGINE
// ============================================================

function calculateAllAllocations(salesOrder, relatedPOs) {
    log('ALLOCATION', 'Calculating for SO', salesOrder.number);

    const allocations = {};
    salesOrder.lineItems.forEach((item) => {
        allocations[item.lineItemId] = {
            lineItemId: item.lineItemId,
            itemId: item.itemId,
            name: item.name,
            salesOrderQuantity: item.quantity,
            allocatedQuantity: 0,
            remainingQuantity: item.quantity,
            overAllocated: false
        };
    });

    relatedPOs.forEach((po) => {
        log('ALLOCATION', `Processing PO ${po.purchaseorder_number}`, po.line_items);
        (po.line_items || []).forEach((poLine) => {
            const poQty = parseFloat(poLine.quantity) || 0;
            if (poQty <= 0) return;

            log('ALLOCATION', `PO ${po.purchaseorder_number} line "${poLine.name}" item_id=${poLine.item_id} qty=${poQty}`);

            let target = null;
            if (poLine.salesorder_item_id) {
                target = Object.values(allocations).find(
                    (a) => a.lineItemId === poLine.salesorder_item_id
                );
            }
            if (!target && poLine.item_id) {
                const candidates = Object.values(allocations).filter(
                    (a) => a.itemId === poLine.item_id
                );
                target = candidates.find(
                    (a) => a.allocatedQuantity < a.salesOrderQuantity
                ) || candidates[0];
            }

            if (target) {
                target.allocatedQuantity = parseFloat((target.allocatedQuantity + poQty).toFixed(6));
            } else {
                logError('ALLOCATION', 'Unmatched PO line item — could not link to any SO line', {
                    purchaseorder_number: po.purchaseorder_number,
                    poLine
                });
            }
        });
    });

    Object.values(allocations).forEach((a) => {
        const remaining = a.salesOrderQuantity - a.allocatedQuantity;
        a.overAllocated = remaining < 0;
        a.remainingQuantity = Math.max(remaining, 0);

        if (a.overAllocated) {
            logError('ALLOCATION', `OVER-ALLOCATED: ${a.name}`, {
                salesOrderQty: a.salesOrderQuantity,
                purchasedQty: a.allocatedQuantity,
                excess: a.allocatedQuantity - a.salesOrderQuantity
            });
        }
    });

    log('ALLOCATION', 'Final allocation result', allocations);
    return allocations;
}

// ============================================================
// VENDOR API
// ============================================================

async function fetchVendors(searchText) {
    let all = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const params = withOrgId([
            { key: 'contact_type', value: 'vendor' },
            { key: 'page', value: String(page) },
            { key: 'per_page', value: String(PER_PAGE) }
        ]);
        if (searchText) params.push({ key: 'search_text', value: searchText });

        log('VENDOR', `Fetching vendors page ${page}...`);
        const response = await ZFAPPS.request({
            url: `${state.apiRootEndPoint}/contacts`,
            method: 'GET',
            url_query: params,
            connection_link_name: CONNECTION_LINK_NAME
        });

        let data;
        try {
            data = JSON.parse(response.data.body);
        } catch (e) {
            throw new Error('Failed to parse vendor response: ' + e.message);
        }

        if (data.code !== 0) {
            throw new Error(data.message || 'Failed to fetch vendors.');
        }

        all = all.concat(data.contacts || []);
        hasMore = (data.page_context || {}).has_more_page === true;
        page++;

        if (page > 5) break;
    }

    const vendors = all.map((v) => ({
        id: v.contact_id,
        name: v.contact_name,
        companyName: v.company_name || '',
        email: v.email || '',
        paymentTerms: v.payment_terms || ''
    }));

    log('VENDOR', `Received ${vendors.length} vendors`);
    return vendors;
}

async function fetchVendorById(contactId) {
    if (!contactId) return null;
    log('VENDOR', 'Fetching by ID: ' + contactId);

    const response = await ZFAPPS.request({
        url: `${state.apiRootEndPoint}/contacts/${contactId}`,
        method: 'GET',
        url_query: withOrgId(),
        connection_link_name: CONNECTION_LINK_NAME
    });

    let data;
    try {
        data = JSON.parse(response.data.body);
    } catch (e) {
        throw new Error('Failed to parse vendor response: ' + e.message);
    }

    const v = data.contact;
    if (!v) return null;

    return {
        id: v.contact_id,
        name: v.contact_name,
        companyName: v.company_name || '',
        email: v.email || '',
        paymentTerms: v.payment_terms || ''
    };
}

// ============================================================
// VENDOR DROPDOWN UI
// ============================================================

function renderVendorDropdown(vendors, filterText) {
    const dd = dom.vendorDropdown;
    dd.innerHTML = '';

    const filtered = vendors.filter((v) => {
        if (!filterText) return true;
        const t = filterText.toLowerCase();
        return (
            v.name.toLowerCase().includes(t) ||
            (v.email && v.email.toLowerCase().includes(t)) ||
            (v.companyName && v.companyName.toLowerCase().includes(t))
        );
    });

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'vendor-dropdown-empty';
        empty.textContent = filterText ? 'No vendors found' : 'No vendors available';
        dd.appendChild(empty);
    } else {
        filtered.slice(0, 100).forEach((v) => {
            const item = document.createElement('div');
            item.className = 'vendor-dropdown-item';
            item.dataset.vendorId = v.id;
            item.innerHTML =
                `<div class="vendor-name">${escapeHtml(v.name)}</div>` +
                (v.email ? `<div class="vendor-email">${escapeHtml(v.email)}</div>` : '');
            item.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                selectVendor(v);
            });
            dd.appendChild(item);
        });
    }
    dd.classList.add('open');
}

function showVendorDropdownLoading() {
    dom.vendorDropdown.innerHTML =
        `<div class="vendor-dropdown-empty">Loading vendors...</div>`;
    dom.vendorDropdown.classList.add('open');
}

function showVendorDropdownError(msg) {
    dom.vendorDropdown.innerHTML =
        `<div class="vendor-dropdown-empty" style="color:#d32f2f;">${escapeHtml(msg)}</div>`;
    dom.vendorDropdown.classList.add('open');
}

function selectVendor(vendor) {
    dom.vendorId.value = vendor.id;
    dom.vendorSearch.value = vendor.name;
    dom.vendorComboBox.classList.add('has-value');
    dom.vendorDropdown.classList.remove('open');
    dom.vendorSearch.classList.remove('error');
    markDirty();

    if (vendor.paymentTerms && !dom.terms.value) {
        dom.terms.value = vendor.paymentTerms;
    }
    log('VENDOR', `Selected: ${vendor.name} (${vendor.id})`);
}

function clearVendor() {
    dom.vendorId.value = '';
    dom.vendorSearch.value = '';
    dom.vendorComboBox.classList.remove('has-value');
    dom.vendorDropdown.classList.remove('open');
    markDirty();
}

async function openVendorDropdown() {
    if (state.vendorsLoading) return;
    state.vendorsLoading = true;

    showVendorDropdownLoading();

    try {
        const vendors = await fetchVendors('');
        state.vendors = vendors;
        renderVendorDropdown(vendors, dom.vendorSearch.value);
    } catch (err) {
        logError('VENDOR', 'Vendor fetch failed', err);
        showVendorDropdownError('Unable to load vendors. Please try again.');
    } finally {
        state.vendorsLoading = false;
    }
}

// ============================================================
// UI RENDERING
// ============================================================

function renderHeader(salesOrder) {
    dom.headerSoNumber.textContent = salesOrder.number;
    dom.soNumberDisplay.value = salesOrder.number;
    dom.referenceNumber.value = salesOrder.number;
}

function renderItems(allocations) {
    const tbody = dom.itemsTbody;
    tbody.innerHTML = '';

    Object.values(allocations).forEach((a) => {
        const soItem = state.salesOrder.lineItems.find(
            (li) => li.lineItemId === a.lineItemId
        );
        if (!soItem) return;

        const isFullyPurchased = a.remainingQuantity <= 0 && !a.overAllocated;
        const isOverAllocated = a.overAllocated;
        const isBlocked = isFullyPurchased || isOverAllocated;

        const tr = document.createElement('tr');
        if (isOverAllocated) tr.className = 'over-allocated';
        else if (isFullyPurchased) tr.className = 'fully-purchased';
        tr.dataset.lineItemId = a.lineItemId;

        const tdName = document.createElement('td');
        tdName.className = 'item-name-cell';
        tdName.innerHTML = `<div>${escapeHtml(soItem.name)}</div>` +
            `<div class="item-meta">${escapeHtml(soItem.unit || '')}</div>`;
        if (isFullyPurchased) tdName.innerHTML += `<div><span class="status-badge fully-purchased">Fully Purchased</span></div>`;
        if (isOverAllocated) tdName.innerHTML += `<div><span class="status-badge over-allocated">OVER-ALLOCATED</span></div>`;
        tr.appendChild(tdName);

        const tdDesc = document.createElement('td');
        const descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.className = 'cell-input';
        descInput.value = soItem.description || '';
        descInput.placeholder = 'Description...';
        descInput.addEventListener('input', markDirty);
        tdDesc.appendChild(descInput);
        tr.appendChild(tdDesc);

        const tdInfo = document.createElement('td');
        const remClass = isOverAllocated ? 'remaining-negative' : (isFullyPurchased ? 'remaining-zero' : '');
        tdInfo.innerHTML = `<div class="qty-info">` +
            `<span><span class="label">SO Qty:</span> <span class="value">${a.salesOrderQuantity}</span></span>` +
            `<span><span class="label">Purchased:</span> <span class="value">${a.allocatedQuantity}</span></span>` +
            `<span><span class="label">Remaining:</span> <span class="value ${remClass}">${a.remainingQuantity}</span></span>` +
            `</div>`;
        tr.appendChild(tdInfo);

        const tdQty = document.createElement('td');
        const qtyInput = document.createElement('input');
        qtyInput.type = 'number';
        qtyInput.className = 'cell-input qty-input';
        qtyInput.min = '0';
        qtyInput.step = '1';
        qtyInput.value = isBlocked ? '0' : String(Math.max(0, a.remainingQuantity));
        qtyInput.dataset.lineItemId = a.lineItemId;
        qtyInput.dataset.maxQty = String(Math.max(0, a.remainingQuantity));
        qtyInput.disabled = isBlocked;
        qtyInput.addEventListener('input', onQuantityChange);
        tdQty.appendChild(qtyInput);
        tr.appendChild(tdQty);

        const tdRate = document.createElement('td');
        const rateInput = document.createElement('input');
        rateInput.type = 'number';
        rateInput.className = 'cell-input rate-input';
        rateInput.min = '0';
        rateInput.step = '0.01';
        rateInput.value = soItem.rate ? String(soItem.rate) : '0';
        rateInput.addEventListener('input', onAmountChange);
        tdRate.appendChild(rateInput);
        tr.appendChild(tdRate);

        const tdDisc = document.createElement('td');
        const discInput = document.createElement('input');
        discInput.type = 'number';
        discInput.className = 'cell-input discount-input';
        discInput.min = '0';
        discInput.step = '0.01';
        discInput.value = soItem.discount ? String(soItem.discount) : '0';
        discInput.addEventListener('input', onAmountChange);
        tdDisc.appendChild(discInput);
        tr.appendChild(tdDisc);

        const tdTax = document.createElement('td');
        const taxInput = document.createElement('input');
        taxInput.type = 'number';
        taxInput.className = 'cell-input tax-input';
        taxInput.min = '0';
        taxInput.step = '0.01';
        taxInput.value = soItem.taxPercentage ? String(soItem.taxPercentage) : '0';
        taxInput.addEventListener('input', onAmountChange);
        tdTax.appendChild(taxInput);
        tr.appendChild(tdTax);

        const tdAmount = document.createElement('td');
        tdAmount.className = 'amount-cell';
        tdAmount.textContent = '0.00';
        tr.appendChild(tdAmount);

        const tdActions = document.createElement('td');
        tdActions.className = 'actions-cell';
        tdActions.innerHTML = `<button disabled title="Not allowed in conversion mode">⋮</button>`;
        tr.appendChild(tdActions);

        tbody.appendChild(tr);
    });

    recalculateAllAmounts();
}

// ============================================================
// CALCULATION
// ============================================================

function getRowInputs(lineItemId) {
    const tr = dom.itemsTbody.querySelector(`tr[data-line-item-id="${lineItemId}"]`);
    if (!tr) return null;
    return {
        tr,
        desc: tr.querySelector('input[type="text"]'),
        qty: tr.querySelector('.qty-input'),
        rate: tr.querySelector('.rate-input'),
        discount: tr.querySelector('.discount-input'),
        tax: tr.querySelector('.tax-input'),
        amount: tr.querySelector('.amount-cell')
    };
}

function recalculateAllAmounts() {
    let subtotal = 0, discountTotal = 0, taxTotal = 0;

    Object.values(state.lineItems).forEach((a) => {
        const inputs = getRowInputs(a.lineItemId);
        if (!inputs) return;

        const qty = parseFloat(inputs.qty.value) || 0;
        const rate = parseFloat(inputs.rate.value) || 0;
        const discount = parseFloat(inputs.discount.value) || 0;
        const taxPct = parseFloat(inputs.tax.value) || 0;

        const lineTotal = qty * rate;
        const afterDiscount = Math.max(0, lineTotal - discount);
        const taxAmount = (afterDiscount * taxPct) / 100;
        const amount = afterDiscount + taxAmount;

        inputs.amount.textContent = amount.toFixed(2);

        subtotal += lineTotal;
        discountTotal += discount;
        taxTotal += taxAmount;
    });

    dom.totalSubtotal.textContent = subtotal.toFixed(2);
    dom.totalDiscount.textContent = discountTotal.toFixed(2);
    dom.totalTax.textContent = taxTotal.toFixed(2);
    dom.totalGrand.textContent = (subtotal - discountTotal + taxTotal).toFixed(2);
}

function onQuantityChange(e) {
    const input = e.target;
    const maxQty = parseFloat(input.dataset.maxQty) || 0;
    const entered = parseFloat(input.value) || 0;

    if (entered > maxQty) {
        input.classList.add('error');
        input.title = `Only ${maxQty} quantity is available for this item.`;
    } else {
        input.classList.remove('error');
        input.title = '';
    }

    markDirty();
    recalculateAllAmounts();
}

function onAmountChange() {
    markDirty();
    recalculateAllAmounts();
}

// ============================================================
// VALIDATION
// ============================================================

function collectFormData() {
    const lineItems = Object.values(state.lineItems).map((a) => {
        const inputs = getRowInputs(a.lineItemId);
        if (!inputs) return null;
        return {
            lineItemId: a.lineItemId,
            itemId: a.itemId,
            name: a.name,
            description: inputs.desc.value,
            poQuantity: parseFloat(inputs.qty.value) || 0,
            rate: parseFloat(inputs.rate.value) || 0,
            discount: parseFloat(inputs.discount.value) || 0,
            taxId: a.taxId,
            unit: a.unit
        };
    }).filter(Boolean);

    return {
        vendorId: dom.vendorId.value,
        date: dom.orderDate.value,
        deliveryDate: dom.deliveryDate.value,
        lineItems,
        notes: dom.notes.value,
        terms: dom.terms.value
    };
}

function validateBeforeCreate(formData, freshAllocations) {
    const errors = [];

    if (!formData.vendorId) {
        errors.push({ message: 'Please select a vendor.' });
    }

    if (!formData.lineItems.some((li) => li.poQuantity > 0)) {
        errors.push({ message: 'At least one line item must have a quantity greater than zero.' });
    }

    formData.lineItems.forEach((li) => {
        const alloc = freshAllocations[li.lineItemId];
        if (!alloc) return;

        if (li.poQuantity < 0) {
            errors.push({ message: `${alloc.name}: quantity cannot be negative.` });
            return;
        }

        if (alloc.overAllocated && li.poQuantity > 0) {
            errors.push({ message: `${alloc.name} is OVER-ALLOCATED. No further quantity can be purchased.` });
            return;
        }

        if (li.poQuantity > alloc.remainingQuantity) {
            errors.push({
                message: `${alloc.name}: Only ${alloc.remainingQuantity} quantity is available for this item.`
            });
        }
    });

    Object.values(freshAllocations).forEach((a) => {
        if (a.overAllocated) {
            errors.push({ message: `OVER-ALLOCATED: ${a.name} has ${a.allocatedQuantity} purchased against SO quantity ${a.salesOrderQuantity}.` });
        }
    });

    return errors;
}

function showValidationErrors(errors) {
    if (!errors || errors.length === 0) {
        dom.validationErrors.style.display = 'none';
        return;
    }
    dom.validationErrors.innerHTML =
        `<h4>Please fix the following:</h4><ul>` +
        errors.map((e) => `<li>${escapeHtml(e.message)}</li>`).join('') +
        `</ul>`;
    dom.validationErrors.style.display = 'block';
    dom.validationErrors.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ============================================================
// PURCHASE ORDER CREATION
// ============================================================

function buildPurchaseOrderPayload(formData, salesOrderNumber) {
    return {
        vendor_id: formData.vendorId,
        date: formData.date,
        delivery_date: formData.deliveryDate || formData.date,
        reference_number: salesOrderNumber,
        line_items: formData.lineItems
            .filter((li) => li.poQuantity > 0)
            .map((li) => ({
                item_id: li.itemId || undefined,
                name: li.name,
                description: li.description,
                quantity: li.poQuantity,
                rate: li.rate,
                discount: li.discount,
                tax_id: li.taxId || undefined,
                unit: li.unit || undefined,
                salesorder_item_id: li.lineItemId
            })),
        notes: formData.notes,
        terms: formData.terms
    };
}

async function createPurchaseOrder(payload) {
    log('CREATE_PO', 'Submitting...', payload);
    const response = await ZFAPPS.request({
        url: `${state.apiRootEndPoint}/purchaseorders`,
        method: 'POST',
        url_query: withOrgId(),
        body: { mode: 'raw', raw: JSON.stringify(payload) },
        connection_link_name: CONNECTION_LINK_NAME
    });

    let data;
    try {
        data = JSON.parse(response.data.body);
    } catch (e) {
        throw new Error('Failed to parse create response: ' + e.message);
    }

    if (data.code !== 0) {
        throw new Error(data.message || 'Purchase Order creation failed.');
    }

    const po = data.purchaseorder;
    log('CREATE_PO', 'Success. ID: ' + po.purchaseorder_id);

    return {
        id: po.purchaseorder_id,
        number: po.purchaseorder_number,
        vendorName: po.vendor_name,
        total: po.total
    };
}

async function handleCreatePurchaseOrder() {
    if (state.creatingPurchaseOrder) return;
    state.creatingPurchaseOrder = true;
    dom.btnCreatePo.disabled = true;
    dom.btnCreatePo.textContent = 'Creating Purchase Order...';

    try {
        const formData = collectFormData();

        if (!formData.vendorId) {
            showValidationErrors([{ message: 'Please select a vendor.' }]);
            return;
        }

        showLoading('Refreshing Sales Order and Purchase Orders...');

        const freshSO = await fetchSalesOrder();
        const normalizedSO = normalizeSalesOrder(freshSO);
        const allPOs = await getAllPurchaseOrders();
        const relatedPOs = await getRelatedPurchaseOrdersWithLineItems(allPOs, normalizedSO.number);
        printPurchaseOrderLineItems(relatedPOs); // <-- prints the table

        const freshAllocations = calculateAllAllocations(normalizedSO, relatedPOs);

        hideLoading();

        const errors = validateBeforeCreate(formData, freshAllocations);
        if (errors.length > 0) {
            const quantityChanged = errors.some((e) =>
                e.message.includes('is available for this item') || e.message.includes('OVER-ALLOCATED')
            );

            if (quantityChanged) {
                showValidationErrors([{
                    message: 'The available quantity has changed. Please review the updated quantities below.'
                }, ...errors]);
                state.salesOrder = normalizedSO;
                state.lineItems = freshAllocations;
                renderHeader(normalizedSO);
                renderItems(freshAllocations);
                dom.footerStatus.textContent = 'Available quantities updated. Please review.';
            } else {
                showValidationErrors(errors);
            }
            return;
        }

        showLoading('Creating Purchase Order...');
        const result = await createPurchaseOrder(
            buildPurchaseOrderPayload(formData, normalizedSO.number)
        );

        state.createdPoId = result.id;
        hideLoading();
        showSuccessScreen(result);
        state.dirty = false;
    } catch (err) {
        hideLoading();
        logError('ERROR', 'Create PO failed', err);
        showError(err.message || 'Unable to create Purchase Order.', true);
    } finally {
        state.creatingPurchaseOrder = false;
        dom.btnCreatePo.disabled = false;
        dom.btnCreatePo.textContent = 'Create Purchase Order';
    }
}

// ============================================================
// SUCCESS SCREEN & DISCARD
// ============================================================

function showSuccessScreen(po) {
    dom.successPoNumber.textContent = po.number || '—';
    dom.successPoDetails.innerHTML =
        `<div><strong>Vendor:</strong> ${escapeHtml(po.vendorName || '—')}</div>` +
        `<div><strong>Total:</strong> ${escapeHtml(String(po.total || '—'))}</div>`;
    dom.app.style.display = 'none';
    dom.successScreen.style.display = 'block';
}

function confirmDiscard() {
    if (!state.dirty || state.createdPoId) {
        ZFAPPS.invoke('CLOSE');
        return;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-dialog-backdrop';
    backdrop.innerHTML =
        `<div class="confirm-dialog">` +
        `<h3>Unsaved changes</h3>` +
        `<p>You have unsaved changes. Discard them and close?</p>` +
        `<div class="confirm-dialog-actions">` +
        `<button class="btn btn-secondary" id="cd-cancel">Cancel</button>` +
        `<button class="btn btn-primary" id="cd-discard">Discard</button>` +
        `</div></div>`;
    document.body.appendChild(backdrop);

    backdrop.querySelector('#cd-cancel').addEventListener('click', () => backdrop.remove());
    backdrop.querySelector('#cd-discard').addEventListener('click', () => {
        state.dirty = false;
        backdrop.remove();
        ZFAPPS.invoke('CLOSE');
    });
}

// ============================================================
// EVENT WIRING
// ============================================================

function wireEvents() {

    dom.vendorSearch.addEventListener('focus', async () => {
        await openVendorDropdown();
    });

    dom.vendorSearch.addEventListener('input', async () => {
        if (state.vendors.length === 0 && !state.vendorsLoading) {
            await openVendorDropdown();
        } else {
            renderVendorDropdown(state.vendors, dom.vendorSearch.value);
        }
    });

    dom.vendorSearch.addEventListener('blur', () => {
        setTimeout(() => dom.vendorDropdown.classList.remove('open'), 200);
    });

    dom.vendorClear.addEventListener('click', clearVendor);

    dom.orderDate.addEventListener('change', markDirty);
    dom.deliveryDate.addEventListener('change', markDirty);
    dom.notes.addEventListener('input', markDirty);
    dom.terms.addEventListener('input', markDirty);

    dom.btnCreatePo.addEventListener('click', handleCreatePurchaseOrder);
    dom.btnCancel.addEventListener('click', confirmDiscard);
    dom.btnClose.addEventListener('click', confirmDiscard);

    dom.btnErrorRetry.addEventListener('click', () => {
        hideError();
        handleCreatePurchaseOrder();
    });
    dom.btnErrorClose.addEventListener('click', hideError);

    dom.btnSuccessClose.addEventListener('click', () => ZFAPPS.invoke('CLOSE'));
    dom.btnSuccessOpen.addEventListener('click', () => {
        ZFAPPS.invoke('NAVIGATE', { url: `/books/#/purchaseorders/${state.createdPoId}` });
    });

    window.addEventListener('beforeunload', (e) => {
        if (state.dirty && !state.createdPoId) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
}

// ============================================================
// ON_VENDOR_SAVED EVENT
// ============================================================

async function registerVendorSavedListener(App) {
    App.instance.on('ON_VENDOR_SAVED', async function (data) {
        const recordId = data && data.record_id;
        log('EVENT', 'Saved vendor record ID: ' + recordId);

        if (recordId) {
            try {
                const vendor = await fetchVendorById(recordId);
                if (vendor) {
                    selectVendor(vendor);
                    log('EVENT', `Auto-selected vendor: ${vendor.name}`);
                }
            } catch (err) {
                logError('ERROR', 'Error fetching vendor after save', err);
            }
        }
    });
}

// ============================================================
// INITIALISATION
// ============================================================

async function loadAllocationData() {
    showLoading('Loading Sales Order...');
    const salesOrder = normalizeSalesOrder(await fetchSalesOrder());
    state.salesOrder = salesOrder;

    showLoading('Loading Purchase Orders...');
    const allPOs = await getAllPurchaseOrders();

    showLoading('Fetching Purchase Order line item details...');
    const relatedPOs = await getRelatedPurchaseOrdersWithLineItems(allPOs, salesOrder.number);

    showLoading('Calculating available quantities...');
    const allocations = calculateAllAllocations(salesOrder, relatedPOs);
    state.lineItems = allocations;

    renderHeader(salesOrder);
    renderItems(allocations);
}

async function init() {
    wireEvents();
    try {
        const App = await ZFAPPS.extension.init();
        await ZFAPPS.invoke('RESIZE', { width: '1300px', height: '850px' });

        showLoading('Loading organization context...');
        await loadOrganizationContext();

        const urlContactId = getUrlParameter('contact_id');
        if (urlContactId) {
            try {
                const vendor = await fetchVendorById(urlContactId);
                if (vendor) selectVendor(vendor);
            } catch (err) {
                logError('ERROR', 'Vendor pre-load failed', err);
            }
        }

        await loadAllocationData();

        dom.orderDate.value = todayISO();
        const defaultDelivery = new Date();
        defaultDelivery.setDate(defaultDelivery.getDate() + 7);
        dom.deliveryDate.value = defaultDelivery.toISOString().split('T')[0];

        if (state.salesOrder.notes) dom.notes.value = state.salesOrder.notes;
        if (state.salesOrder.terms) dom.terms.value = state.salesOrder.terms;

        registerVendorSavedListener(App).catch((err) =>
            logError('ERROR', 'Error registering ON_VENDOR_SAVED', err)
        );

        hideLoading();
        dom.footerStatus.textContent = 'Ready';
    } catch (err) {
        hideLoading();
        logError('ERROR', 'Init failed', err);
        showError(err.message || 'Unable to initialise the widget.', true);
    }
}

window.addEventListener('load', init);