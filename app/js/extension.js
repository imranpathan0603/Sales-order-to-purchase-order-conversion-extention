/* ============================================================
 * Zoho Books Widget — Sales Order → Purchase Order Converter
 * ============================================================ */

'use strict';

// ============================================================
// CONFIGURATION
// ============================================================

const COUNTED_PO_STATUSES = ['draft', 'open', 'partially_received', 'received', 'billed'];
const PER_PAGE = 200;
const CONNECTION_LINK_NAME = 'booksconnection';

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
    organizationId: null,
    organizationDataCenterExtension: null,
    tdsTaxes: [],
    tcsTaxes: []
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

function setText(el, text) {
    if (el) el.textContent = text;
}

/** Logs any element the script expects but index.html does not contain. */
function checkRequiredElements() {
    const ids = [
        'header-so-number', 'footer-status', 'total-subtotal', 'total-discount',
        'total-grand', 'total-tax', 'notes', 'terms', 'items-tbody',
        'btn-create-po', 'btn-cancel', 'btn-close', 'order-date', 'delivery-date',
        'reference-number', 'so-number-display', 'loading-message', 'error-message',
        'success-po-number', 'success-po-details'
    ];
    const missing = ids.filter((id) => !document.getElementById(id));
    if (missing.length) console.error('[HTML] Missing element IDs in index.html:', missing.join(', '));
}

function markDirty() {
    state.dirty = true;
    setText(dom.footerStatus, 'Unsaved changes');
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
    state.org = organization;
    state.organizationDataCenterExtension = organization.data_center_extension || '.com';

    log('ORG', 'Context loaded', {
        apiRootEndPoint: state.apiRootEndPoint,
        organizationId: state.organizationId,
        dataCenterExtension: state.organizationDataCenterExtension
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
        throw new Error('No Sales Order found. Ensure this widget is placed on a Sales Order detail page.');
    }

    log('SALES_ORDER', 'Number: ' + so.salesorder_number);
    return so;
}

function normalizeSalesOrder(so) {
    const lineItems = (so.line_items || []).map((item, idx) => {
        const rawDisc = item.discount;
        return {
            lineItemId: item.line_item_id || `so_line_${idx}`,
            itemId: item.item_id || null,
            name: item.name || 'Item',
            description: item.description || '',
            quantity: parseFloat(item.quantity) || 0,
            rate: parseFloat(item.rate) || 0,
            taxId: item.tax_id || null,
            taxName: item.tax_name || '',
            taxPercentage: parseFloat(item.tax_percentage) || 0,
            discount: parseFloat(rawDisc) || 0,
            discountPct: typeof rawDisc === 'string' && rawDisc.indexOf('%') > -1,
            unit: item.unit || '',
            sku: item.sku || '',
            hsn: item.hsn_or_sac || '',
            locationId: item.location_id ? String(item.location_id) : '',
            warehouseId: item.warehouse_id || item.location_id || null
        };
    });

    return {
        id: so.salesorder_id,
        number: so.salesorder_number,
        customerId: so.customer_id || '',
        customerName: so.customer_name || '',
        shippingAddress: so.shipping_address || {},
        referenceNumber: so.reference_number || '',
        deliveryMethod: so.delivery_method || '',
        notes: so.notes || '',
        terms: so.terms || '',
        isInclusiveTax: so.is_inclusive_tax === true || so.is_inclusive_tax === 'true',
        discountTypeRaw: so.discount_type || '',
        discountRaw: so.discount,
        discountBeforeTax: so.is_discount_before_tax !== false && so.is_discount_before_tax !== 'false',
        currencySymbol: (state.salesOrder && state.salesOrder.currencySymbol) || (state.org && state.org.currency_symbol) || '₹',
        currencyCode: (state.salesOrder && state.salesOrder.currencyCode) || (state.org && state.org.currency_code) || 'INR',
        adjustment: $('tot-adj-val') ? (parseFloat($('tot-adj-val').value) || 0) : 0,
        adjustmentDescription: $('tot-adj-box') ? $('tot-adj-box').textContent.trim() : 'Adjustment',
        tdsTaxId: $('tot-tds-select') ? $('tot-tds-select').value : '',
        isTds: typeof txMode === 'function' ? txMode() === 'tds' : true,
        lineItems
    };
}

// ============================================================
// ITEM MODES: warehouse location, selection type, tax mode, discount type
// ============================================================

const DISCOUNT_TYPES = [
    { value: 'entity_level', label: 'At Transaction Level', api: 'entity_level' },
    { value: 'item_level', label: 'At Line Item Level', api: 'item_level' },
    { value: 'both', label: 'At Line Item Level and at Transaction Level', api: 'item_level' }
];
const TAX_MODES = [
    { value: 'exclusive', label: 'Tax Exclusive' },
    { value: 'inclusive', label: 'Tax Inclusive' }
];
const SELECTION_TYPES = [
    { value: 'single', label: 'Single Location' },
    { value: 'multiple', label: 'Multiple Location' }
];

state.mode = { taxInclusive: false, discountType: 'entity_level', selection: 'single', discountBeforeTax: true, txValue: 0, txUnit: 'pct' };

function flatLocations(nodes = state.locations, prefix = '') {
    const out = [];
    function walk(list, p) {
        (list || []).forEach((item) => {
            const displayName = p ? `${p} > ${item.name}` : item.name;
            out.push(Object.assign({}, item, { hierarchicalName: displayName }));
            if (item.children && item.children.length) walk(item.children, displayName);
        });
    }
    walk(nodes, prefix);
    return out;
}


// ============================================================
// LOCATION HIERARCHY HELPERS
// ============================================================

// Find a location anywhere in the hierarchy.
function findLocationById(locationId, nodes = state.locations) {
    if (!locationId) return null;

    for (const loc of (nodes || [])) {
        if (String(loc.id) === String(locationId)) return loc;

        const found = findLocationById(locationId, loc.children || []);
        if (found) return found;
    }

    return null;
}

// Return selected parent and its descendants for dropdowns.
function getLocationBranch(parentId, recursive = true) {
    const parent = findLocationById(parentId);
    if (!parent) return [];

    const result = [{
        id: String(parent.id),
        name: parent.name,
        depth: 0,
        parentId: null
    }];

    function addChildren(node, depth) {
        (node.children || []).forEach((child) => {
            result.push({
                id: String(child.id),
                name: child.name,
                depth,
                parentId: String(node.id)
            });

            if (recursive) addChildren(child, depth + 1);
        });
    }

    addChildren(parent, 1);
    return result;
}

// Fill a native select with a parent and its child locations.
function fillLocationBranch(select, parentId, selectedId) {
    if (!select) return '';

    const options = getLocationBranch(parentId, true);
    select.innerHTML = '';

    options.forEach((loc) => {
        const indent = '\u00A0\u00A0'.repeat(loc.depth);
        const prefix = loc.depth ? '• ' : '';

        select.appendChild(
            new Option(indent + prefix + loc.name, loc.id)
        );
    });

    const valid = options.some(
        (loc) => String(loc.id) === String(selectedId)
    );

    select.value = valid
        ? String(selectedId)
        : (options[0] ? options[0].id : '');

    if (select._sync) select._sync();

    return select.value;
}

// Return only root/parent locations.
function getRootLocations() {
    return state.locations || [];
}




function discountApiValue(v) {
    const d = DISCOUNT_TYPES.find((x) => x.value === v);
    return d ? d.api : 'entity_level';
}

function initModeDefaults() {
    const so = state.salesOrder || {}, m = state.mode, lines = so.lineItems || [];
    m.taxInclusive = so.isInclusiveTax === true;
    m.discountBeforeTax = so.discountBeforeTax !== false;

    const raw = so.discountRaw == null ? '' : String(so.discountRaw);
    const entVal = parseFloat(raw) || 0;
    const hasLineDisc = lines.some((l) => l.discount > 0);
    const dt = String(so.discountTypeRaw || '');

    if (dt === 'item_level') m.discountType = 'item_level';
    else if (dt === 'entity_level') m.discountType = 'entity_level';
    else if (entVal > 0 && hasLineDisc) m.discountType = 'both';
    else if (hasLineDisc) m.discountType = 'item_level';
    else m.discountType = 'entity_level';

    m.txValue = (m.discountType !== 'item_level' && entVal > 0) ? entVal : 0;
    m.txUnit = raw.indexOf('%') > -1 ? 'pct' : 'amt';

    const ids = new Set(lines.map((l) => l.locationId).filter((id) => id && flatLocations().some((x) => x.id === id)));
    m.selection = ids.size > 1 ? 'multiple' : 'single';

    log('MODE', 'Defaults read from Sales Order', {
        is_inclusive_tax: so.isInclusiveTax, discount_type: dt, discount: raw,
        is_discount_before_tax: so.discountBeforeTax, resolved: Object.assign({}, m)
    });
}

function injectModeCss() {
    if ($('mode-styles')) return;
    const s = document.createElement('style');
    s.id = 'mode-styles';
    s.textContent = `
    /* ITEM TOOLBAR — SINGLE LINE LAYOUT */
    #item-toolbar {
        display: flex;
        flex-wrap: nowrap;
        align-items: center;
        gap: 12px;
        width: 100%;
        min-width: 0;
        overflow-x: auto;
        white-space: nowrap;
        padding: 4px 0 8px;
    }
    
    #item-toolbar .tb-item {
        display: flex;
        align-items: center;
        gap: 7px;
        flex: 0 0 auto;
        min-width: 0;
    }
    
    #item-toolbar .tb-lbl {
        color: #777;
        margin: 0;
        white-space: nowrap;
        font-size: 12px;
    }
    
    #item-toolbar .lk {
        width: auto;
        min-width: 130px;
        max-width: 190px;
        flex: 0 1 190px;
    }
    
    #item-toolbar .lk-box {
        background: transparent;
        border: 0;
        border-bottom: 1px dashed #9aa3b2;
        border-radius: 0;
        min-height: 30px;
        box-shadow: none;
    }
    
    #item-toolbar .tb-item.plain .lk-box {
        border-bottom: 0;
    }
    
    #item-toolbar .lk-text {
        padding: 5px 24px 5px 6px;
        font-size: 13px;
    }
    
    #item-toolbar .tb-sep {
        flex: 0 0 1px;
        height: 28px;
        background: #e0e0e0;
    }
    
    .row-loc {
        margin-top: 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        color: #7a8494;
    }
    
    .row-loc .loc-select {
        flex: 1;
        min-width: 0;
        padding: 5px 8px;
        border: 1px solid #d0d5dc;
        border-radius: 4px;
        background: #fff;
        font: inherit;
        font-size: 12px;
    }
    
    #tx-disc-row td:first-child {
        color: #666;
    }
    
    .tx-disc-wrap {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
    }
    
    .tx-disc-wrap input {
        width: 80px;
        padding: 5px 8px;
        border: 1px solid #d0d5dc;
        border-radius: 4px;
        text-align: right;
        font: inherit;
        font-size: 13px;
    }
    
    .tx-disc-wrap select {
        padding: 5px 6px;
        border: 1px solid #d0d5dc;
        border-radius: 4px;
        font: inherit;
        font-size: 13px;
        background: #fff;
    }
    
    @media (max-width: 900px) {
        #item-toolbar {
            gap: 8px;
        }
    
        #item-toolbar .lk {
            min-width: 110px;
            max-width: 150px;
        }
    }`;
    document.head.appendChild(s);
}


function buildItemToolbar(sec) {
    if ($('item-toolbar')) return;

    injectModeCss();
    initModeDefaults();

    const bar = document.createElement('div');
    bar.id = 'item-toolbar';

    bar.innerHTML =
        '<div class="tb-item" id="tb-wh-wrap">' +
        '<span class="tb-lbl">Warehouse Location</span>' +
        '<select id="tb-wh"></select>' +
        '</div>' +
        '<span class="tb-sep" id="tb-sep1"></span>' +
        // '<div class="tb-item" id="tb-sel-wrap" title="Single: use selected warehouse. Multiple: choose a warehouse per line.">' +
        // '<span class="tb-lbl">Selection Type</span>' +
        // '<select id="tb-sel"></select>' +
        // '<span class="tot-help" title="Single: use selected warehouse. Multiple: choose a warehouse per line.">&#9432;</span>' +
        // '</div>' +
        // '<span class="tb-sep"></span>' +
        '<div class="tb-item plain">' +
        '<span class="rate-calc-icon" title="Tax Mode">税</span>' +
        '<select id="tb-tax"></select>' +
        '</div>' +
        '<span class="tb-sep"></span>' +
        '<div class="tb-item plain">' +
        '<span class="rate-calc-icon" title="Discount Mode">%</span>' +
        '<select id="tb-disc"></select>' +
        '</div>';

    sec.parentNode.insertBefore(bar, sec);

    const m = state.mode;
    const wh = $('tb-wh');
    const loc = $('po-location');

    // Selection Type field is hidden from the UI: always use "single" location mode
    m.selection = 'single';

    if (!state.locations.length || !loc) {
        $('tb-wh-wrap').hidden = true;
        // $('tb-sel-wrap').hidden = true;
        $('tb-sep1').hidden = true;
    } else {
        // Third field: selected parent + child locations.
        fillLocationBranch(wh, loc.value, loc.value);

        lkEnhance(wh, {
            placeholder: 'Select warehouse',
            emptyText: 'No warehouses found'
        });

        wh.addEventListener('change', () => {
            markDirty();
            refreshItemLineLocations();
            refreshStockInfo();
        });

        // const sel = $('tb-sel');
        //
        // nvFill(
        //     sel,
        //     SELECTION_TYPES.map((x) => [x.value, x.label]),
        //     null
        // );
        //
        // sel.value = m.selection;
        // lkEnhance(sel, {});
        //
        // sel.addEventListener('change', () => {
        //     m.selection = sel.value;
        //     markDirty();
        //     applyItemModes();
        // });
    }
    const tax = $('tb-tax');

    nvFill(
        tax,
        TAX_MODES.map((x) => [x.value, x.label]),
        null
    );

    tax.value = m.taxInclusive ? 'inclusive' : 'exclusive';
    lkEnhance(tax, {});

    tax.addEventListener('change', () => {
        m.taxInclusive = tax.value === 'inclusive';
        markDirty();
        applyItemModes();
    });

    const disc = $('tb-disc');
    disc.innerHTML = '';
    const grp = document.createElement('optgroup');
    grp.label = 'Discount Type';
    DISCOUNT_TYPES.forEach((x) => grp.appendChild(new Option(x.label, x.value)));
    disc.appendChild(grp);
    disc.value = m.discountType;
    lkEnhance(disc, {});

    disc.addEventListener('change', () => {
        m.discountType = disc.value;
        markDirty();
        applyItemModes();
    });

    initDiscountUi();
}






// ============================================================
// THIRD FIELD: WAREHOUSE LOCATION
// ============================================================

function refreshWarehouseLocation() {
    const wh = $('tb-wh');
    const parent = $('po-location');

    if (!wh || !parent) return;

    const parentId = parent.value;
    const previous = wh.value;

    // Show selected parent + its children.
    fillLocationBranch(wh, parentId, previous || parentId);

    // If the previous selection doesn't belong to this parent,
    // use the selected parent as the default warehouse.
    if (!wh.value && parentId) {
        wh.value = parentId;
        if (wh._sync) wh._sync();
    }

    refreshItemLineLocations();
}


function ensureTxDiscountRow() {
    let r = $('tot-discount-row') || $('tx-disc-row');
    if (r) return r;
    r = document.createElement('tr');
    r.id = 'tx-disc-row';
    r.innerHTML = '<td>Transaction Discount</td><td><div class="tx-disc-wrap">' +
        '<input type="number" id="tx-disc" min="0" step="0.01">' +
        '<select id="tx-disc-unit"><option value="pct">%</option><option value="amt">Amount</option></select></div></td>';
    const subTr = dom.totalSubtotal ? dom.totalSubtotal.closest('tr') : null;
    if (subTr) subTr.after(r);
    else if (dom.totalSubtotal && dom.totalSubtotal.parentElement) dom.totalSubtotal.parentElement.after(r);
    if ($('tx-disc')) $('tx-disc').value = String(state.mode.txValue || 0);
    if ($('tx-disc-unit')) $('tx-disc-unit').value = state.mode.txUnit;
    const onCh = () => { markDirty(); recalculateAllAmounts(); };
    if ($('tx-disc')) $('tx-disc').addEventListener('input', onCh);
    if ($('tx-disc-unit')) $('tx-disc-unit').addEventListener('change', onCh);
    return r;
}

function readTxDiscount() {
    const i = $('tx-disc');
    if (!i || state.mode.discountType === 'item_level') return { value: 0, pct: false };
    return { value: parseFloat(i.value) || 0, pct: $('tx-disc-unit').value === 'pct' };
}

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function curSym() {
    return (state.salesOrder && state.salesOrder.currencySymbol) ||
        (state.org && state.org.currency_symbol) || '₹';
}

function syncDiscountTiming() {
    const l = $('tx-disc-timing');
    if (l) l.textContent = state.mode.discountBeforeTax ? 'Apply after tax' : 'Apply before tax';
}

/** Seeds the totals-card discount controls from the Sales Order and wires the before/after-tax link. */
function initDiscountUi() {
    const m = state.mode;
    const val = $('tx-disc'), unit = $('tx-disc-unit'), link = $('tx-disc-timing');

    if (unit) {
        unit.innerHTML = '';
        unit.appendChild(new Option('%', 'pct'));
        unit.appendChild(new Option(curSym(), 'amt'));
        unit.value = m.txValue > 0 ? m.txUnit : 'pct';
    }
    if (val) val.value = String(m.txValue || 0);

    if (link && link.dataset.wired !== '1') {
        link.dataset.wired = '1';
        link.addEventListener('click', () => {
            m.discountBeforeTax = !m.discountBeforeTax;
            syncDiscountTiming();
            markDirty();
            recalculateAllAmounts();
        });
    }
    syncDiscountTiming();
}

/** Discount column cell: value + %/amount unit. Values live in the DOM, so they survive mode switches. */
function buildDiscountCell(init) {
    const td = document.createElement('td');
    td.className = 'disc-cell col-disc';

    const pct = !!init.pct || !(parseFloat(init.value) > 0);   // Zoho defaults to %
    const wrap = document.createElement('div');
    wrap.className = 'discount-wrap';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'cell-input discount-input';
    input.min = '0';
    input.step = '0.01';
    input.value = init.value ? String(init.value) : '0';
    input.dataset.pct = pct ? '1' : '0';
    input.addEventListener('input', onAmountChange);

    const mode = document.createElement('select');
    mode.className = 'disc-mode';
    mode.appendChild(new Option('%', 'pct'));
    mode.appendChild(new Option(curSym(), 'amt'));
    mode.value = pct ? 'pct' : 'amt';
    mode.addEventListener('change', () => {
        input.dataset.pct = mode.value === 'pct' ? '1' : '0';
        onAmountChange({ target: input });
    });

    wrap.appendChild(input);
    wrap.appendChild(mode);
    td.appendChild(wrap);
    return td;
}

function ensureRowLocation(tr, multi) {
    let box = tr.querySelector('.row-loc');

    if (!multi) {
        if (box) box.hidden = true;
        return;
    }

    const td = tr.querySelector('.qty-cell');
    if (!td) return;

    const id = tr.dataset.lineItemId;

    const soItem =
        (state.salesOrder.lineItems || []).find(
            (li) => li.lineItemId === id
        ) ||
        state.extra[id] ||
        {};

    if (!box) {
        box = document.createElement('div');
        box.className = 'row-loc';

        const label = document.createElement('span');
        label.textContent = 'Location';

        const sel = document.createElement('select');
        sel.className = 'loc-select';

        const all = document.createElement('button');
        all.type = 'button';
        all.className = 'apply-all';
        all.textContent = 'Apply to all';
        all.title = 'Apply this warehouse to all item lines';

        sel.addEventListener('change', () => {
            if (state.extra[id]) {
                state.extra[id].locationId = sel.value;
            }

            sel.classList.remove('error');
            markDirty();
        });

        all.addEventListener('click', () => {
            const selectedId = sel.value;

            if (!selectedId) return;

            dom.itemsTbody
                .querySelectorAll('tr[data-line-item-id]')
                .forEach((row) => {
                    const other = row.querySelector('.loc-select');
                    if (!other) return;

                    const valid = Array.from(other.options).some(
                        (o) => String(o.value) === String(selectedId)
                    );

                    if (valid) {
                        other.value = selectedId;

                        const rowId = row.dataset.lineItemId;

                        if (state.extra[rowId]) {
                            state.extra[rowId].locationId = selectedId;
                        }

                        other.classList.remove('error');
                    }
                });

            markDirty();
        });

        box.appendChild(label);
        box.appendChild(sel);
        box.appendChild(all);

        td.appendChild(box);
    }

    const sel = box.querySelector('.loc-select');

    // Use the third Warehouse Location selection as the default.
    const warehouse = $('tb-wh');
    const defaultWarehouse = warehouse
        ? warehouse.value
        : ($('po-location') ? $('po-location').value : '');

    const previous =
        sel.value ||
        soItem.locationId ||
        defaultWarehouse;

    fillLocationBranch(
        sel,
        $('po-location') ? $('po-location').value : '',
        previous
    );

    // If the SO line location is outside the selected parent branch,
    // default to the selected warehouse instead.
    if (
        !Array.from(sel.options).some(
            (o) => String(o.value) === String(previous)
        )
    ) {
        sel.value = defaultWarehouse;
    }

    if (state.extra[id]) {
        state.extra[id].locationId = sel.value;
    }

    box.hidden = false;
}



function refreshItemLineLocations() {
    if (!dom.itemsTbody) return;

    const multi = state.mode.selection === 'multiple' &&
        state.locations.length > 0;

    dom.itemsTbody
        .querySelectorAll('tr[data-line-item-id]')
        .forEach((tr) => {
            const box = tr.querySelector('.row-loc');

            if (box && multi) {
                // Rebuild the existing row selector for the new parent.
                const sel = box.querySelector('.loc-select');
                const previous = sel ? sel.value : '';

                if (sel) {
                    const parentId = $('po-location').value;
                    const allowed = getLocationBranch(parentId, true);

                    const valid = allowed.some(
                        (l) => String(l.id) === String(previous)
                    );

                    fillLocationBranch(
                        sel,
                        parentId,
                        valid ? previous : ($('tb-wh') ? $('tb-wh').value : parentId)
                    );

                    const rowId = tr.dataset.lineItemId;

                    if (state.extra[rowId]) {
                        state.extra[rowId].locationId = sel.value;
                    }
                }
            }

            ensureRowLocation(tr, multi);
        });
}



function applyItemModes() {
    const m = state.mode;
    const showLine = m.discountType !== 'entity_level';
    const showTx = m.discountType !== 'item_level';
    const multi = m.selection === 'multiple' && state.locations.length > 0;

    const table = $('items-table');
    if (table) table.classList.toggle('hide-disc', !showLine);   // Discount column only for line-level modes

    dom.itemsTbody.querySelectorAll('tr[data-line-item-id]').forEach((tr) => {
        ensureRowLocation(tr, multi);
    });

    ensureTxDiscountRow().hidden = !showTx;                      // totals Discount row only for transaction-level modes

    const taxLabel = dom.totalTax ? dom.totalTax.previousElementSibling : null;
    if (taxLabel && taxLabel.tagName === 'TD') taxLabel.textContent = m.taxInclusive ? 'Tax (included)' : 'Tax';

    refreshStockInfo();
    recalculateAllAmounts();
}


// ============================================================
// STOCK INFO (read from the Zoho item record, nothing hardcoded)
// ============================================================

function pickNum(o, keys) {
    for (const k of keys) {
        if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    }
    return undefined;
}

function stockInfoHtml(master, unit) {
    if (!master || !master.track_inventory) return '';
    const locId = $('po-location') ? $('po-location').value : '';
    const loc = (master.locations || []).find((l) => String(l.location_id) === String(locId));
    const qty = loc
        ? pickNum(loc, ['location_available_for_sale_stock', 'location_actual_available_for_sale_stock', 'location_available_stock', 'location_stock_on_hand'])
        : pickNum(master, ['available_for_sale_stock', 'actual_available_for_sale_stock', 'available_stock', 'stock_on_hand']);
    if (qty === undefined) return '';
    const u = unit || master.unit || '';
    return '<span class="zb-stock-lbl">Available for Sale:</span>' +
        '<span class="zb-stock-val">' + escapeHtml(String(qty)) + (u ? ' ' + escapeHtml(u) : '') + '</span>' +
        (loc && loc.location_name ? '<span class="zb-stock-loc">' + escapeHtml(loc.location_name) + '</span>' : '');
}

function refreshStockInfo() {
    const loc = $('po-location');
    if (loc && !loc.dataset.stk) { loc.dataset.stk = '1'; loc.addEventListener('change', refreshStockInfo); }
    if (!state.salesOrder) return;

    dom.itemsTbody.querySelectorAll('tr[data-line-item-id]').forEach((tr) => {
        const old = tr.querySelector('.zb-stock-info');
        if (old) old.remove();
        const id = tr.dataset.lineItemId;
        const so = state.salesOrder.lineItems.find((li) => li.lineItemId === id);
        const x = state.extra[id];
        const itemId = (so && so.itemId) || (x && x.itemId) || '';
        const html = stockInfoHtml(itemId ? state.itemMaster[itemId] : null, (so && so.unit) || (x && x.unit) || '');
        const td = tr.querySelector('.qty-cell');
        if (!html || !td) return;
        const d = document.createElement('div');
        d.className = 'zb-stock-info';
        d.innerHTML = html;
        const wrap = td.querySelector('.qty-control-wrap');
        if (wrap) wrap.after(d); else td.appendChild(d);
    });
}

// ============================================================
// PURCHASE ORDER FETCHING & ALLOCATION ENGINE
// ============================================================

async function getAllPurchaseOrders(referenceNumber) {
    let all = [];
    let page = 1;
    let hasMore = true;
    const normRef = referenceNumber ? String(referenceNumber).trim() : '';
    let useServerFilter = !!normRef;

    while (hasMore && page <= 50) {
        log('PO_FETCH', `Page ${page}${useServerFilter ? ` (filtering reference_number: ${normRef})` : ''}`);
        const queryParams = [
            { key: 'page', value: String(page) },
            { key: 'per_page', value: String(PER_PAGE) }
        ];
        if (useServerFilter) queryParams.push({ key: 'reference_number', value: normRef });

        try {
            const response = await ZFAPPS.request({
                url: `${state.apiRootEndPoint}/purchaseorders`,
                method: 'GET',
                url_query: withOrgId(queryParams),
                header: [{ key: 'Accept', value: 'application/json' }],
                connection_link_name: CONNECTION_LINK_NAME
            });

            let data;
            try {
                data = JSON.parse(response.data.body);
            } catch (e) {
                throw new Error('Failed to parse PO response: ' + e.message);
            }

            if (data.code !== 0) {
                if (useServerFilter && page === 1) {
                    log('PO_FETCH', 'Server-side reference_number filter returned code ' + data.code + ', falling back to full scan.');
                    useServerFilter = false;
                    continue;
                }
                throw new Error(data.message || 'Failed to fetch Purchase Orders.');
            }

            all = all.concat(data.purchaseorders || []);
            hasMore = (data.page_context || {}).has_more_page === true;
            page++;
        } catch (err) {
            if (useServerFilter && page === 1) {
                log('PO_FETCH', 'Server-side reference_number filter request failed: ' + err.message + ', falling back to full scan.');
                useServerFilter = false;
                continue;
            }
            throw err;
        }
    }

    log('PO_FETCH', `Total fetched (summary/list records): ${all.length}`);
    return all;
}

async function fetchPurchaseOrderDetails(purchaseOrderId) {
    const response = await ZFAPPS.request({
        url: `${state.apiRootEndPoint}/purchaseorders/${purchaseOrderId}`,
        method: 'GET',
        url_query: withOrgId(),
        header: [{ key: 'Accept', value: 'application/json' }],
        connection_link_name: CONNECTION_LINK_NAME
    });

    const rawBody = response && response.data && response.data.body;

    if (typeof rawBody === 'string' && rawBody.trim().startsWith('<')) {
        logError('PO_DETAIL', `Received HTML instead of JSON for PO ${purchaseOrderId}`, rawBody);
        throw new Error(`Received HTML (print template) instead of JSON for PO ${purchaseOrderId}.`);
    }

    let data;
    try {
        data = JSON.parse(rawBody);
    } catch (e) {
        logError('PO_DETAIL', `Non-JSON response for PO ${purchaseOrderId}`, rawBody);
        throw new Error(`Failed to parse PO detail response for ${purchaseOrderId}: ` + e.message);
    }

    if (data.code !== 0) {
        throw new Error(data.message || `Failed to fetch Purchase Order ${purchaseOrderId}.`);
    }

    return data.purchaseorder;
}

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
                logError('PO_DETAIL', `Failed to fetch detail for PO ${po.purchaseorder_id}`, err);
                throw new Error(
                    `Failed to verify line items for existing Purchase Order "${po.purchaseorder_number || po.purchaseorder_id}". ` +
                    `Allocation stopped to prevent over-purchasing. (${err.message || 'Network/Server Error'})`
                );
            }
        })
    );

    return detailed.filter(Boolean);
}

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
        logError('PO_LINES', 'Related POs found but none had line items.', relatedPOs);
        return;
    }

    log('PO_LINES', `Printing ${rows.length} line item(s) across ${relatedPOs.length} PO(s):`);
    if (console.table) console.table(rows);
    else rows.forEach((r) => console.log(r));
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
                target = Object.values(allocations).find((a) => a.lineItemId === poLine.salesorder_item_id);
            }
            if (target) {
                target.allocatedQuantity = parseFloat((target.allocatedQuantity + poQty).toFixed(6));
            } else if (poLine.item_id) {
                const candidates = Object.values(allocations).filter((a) => a.itemId === poLine.item_id);
                if (candidates.length === 0) {
                    logError('ALLOCATION', 'Unmatched PO line item — could not link to any SO line', {
                        purchaseorder_number: po.purchaseorder_number,
                        poLine
                    });
                    return;
                }
                let remainingPoQty = poQty;
                for (const cand of candidates) {
                    const availableCapacity = Math.max(0, parseFloat((cand.salesOrderQuantity - cand.allocatedQuantity).toFixed(6)));
                    if (availableCapacity > 0) {
                        const allocate = Math.min(remainingPoQty, availableCapacity);
                        cand.allocatedQuantity = parseFloat((cand.allocatedQuantity + allocate).toFixed(6));
                        remainingPoQty = parseFloat((remainingPoQty - allocate).toFixed(6));
                        if (remainingPoQty <= 0) break;
                    }
                }
                if (remainingPoQty > 0) {
                    const lastCand = candidates[candidates.length - 1];
                    lastCand.allocatedQuantity = parseFloat((lastCand.allocatedQuantity + remainingPoQty).toFixed(6));
                }
            } else {
                logError('ALLOCATION', 'Unmatched PO line item without item_id or salesorder_item_id', {
                    purchaseorder_number: po.purchaseorder_number,
                    poLine
                });
            }
        });
    });

    Object.values(allocations).forEach((a) => {
        const remaining = parseFloat((a.salesOrderQuantity - a.allocatedQuantity).toFixed(6));
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
// CENTRAL API HELPER
// ============================================================

async function zbApi(method, path, query, body, retries = 2) {
    const q = withOrgId(Object.keys(query || {}).map((k) => ({ key: k, value: String(query[k]) })));
    const opts = {
        url: `${state.apiRootEndPoint}${path}`,
        method,
        url_query: q,
        header: [{ key: 'Accept', value: 'application/json' }],
        connection_link_name: CONNECTION_LINK_NAME
    };
    if (body) {
        opts.header.push({ key: 'Content-Type', value: 'application/json' });
        opts.body = { mode: 'raw', raw: JSON.stringify(body) };
    }

    let lastErr = null;
    const maxAttempts = (method.toUpperCase() === 'GET') ? (1 + retries) : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await ZFAPPS.request(opts);
            const rawBody = res && res.data && res.data.body;

            if (typeof rawBody === 'string' && rawBody.trim().startsWith('<')) {
                throw new Error(`Received HTML instead of JSON from ${path}.`);
            }

            let data;
            try {
                data = JSON.parse(rawBody);
            } catch (e) {
                throw new Error('Unreadable response from Zoho Books (' + path + '): ' + e.message);
            }

            if (data.code !== undefined && Number(data.code) !== 0) {
                throw new Error(data.message || ('Zoho Books error code ' + data.code + ' on ' + path));
            }
            return data;
        } catch (err) {
            lastErr = err;
            let msg = err.message || 'Request failed';
            try {
                if (err.data && err.data.body) {
                    const parsed = JSON.parse(err.data.body);
                    if (parsed.message) msg = parsed.message;
                }
            } catch (_) { }
            lastErr = new Error(msg);

            if (method.toUpperCase() === 'GET' && attempt < maxAttempts) {
                log('API_RETRY', `Retrying ${method} ${path} (attempt ${attempt + 1}/${maxAttempts}) after error: ${msg}`);
                await new Promise((r) => setTimeout(r, 600 * attempt));
            } else {
                break;
            }
        }
    }
    throw lastErr;
}

function normVendor(v) {
    const name = v.contact_name || '';
    const company = v.company_name || '';
    const email = v.email || '';
    const phone = v.phone || v.mobile || '';
    return {
        id: String(v.contact_id),
        number: v.contact_number || v.vendor_number || '',
        name,
        companyName: company,
        email,
        phone,
        contactType: String(v.contact_type || '').toLowerCase(),
        paymentTerms: (v.payment_terms != null && v.payment_terms !== '') ? v.payment_terms : '',
        paymentTermsLabel: v.payment_terms_label,
        _k: (name + ' ' + company + ' ' + email + ' ' + phone).toLowerCase()
    };
}

async function fetchVendors(searchText) {
    let all = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 50) {
        const q = {
            contact_type: 'vendor',
            filter_by: 'Status.Active',
            page,
            per_page: PER_PAGE,
            sort_column: 'contact_name'
        };
        if (searchText) q.search_text = searchText;

        log('VENDOR', `Fetching vendors page ${page}...`);
        const data = await zbApi('GET', '/contacts', q);
        all = all.concat(data.contacts || []);
        hasMore = (data.page_context || {}).has_more_page === true;
        page++;
    }

    const vendors = all
        .filter((c) => !c.contact_type || String(c.contact_type).toLowerCase() === 'vendor')
        .map(normVendor); log('VENDOR', `Received ${vendors.length} vendors`);
    return vendors;
}

async function fetchVendorById(contactId) {
    if (!contactId) return null;
    log('VENDOR', 'Fetching by ID: ' + contactId);
    const c = await vaFetchContact(String(contactId));   // shared, cached request
    return c ? normVendor(c) : null;
}



// ============================================================
// CACHE ENGINE: IndexedDB + memory + paginated sources
// ============================================================
const ZC = { db: null, opening: null };
const CACHE_PAGE = 200;

function zcOpen() {
    if (ZC.db) return Promise.resolve(ZC.db);
    if (ZC.opening) return ZC.opening;
    ZC.opening = new Promise((resolve) => {
        if (!window.indexedDB) return resolve(null);
        let req;
        try { req = indexedDB.open('zb_widget_cache', 1); } catch (e) { return resolve(null); }
        req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore('records', { keyPath: 'key' }).createIndex('scope', 'scope');
            db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => {
            ZC.db = req.result;
            ZC.db.onversionchange = () => { ZC.db.close(); ZC.db = null; ZC.opening = null; };
            resolve(ZC.db);
        };
        req.onerror = req.onblocked = () => resolve(null);      // no IndexedDB: memory-only mode
    });
    return ZC.opening;
}

function zcTx(stores, mode, fn) {
    return zcOpen().then((db) => !db ? null : new Promise((resolve) => {
        try {
            const tx = db.transaction(stores, mode);
            const r = fn(tx);
            tx.oncomplete = () => resolve(r && typeof r === 'object' && 'result' in r ? r.result : undefined);
            tx.onerror = tx.onabort = () => resolve(null);
        } catch (e) { resolve(null); }
    }));
}

const zcScope = (entity) => state.organizationId + '|' + entity;            // isolates cache per organization
const zcGetAll = (entity) => zcTx(['records'], 'readonly', (tx) => tx.objectStore('records').index('scope').getAll(zcScope(entity)))
    .then((rows) => (rows || []).map((r) => r.rec));
const zcGetOne = (entity, id) => zcTx(['records'], 'readonly', (tx) => tx.objectStore('records').get(zcScope(entity) + '|' + id))
    .then((r) => (r ? r.rec : null));
const zcPut = (entity, recs, idOf) => !recs.length ? Promise.resolve() : zcTx(['records'], 'readwrite', (tx) => {
    const s = tx.objectStore('records');
    recs.forEach((rec) => s.put({ key: zcScope(entity) + '|' + idOf(rec), scope: zcScope(entity), rec }));
});
const zcDel = (entity, id) => zcTx(['records'], 'readwrite', (tx) => { tx.objectStore('records').delete(zcScope(entity) + '|' + id); });
const zcClear = (entity) => zcTx(['records', 'meta'], 'readwrite', (tx) => {
    const s = tx.objectStore('records');
    const c = s.index('scope').openKeyCursor(IDBKeyRange.only(zcScope(entity)));
    c.onsuccess = () => { const cur = c.result; if (cur) { s.delete(cur.primaryKey); cur.continue(); } };
    tx.objectStore('meta').delete(zcScope(entity));
});
const zcMetaGet = (entity) => zcTx(['meta'], 'readonly', (tx) => tx.objectStore('meta').get(zcScope(entity)));
const zcMetaSet = (entity, m) => zcTx(['meta'], 'readwrite', (tx) => { tx.objectStore('meta').put(Object.assign({ key: zcScope(entity) }, m)); });
const zcBlobGet = (name) => zcMetaGet('blob:' + name);
const zcBlobSet = (name, data) => zcMetaSet('blob:' + name, { data, updatedAt: Date.now() });

/**
 * A paginated, cached list.
 * cfg: { entity, idOf(rec), compare(a,b), fetchPage(page, perPage, search) -> {records, hasMore}, pageSize, ttl, maxAge }
 * Records must have .name and ._k (lowercase search text).
 */

function createSource(cfg) {
    const pageSize = cfg.pageSize || CACHE_PAGE;
    const ttl = cfg.ttl || 5 * 60 * 1000;

    const S = {
        map: new Map(),
        nextPage: 1,
        hasMore: true,
        updatedAt: 0,
        epoch: 0,
        hydrated: null,
        initP: null,
        inflight: new Map(),
        searches: new Map(),
        sorted: null
    };

    const api = { onChange: null };

    const norm = (s) =>
        String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

    function touch() {
        S.sorted = null;
        if (typeof api.onChange === 'function') api.onChange();
    }

    function saveMeta() {
        return zcMetaSet(cfg.entity, {
            nextPage: S.nextPage,
            hasMore: S.hasMore,
            updatedAt: S.updatedAt
        });
    }

    function dedupe(key, fn) {
        if (S.inflight.has(key)) return S.inflight.get(key);

        const promise = Promise.resolve()
            .then(fn)
            .finally(() => {
                if (S.inflight.get(key) === promise) {
                    S.inflight.delete(key);
                }
            });

        S.inflight.set(key, promise);
        return promise;
    }

    function merge(records) {
        let changed = false;

        (records || []).forEach((record) => {
            const id = cfg.idOf(record);
            if (!id) return;

            S.map.set(String(id), record);
            changed = true;
        });

        if (changed) touch();
    }
    async function hydrate() {
        if (S.hydrated) return S.hydrated;
    
        S.hydrated = (async () => {
            if (cfg.keepCache) {
                const [rows, meta] = await Promise.all([zcGetAll(cfg.entity), zcMetaGet(cfg.entity)]);
                const age = meta && meta.updatedAt ? Date.now() - meta.updatedAt : Infinity;
    
                if (rows.length && age < ttl) {
                    // Cache is still fresh: show it instantly, continue from where the last load stopped
                    rows.forEach((r) => {
                        const id = cfg.idOf(r);
                        if (id) S.map.set(String(id), r);
                    });
                    S.sorted = null;
                    S.nextPage = meta.nextPage || 1;
                    S.hasMore = meta.hasMore !== false;
                    S.updatedAt = meta.updatedAt;
                    touch();
                    return;
                }
            }
    
            // Original behaviour: start clean
            await zcClear(cfg.entity);
            S.map.clear();
            S.sorted = null;
            S.nextPage = 1;
            S.hasMore = true;
            S.updatedAt = 0;
            S.searches.clear();
        })().catch((err) => {
            S.hydrated = null;
            throw err;
        });
    
        return S.hydrated;
    }
    async function loadPage(page, search, epoch) {
        const result = await cfg.fetchPage(page, pageSize, search || '');
    
        if (epoch !== S.epoch) return null;
    
        const records = Array.isArray(result.records) ? result.records : [];
    
        merge(records);                          // one render for the whole page
        zcPut(cfg.entity, records, cfg.idOf);    // cache write runs in the background
    
        return {
            records,
            hasMore: result.hasMore === true
        };
    }

    function all() {
        if (!S.sorted) {
            S.sorted = Array.from(S.map.values());

            if (typeof cfg.compare === 'function') {
                S.sorted.sort(cfg.compare);
            }
        }

        return S.sorted.slice();
    }

    function view(search) {
        const query = norm(search);
        const records = all();

        if (!query) return records;

        return records.filter((record) => {
            const searchable = norm(
                record._k || record.name || ''
            );

            return searchable.includes(query);
        });
    }

    function canMore(search) {
        const query = norm(search);

        if (!query) return S.hasMore;

        const searchState = S.searches.get(query);

        return !searchState || searchState.hasMore;
    }

    function loadMore(search) {
        const query = norm(search);

        // Main pagination
        if (!query) {
            if (!S.hasMore) return Promise.resolve(false);
        
            return dedupe('main', async () => {
                await hydrate();
        
                // wait for the initial load so page 1 is never fetched twice
                if (S.initP) { try { await S.initP; } catch (e) { /* retry below */ } }
        
                if (!S.hasMore) return false;
        
                const epoch = S.epoch;
                const page = S.nextPage;
        
                const result = await loadPage(page, '', epoch);
        
                if (!result) return false;
        
                S.nextPage = page + 1;
                S.hasMore = result.hasMore;
                S.updatedAt = Date.now();
        
                await saveMeta();
        
                return result.records.length > 0;
            });
        }

        // Independent server-search pagination
        let searchState = S.searches.get(query);

        if (!searchState) {
            searchState = {
                nextPage: 1,
                hasMore: true
            };

            S.searches.set(query, searchState);
        }

        if (!searchState.hasMore) {
            return Promise.resolve(false);
        }

        return dedupe('search:' + query, async () => {
            const epoch = S.epoch;
            const page = searchState.nextPage;

            const result = await loadPage(
                page,
                String(search).trim(),
                epoch
            );

            if (!result) return false;

            searchState.nextPage = page + 1;
            searchState.hasMore = result.hasMore;

            return result.records.length > 0;
        });
    }



    /** Fetches `count` consecutive pages in parallel (main list only, no search). */
function loadBatch(count) {
    if (!S.hasMore) return Promise.resolve(false);

    return dedupe('main', async () => {
        await hydrate();
        if (S.initP) { try { await S.initP; } catch (e) { /* retry below */ } }
        if (!S.hasMore) return false;

        const epoch = S.epoch;
        const start = S.nextPage;

        const results = await Promise.all(
            Array.from({ length: count }, (_, i) =>
                cfg.fetchPage(start + i, pageSize, '').catch((err) => {
                    if (i === 0) throw err;      // first page failing = real error
                    return null;                 // later page failing = retry it next round
                })
            )
        );
        if (epoch !== S.epoch) return false;

        let pages = 0, more = true;
        for (const r of results) {
            if (!r) break;
            const recs = Array.isArray(r.records) ? r.records : [];
            merge(recs);
            zcPut(cfg.entity, recs, cfg.idOf);
            pages++;
            if (r.hasMore !== true) { more = false; break; }
        }

        S.nextPage = start + pages;
        S.hasMore = more;
        S.updatedAt = Date.now();
        await saveMeta();
        return pages > 0;
    });
}

    async function revalidate(force) {
        await hydrate();
    
        const stale =
            !S.updatedAt ||
            Date.now() - S.updatedAt > ttl;
    
        if (!force && !stale && S.map.size) {
            return false;
        }
    
        return dedupe('refresh', async () => {
            const epoch = S.epoch;
    
            if (force) {
                await zcClear(cfg.entity);
                S.map.clear();
                S.sorted = null;
                S.searches.clear();
            }
    
            const result = await loadPage(1, '', epoch);
    
            if (!result) return false;
    
            S.nextPage = 2;
            S.hasMore = result.hasMore;
            S.updatedAt = Date.now();
    
            await saveMeta();
    
            return true;
        });
    }

    async function init(force) {
        if (S.initP && !force) return S.initP;

        S.initP = (async () => {
            await hydrate();

            const stale =
                !S.updatedAt ||
                Date.now() - S.updatedAt > ttl;

            if (force || stale || !S.map.size) {
                await revalidate(!!force);
            }

            return all();
        })().catch((err) => {
            S.initP = null;
            throw err;
        });

        return S.initP;
    }

    function upsert(records) {
        const list = Array.isArray(records)
            ? records
            : [records];

        const validRecords = list.filter(Boolean);

        merge(validRecords);

        zcPut(cfg.entity, validRecords, cfg.idOf);

        return validRecords;
    }

    async function peek(search) {
        await hydrate();

        const query = norm(search);
        const cached = view(query);

        if (cached.length && (!query || !canMore(query))) {
            return cached;
        }

        const epoch = S.epoch;

        const result = await cfg.fetchPage(
            1,
            pageSize,
            query ? String(search).trim() : ''
        );

        if (epoch !== S.epoch) return view(query);

        const records = Array.isArray(result.records)
            ? result.records
            : [];

        merge(records);
        await zcPut(cfg.entity, records, cfg.idOf);

        if (!query) {
            S.nextPage = 2;
            S.hasMore = result.hasMore === true;
            S.updatedAt = Date.now();
            await saveMeta();
        } else {
            S.searches.set(query, {
                nextPage: 2,
                hasMore: result.hasMore === true
            });
        }

        return view(query);
    }

    function cacheSize() {
        return S.map.size;
    }

    api.init = init;
    api.all = all;
    api.view = view;
    api.canMore = canMore;
    api.loadMore = loadMore;
    api.upsert = upsert;
    api.peek = peek;
    api.size = cacheSize;
    api.revalidate = revalidate;
    api.staleCheck = () => { revalidate(false).catch(() => { }); };   // NEW: refresh page 1 in background if cache is old
    api.refresh = () => revalidate(true);
    api.loadBatch = loadBatch;

    return api;
}
/** Calls fn when the list is scrolled near the bottom. */
function attachInfiniteScroll(el, fn) {
    if (!el) return;
    el.addEventListener('scroll', () => {
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) fn();
    });
}

/** Stale-while-revalidate for a cached blob: show the cache at once, refresh in the background if old. */
async function swrBlob(name, fetchFresh, apply, ttl) {
    const hit = await zcBlobGet(name);
    if (hit && hit.data) {
        apply(hit.data);
        if (Date.now() - (hit.updatedAt || 0) >= (ttl || 0)) fetchFresh().catch(() => { });
        return;
    }
    await fetchFresh();            // nothing cached yet: wait for the first load
}// ============================================================
// VENDOR PICKER
// ============================================================

const VP = { open: false, query: '', active: 0, items: [], loading: false, error: '', remote: false, timer: null, limit: 60, pending: false, sq: '' };

const vendorSrc = createSource({
    entity: 'vendors_v2',
    keepCache: true,                 // NEW: reuse IndexedDB between widget opens
    ttl: 24 * 60 * 60 * 1000,        // NEW: cache expires after 24 hours
    idOf: (v) => v.id,
    compare: (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    fetchPage: async (page, per, search) => {
  
        const q = { contact_type: 'vendor', filter_by: 'Status.Active', page, per_page: per, sort_column: 'contact_name' };
        if (search) q.search_text = search;
        const d = await zbApi('GET', '/contacts', q);
        const records = (d.contacts || [])
        .filter((c) => !c.contact_type || String(c.contact_type).toLowerCase() === 'vendor')
        .filter((c) => String(c.status || 'active').toLowerCase() === 'active')
        .map(normVendor);
        return { records, hasMore: (d.page_context || {}).has_more_page === true };
    }
});
vendorSrc.onChange = () => { state.vendors = vendorSrc.all(); if (VP.open) vpPaint(); };

function vpMerge(list) { vendorSrc.upsert(list); }                     // create / update goes to memory + IndexedDB

const vpQ = () => (VP.query.length >= 2 ? VP.query : '');              // server search needs 2+ characters

function vpTail(list, text, retry) {
    const d = document.createElement('div');
    d.className = 'vp-msg';
    d.textContent = text;
    if (retry) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-secondary'; b.textContent = 'Retry';
        b.addEventListener('mousedown', (ev) => { ev.preventDefault(); VP.error = ''; vpFetchMore(); });
        d.appendChild(document.createElement('br'));
        d.appendChild(b);
    }
    list.appendChild(d);
}

function vpPaint() {
    if (!VP.open) return;
    const list = $('vp-list');
    const all = vendorSrc.view(VP.query);
    VP.items = all;
    if (VP.loading && !VP.query && all.length < 200) {
        vpMsg('Loading vendors…');
        return;
    }

    if (!all.length) {
        if (VP.loading) vpMsg('Loading vendors…');
        else if (VP.error) vpMsg('Could not load vendors: ' + VP.error, true);
        else if (vendorSrc.canMore(vpQ())) {
            vpMsg('Searching Zoho Books…');
            if (!VP.query) setTimeout(vpFetchMore, 0);
        } else vpMsg('No vendors found');
        return;
    }

    const top = list.scrollTop;
    const shown = all.length;
        if (VP.active >= shown) VP.active = 0;
    list.innerHTML = '';
    const chosenId = dom.vendorId.value;
    all.slice(0, shown).forEach((v, i) => {
        const d = document.createElement('div');
        d.className = 'vp-item' + (i === VP.active ? ' active' : '') + (v.id === chosenId ? ' chosen' : '');
        d.setAttribute('role', 'option');
        d.dataset.i = String(i);
        const av = document.createElement('span');
        av.className = 'vp-av';
        av.textContent = (v.name.trim().charAt(0) || '?').toUpperCase();
        d.appendChild(av);
        const tx = document.createElement('div');
        tx.className = 'vp-tx';
        const nm = document.createElement('span');
        nm.className = 'vp-nm';
        nm.textContent = v.name;
        tx.appendChild(nm);
        if (v.email) {
            const sub = document.createElement('span');
            sub.className = 'vp-sub';
            sub.textContent = '✉ ' + v.email;
            tx.appendChild(sub);
        }
        d.appendChild(tx);
        d.addEventListener('mousedown', (ev) => { ev.preventDefault(); vpChoose(i); });
        d.addEventListener('mouseenter', () => vpSetActive(i, false));
        list.appendChild(d);
    });
    if (VP.loading) vpTail(list, 'Loading more…');
    else if (VP.error) vpTail(list, 'Could not load more vendors.', true);
    list.scrollTop = top;

    // panel not full yet: keep filling (local window first, then the next API page)
    const more = VP.limit < all.length || (vendorSrc.canMore(vpQ()) && (!VP.query || VP.sq === VP.query));
    if (!VP.loading && !VP.error && more && list.scrollHeight <= list.clientHeight + 40) setTimeout(vpNear, 0);
}

function vpNear() {
    if (!VP.error) vpFetchMore();   // all loaded rows are already rendered, so just fetch the next 200
}

function vpFetchMore() {
    if (VP.loading) { VP.pending = true; return; }
    const q = vpQ();
    if (!vendorSrc.canMore(q)) return;
    VP.loading = true; VP.error = '';
    vpPaint();
    vendorSrc.loadMore(q)
        .catch((e) => { VP.error = e.message || 'Request failed'; logError('VENDOR', 'Vendor fetch failed', e); })
        .then(() => {
            VP.loading = false;
            vpPaint();
            const again = VP.pending && !VP.error;
            VP.pending = false;
            if (again) vpFetchMore();
        });
}

function vpSearchServer() { VP.sq = VP.query; if (vpQ()) vpFetchMore(); }       // runs after the debounce

async function loadVendors(force) {
    if (VP.loading) return;
    VP.loading = true; VP.error = '';
    vpPaint();
    try { if (force) await vendorSrc.refresh(); else await vendorSrc.init(); }
    catch (err) { VP.error = err.message || 'Request failed'; logError('VENDOR', 'Vendor fetch failed', err); }
    VP.loading = false;
    vpPaint();
}

function vpOpen() {
    if (VP.open) return;
    VP.open = true;
    VP.query = ''; VP.active = 0; VP.limit = 60; VP.error = ''; VP.sq = '';
    dom.vendorComboBox.classList.add('open');
    dom.vendorDropdown.classList.add('open');
    $('vp-search-input').value = '';
    vpPaint();                 // cached vendors show instantly
    loadVendors(false);
    setTimeout(() => $('vp-search-input').focus(), 0);
}



function vpMsg(text, retry) {
    const list = $('vp-list');
    list.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'vp-msg';
    d.textContent = text;
    if (retry) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-secondary';
        b.textContent = 'Retry';
        b.addEventListener('mousedown', (ev) => { ev.preventDefault(); loadVendors(true); });
        d.appendChild(document.createElement('br'));
        d.appendChild(b);
    }
    list.appendChild(d);
}



function vpSetActive(i, scroll) {
    const nodes = $('vp-list').querySelectorAll('.vp-item');
    if (!nodes.length) return;
    VP.active = Math.max(0, Math.min(nodes.length - 1, i));
    nodes.forEach((n) => n.classList.toggle('active', Number(n.dataset.i) === VP.active));
    if (scroll && nodes[VP.active].scrollIntoView) nodes[VP.active].scrollIntoView({ block: 'nearest' });
}

function vpChoose(i) {
    const v = VP.items[i];
    if (!v) return;
    vpClose();
    selectVendor(v);
}





function vpClose() {
    if (!VP.open) return;
    VP.open = false;
    clearTimeout(VP.timer);
    dom.vendorComboBox.classList.remove('open');
    dom.vendorDropdown.classList.remove('open');
}

function selectVendor(vendor) {
    vpMerge([vendor]);
    dom.vendorId.value = vendor.id;
    dom.vendorSearch.value = vendor.name;
    dom.vendorComboBox.classList.add('has-value');
    dom.vendorSearch.classList.remove('error');
    vpClose();
    markDirty();

    vaLoad(vendor.id);              // clears the previous vendor's address, loads this one
    ptApplyVendor(vendor);
    log('VENDOR', `Selected: ${vendor.name} (${vendor.id})`);
}

function clearVendor() {
    dom.vendorId.value = '';
    dom.vendorSearch.value = '';
    dom.vendorComboBox.classList.remove('has-value');
    vaClear();
    markDirty();
    if (typeof updateAllLineItemGst === 'function') updateAllLineItemGst(true);
}

function wireVendorPicker() {
    const search = $('vp-search-input');
    $('vendor-go').addEventListener('click', (ev) => { ev.stopPropagation(); vsOpen(); });

    dom.vendorComboBox.addEventListener('click', (ev) => {
        if (ev.target.closest('#vendor-clear') || ev.target.closest('#vendor-dropdown')) return;
        if (VP.open) vpClose(); else vpOpen();
    });

    dom.vendorSearch.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === 'ArrowDown' || ev.key === ' ') { ev.preventDefault(); vpOpen(); }
    });

    dom.vendorClear.addEventListener('click', (ev) => {
        ev.stopPropagation();
        clearVendor();
        vpOpen();
    });

    search.addEventListener('input', () => {
        VP.query = search.value.trim();
        VP.active = 0; VP.limit = 60; VP.error = '';
        $('vp-list').scrollTop = 0;
        vpPaint();                                            // instant, from the cache
        clearTimeout(VP.timer);
        VP.timer = setTimeout(vpSearchServer, 350);           // debounced server search
    });
    $('vp-list').addEventListener('scroll', () => {
        const l = $('vp-list');
        // past ~75% of the loaded rows (about 150 of 200): load the next 200
        if (l.scrollTop + l.clientHeight >= l.scrollHeight * 0.75) vpNear();
    });
    search.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); vpSetActive(VP.active + 1, true); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); vpSetActive(VP.active - 1, true); }
        else if (ev.key === 'Enter') { ev.preventDefault(); vpChoose(VP.active); }
        else if (ev.key === 'Escape') { ev.preventDefault(); vpClose(); dom.vendorSearch.focus(); }
        else if (ev.key === 'Tab') vpClose();
    });

    $('vp-new').addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        vpClose();
        openNewVendorModal();
    });
    $('vp-refresh').addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        loadVendors(true);
    });

    document.addEventListener('mousedown', (ev) => {
        if (VP.open && !dom.vendorComboBox.contains(ev.target)) vpClose();
    });
}



// ============================================================
// ADVANCED VENDOR SEARCH (popup opened by the blue magnifier button)
//   GET /contacts?contact_type=vendor&page=N&per_page=10
//   + contact_name_contains | company_name_contains | email_contains | phone_contains | search_text
//   UI reuses the .cs-* styles of the customer search popup.
// ============================================================

const VS = { built: false, el: null, field: 'number', text: '', page: 1, more: false, rows: [], loading: false, error: '', token: 0 };
const VS_PER = 10;
const VS_FIELDS = [['number', 'Vendor Number'], ['name', 'Vendor Name'], ['email', 'Email'], ['company', 'Company Name'], ['phone', 'Phone']];

function vsIsVendor(c) {
    const t = String(c.contact_type || '').toLowerCase();
    return !t || t === 'vendor';
}

function vsMapRaw(c) {
    return {
        raw: c,
        vendor: null,
        id: String(c.contact_id),
        name: c.contact_name || '',
        number: c.contact_number || c.vendor_number || '',
        email: c.email || '',
        company: c.company_name || '',
        phone: c.phone || c.mobile || ''
    };
}

function vsMapCached(v) {
    return {
        raw: null,
        vendor: v,
        id: v.id,
        name: v.name || '',
        number: v.number || '',
        email: v.email || '',
        company: v.companyName || '',
        phone: v.phone || ''
    };
}

// mode: 'field' = field-specific filter, 'search' = search_text, 'plain' = no text filter
function vsParams(mode) {
    const q = {
        contact_type: 'vendor',
        filter_by: 'Status.Active',
        sort_column: 'contact_name',
        page: VS.page,
        per_page: VS_PER
    };
    const t = VS.text;
    if (!t || mode === 'plain') return q;

    if (mode === 'field') {
        if (VS.field === 'name') { q.contact_name_contains = t; return q; }
        if (VS.field === 'company') { q.company_name_contains = t; return q; }
        if (VS.field === 'email') { q.email_contains = t; return q; }
        if (VS.field === 'phone') { q.phone_contains = t; return q; }
    }
    q.search_text = t;
    return q;
}

async function vsFetchServer(mode) {
    const d = await zbApi('GET', '/contacts', vsParams(mode));
    log('VENDOR', 'Advanced search response (' + mode + ')', d);
    const rows = (d.contacts || []).filter(vsIsVendor).map(vsMapRaw);
    return { rows, more: (d.page_context || {}).has_more_page === true };
}

/** Fallback: filter the same vendor list the dropdown uses. */
async function vsFetchLocal() {
    try { await vendorSrc.init(); } catch (e) { /* use whatever is cached */ }

    // load remaining pages (capped) so local search is complete
    let guard = 0;
    try {
        while (vendorSrc.canMore('') && guard++ < 20) {
            if (!(await vendorSrc.loadMore(''))) break;
        }
    } catch (e) { /* ignore */ }

    const t = VS.text.toLowerCase();
    let list = vendorSrc.all();

    if (t) {
        list = list.filter((v) => {
            const hay = VS.field === 'name' ? v.name
                : VS.field === 'company' ? v.companyName
                    : VS.field === 'email' ? v.email
                        : VS.field === 'phone' ? v.phone
                            : (v.number || '') + ' ' + v.name;
            return String(hay || '').toLowerCase().indexOf(t) > -1;
        });
    }

    const start = (VS.page - 1) * VS_PER;
    return {
        rows: list.slice(start, start + VS_PER).map(vsMapCached),
        more: start + VS_PER < list.length
    };
}

async function vsLoad() {
    const my = ++VS.token;
    VS.loading = true; VS.error = '';
    vsPaint();

    let result = null;
    let lastErr = null;

    // 1) field-specific filter (or plain list when there is no text)
    // 2) search_text   3) plain list   4) local cache
    const attempts = VS.text ? ['field', 'search'] : ['plain'];
    for (const mode of attempts) {
        try {
            const r = await vsFetchServer(mode);
            if (my !== VS.token) return;
            if (r.rows.length) { result = r; break; }
            if (!result) result = r;           // keep the empty result in case nothing else works
        } catch (e) {
            if (my !== VS.token) return;
            lastErr = e;
            logError('VENDOR', 'Advanced search request failed (' + mode + ')', e);
        }
    }

    if (!result || !result.rows.length) {
        try {
            const local = await vsFetchLocal();
            if (my !== VS.token) return;
            if (local.rows.length || !result) result = local;
        } catch (e) {
            if (my !== VS.token) return;
            lastErr = lastErr || e;
        }
    }

    if (my !== VS.token) return;

    if (result) {
        VS.rows = result.rows;
        VS.more = result.more;
    } else {
        VS.rows = []; VS.more = false;
        VS.error = (lastErr && lastErr.message) || 'Request failed';
    }

    VS.loading = false;
    vsPaint();
}

function vsPaint() {
    if (!VS.el) return;
    const body = VS.el.querySelector('.cs-body');
    body.innerHTML = '';

    const th = document.createElement('div');
    th.className = 'cs-th';
    ['Vendor Name', 'Email', 'Company Name', 'Phone'].forEach((t) => {
        const s = document.createElement('span');
        s.textContent = t;
        th.appendChild(s);
    });
    body.appendChild(th);

    const msg = (text, retry) => {
        const d = document.createElement('div');
        d.className = 'cs-msg';
        d.textContent = text;
        if (retry) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn btn-secondary'; b.setAttribute('data-retry', '1'); b.textContent = 'Retry';
            d.appendChild(document.createElement('br'));
            d.appendChild(b);
        }
        body.appendChild(d);
    };

    if (VS.loading) msg('Loading vendors…');
    else if (VS.error) msg('Could not load vendors: ' + VS.error, true);
    else if (!VS.rows.length) msg('No vendors found');
    else {
        VS.rows.forEach((r, i) => {
            const tr = document.createElement('div');
            tr.className = 'cs-tr';

            const c1 = document.createElement('div');
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'cs-nm'; b.dataset.i = String(i);
            b.textContent = r.name; b.title = r.name;
            c1.appendChild(b);
            if (r.number) {
                const n = document.createElement('div');
                n.className = 'cs-no';
                n.textContent = r.number;
                c1.appendChild(n);
            }
            tr.appendChild(c1);

            [r.email, r.company, r.phone].forEach((v) => {
                const s = document.createElement('div');
                s.className = 'cs-cell';
                s.textContent = v || '';
                s.title = v || '';
                tr.appendChild(s);
            });
            body.appendChild(tr);
        });
    }

    const start = (VS.page - 1) * VS_PER + 1;
    VS.el.querySelector('.cs-range').textContent = VS.rows.length ? (start + ' - ' + (start + VS.rows.length - 1)) : '0';
    VS.el.querySelector('.cs-prev').disabled = VS.loading || VS.page <= 1;
    VS.el.querySelector('.cs-next').disabled = VS.loading || !VS.more;
}

function vsSearch() {
    VS.text = VS.el.querySelector('.cs-text').value.trim();
    VS.field = VS.el.querySelector('.cs-field').value;
    VS.page = 1;
    vsLoad();
}

function vsClose() {
    if (!VS.el) return;
    VS.el.hidden = true;
    VS.token++;
}

function vsBuild() {
    if (VS.built) return;
    VS.built = true;

    const ov = document.createElement('div');
    ov.className = 'cs-overlay';
    ov.hidden = true;
    ov.innerHTML =
        '<div class="cs-box" role="dialog" aria-modal="true" aria-label="Advanced Vendor Search">' +
        '<div class="cs-head"><h3>Advanced Vendor Search</h3><button type="button" class="cs-x" aria-label="Close">&times;</button></div>' +
        '<div class="cs-bar"><div class="cs-search"><select class="cs-field"></select>' +
        '<input type="text" class="cs-text" autocomplete="off"></div>' +
        '<button type="button" class="btn btn-primary cs-go">Search</button></div>' +
        '<div class="cs-body"></div>' +
        '<div class="cs-foot"><div class="cs-pager"><button type="button" class="cs-prev" aria-label="Previous">&#8249;</button>' +
        '<span class="cs-range">0</span><button type="button" class="cs-next" aria-label="Next">&#8250;</button></div></div>' +
        '</div>';
    document.body.appendChild(ov);
    VS.el = ov;

    const sel = ov.querySelector('.cs-field');
    VS_FIELDS.forEach((f) => sel.appendChild(new Option(f[1], f[0])));

    ov.querySelector('.cs-x').addEventListener('click', vsClose);
    ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) vsClose(); });
    ov.querySelector('.cs-go').addEventListener('click', vsSearch);
    ov.querySelector('.cs-text').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); vsSearch(); } });
    ov.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); vsClose(); } });
    ov.querySelector('.cs-prev').addEventListener('click', () => { if (VS.page > 1) { VS.page--; vsLoad(); } });
    ov.querySelector('.cs-next').addEventListener('click', () => { if (VS.more) { VS.page++; vsLoad(); } });

    ov.querySelector('.cs-body').addEventListener('click', (ev) => {
        if (ev.target.closest('[data-retry]')) { vsLoad(); return; }
        const b = ev.target.closest('.cs-nm');
        if (!b) return;
        const r = VS.rows[Number(b.dataset.i)];
        if (!r) return;
        vsClose();
        selectVendor(r.vendor || normVendor(r.raw));
    });
}

function vsOpen() {
    vsBuild();
    vpClose();
    VS.field = 'number'; VS.text = ''; VS.page = 1; VS.rows = []; VS.more = false; VS.error = '';
    VS.el.querySelector('.cs-field').value = 'number';
    VS.el.querySelector('.cs-text').value = '';
    VS.el.hidden = false;
    vsLoad();
    setTimeout(() => VS.el.querySelector('.cs-text').focus(), 30);
}
// ============================================================
// NEW VENDOR MODAL (antigravity update with Vendor Bank Details)
// ============================================================

const NV_STATES = [
    ['AN', 'Andaman and Nicobar Islands'], ['AP', 'Andhra Pradesh'], ['AR', 'Arunachal Pradesh'], ['AS', 'Assam'], ['BR', 'Bihar'],
    ['CH', 'Chandigarh'], ['CG', 'Chhattisgarh'], ['DN', 'Dadra and Nagar Haveli and Daman and Diu'], ['DL', 'Delhi'], ['GA', 'Goa'],
    ['GJ', 'Gujarat'], ['HR', 'Haryana'], ['HP', 'Himachal Pradesh'], ['JK', 'Jammu and Kashmir'], ['JH', 'Jharkhand'], ['KA', 'Karnataka'],
    ['KL', 'Kerala'], ['LA', 'Ladakh'], ['LD', 'Lakshadweep'], ['MP', 'Madhya Pradesh'], ['MH', 'Maharashtra'], ['MN', 'Manipur'],
    ['ML', 'Meghalaya'], ['MZ', 'Mizoram'], ['NL', 'Nagaland'], ['OD', 'Odisha'], ['PY', 'Puducherry'], ['PB', 'Punjab'], ['RJ', 'Rajasthan'],
    ['SK', 'Sikkim'], ['TN', 'Tamil Nadu'], ['TS', 'Telangana'], ['TR', 'Tripura'], ['UP', 'Uttar Pradesh'], ['UK', 'Uttarakhand'], ['WB', 'West Bengal']
];

const GST_STATE_NUM = {
    '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR',
    '11': 'SK', '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH',
    '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ', '26': 'DN', '27': 'MH', '28': 'AP', '29': 'KA', '30': 'GA', '31': 'LD',
    '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TS', '37': 'AP', '38': 'LA'
};

const NV_GST = [
    { value: 'business_gst', label: 'Registered Business - Regular', reg: 1, pos: 1, req: 1 },
    { value: 'business_composition', label: 'Registered Business - Composition', reg: 1, pos: 1, req: 1 },
    { value: 'business_none', label: 'Unregistered Business', reg: 0, pos: 1, req: 0 },
    { value: 'consumer', label: 'Consumer', reg: 0, pos: 1, req: 0 },
    { value: 'overseas', label: 'Overseas', reg: 0, pos: 0, req: 0 },
    { value: 'special_economic_zone', label: 'Special Economic Zone', reg: 1, pos: 1, req: 1 },
    { value: 'deemed_export', label: 'Deemed Export', reg: 1, pos: 1, req: 1 },
    { value: 'tax_deductor', label: 'Tax Deductor', reg: 1, pos: 1, req: 0 },
    { value: 'sez_developer', label: 'SEZ Developer', reg: 1, pos: 1, req: 1 },
    { value: 'input_service_distributor', label: 'Input Service Distributor', reg: 1, pos: 1, req: 1 }
];
const NV_GST_BY = {};
NV_GST.forEach((t) => { NV_GST_BY[t.value] = t; });

const NV_DIAL = ['+91', '+1', '+44', '+971', '+966', '+65', '+61', '+49', '+33', '+81', '+86', '+92', '+880', '+94', '+977', '+974', '+968', '+965', '+973', '+60', '+62', '+63', '+66', '+84', '+82', '+852', '+27', '+234', '+254', '+20', '+39', '+34', '+31', '+41', '+46', '+47', '+45', '+7', '+55', '+52', '+54', '+64'];
const NV_COUNTRIES = [
    'India', 'United States', 'United Kingdom', 'United Arab Emirates', 'Saudi Arabia', 'Singapore', 'Australia', 'Canada',
    'Germany', 'France', 'Japan', 'China', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Qatar', 'Oman', 'Malaysia', 'South Africa',
    'Afghanistan', 'Bahrain', 'Belgium', 'Brazil', 'Denmark', 'Egypt', 'Finland', 'Hong Kong', 'Indonesia', 'Ireland',
    'Israel', 'Italy', 'Kuwait', 'Mauritius', 'Mexico', 'Netherlands', 'New Zealand', 'Norway', 'Philippines', 'Poland',
    'Portugal', 'Russia', 'Spain', 'Sweden', 'Switzerland', 'Thailand', 'Turkey', 'Vietnam'
];
const NV_ADDR = [
    ['attention', 'Attention'], ['country', 'Country/Region'], ['address', 'Address'], ['street2', ''],
    ['city', 'City'], ['state', 'State'], ['zip', 'Pin Code'], ['phone', 'Phone'], ['fax', 'Fax Number']
];
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const NV = {
    wired: false,
    saving: false,
    refsLoaded: false,
    gstOn: false,
    currencies: [],
    terms: [],
    baseCurrency: null,
    exemptions: [],
    accounts: [],
    pricebooks: [],
    tdsTaxes: [],
    files: [],
    extraBanks: []
};

const nvVal = (id) => { const e = $(id); return e ? String(e.value).trim() : ''; };

function nvFill(sel, pairs, blank) {
    if (!sel) return false;
    sel.innerHTML = '';
    if (blank !== null && blank !== undefined) {
        sel.appendChild(new Option(blank, ''));
    }
    (pairs || []).forEach((p) => {
        sel.appendChild(new Option(p[1], String(p[0])));
    });
    return true;
}

function nvMark(el, msg) {
    if (!el) return;
    el.classList.toggle('invalid', !!msg);
    const holder = el.closest('.nv-c') || el.closest('.nv-ac') || el.parentNode;
    let fe = holder.querySelector(':scope > .nv-fe');
    if (msg) {
        if (!fe) { fe = document.createElement('div'); fe.className = 'nv-fe'; holder.appendChild(fe); }
        fe.textContent = msg;
    } else if (fe) {
        fe.remove();
    }
}

function nvSwitchTab(name) {
    document.querySelectorAll('#nv-modal .nv-tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === name));
    document.querySelectorAll('#nv-modal .nv-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
}

function nvBuildAddress(prefix, boxId) {
    const box = $(boxId);
    if (!box) return;
    box.innerHTML = '';
    NV_ADDR.forEach((k) => {
        const key = k[0], id = prefix + '_' + key;
        const row = document.createElement('div');
        row.className = 'nv-a';
        const lab = document.createElement('span');
        lab.textContent = k[1];
        row.appendChild(lab);
        const cell = document.createElement('div');
        cell.className = 'nv-ac';
        let el;
        if (key === 'address' || key === 'street2') {
            el = document.createElement('textarea');
            el.rows = 2;
            el.placeholder = key === 'address' ? 'Street 1' : 'Street 2';
        } else if (key === 'country') {
            el = document.createElement('select');
            nvFill(el, NV_COUNTRIES.map((c) => [c, c]), 'Select');
        } else if (key === 'state') {
            el = document.createElement('input');
            el.type = 'text';
            el.setAttribute('list', 'nv-states');
            el.placeholder = 'Select or type state';
        } else {
            el = document.createElement('input');
            el.type = 'text';
            if (key === 'phone') el.inputMode = 'tel';
        }
        el.id = id;
        cell.appendChild(el);
        row.appendChild(cell);
        box.appendChild(row);
    });
    const cEl = $(prefix + '_country');
    if (cEl) cEl.value = NV.gstOn ? 'India' : '';
}

function nvUpdateDisplayOptions() {
    const sal = nvVal('nv_salutation'), f = nvVal('nv_firstName'), l = nvVal('nv_lastName'), comp = nvVal('nv_companyName');
    const opts = [];
    const add = (x) => { x = (x || '').replace(/\s+/g, ' ').trim(); if (x && opts.indexOf(x) < 0) opts.push(x); };
    add(comp); add([sal, f, l].join(' ')); add([f, l].join(' ')); add([l, f].join(' ')); add(l); add(f);

    const dl = $('nv-display-list');
    if (dl) {
        dl.innerHTML = '';
        opts.forEach((o) => dl.appendChild(new Option('', o)));
    }

    const d = $('nv_displayName');
    if (d && d.dataset.userEdited !== '1') {
        const person = [f, l].join(' ').replace(/\s+/g, ' ').trim();
        const typeEl = document.querySelector('input[name="nv_type"]:checked');
        const type = typeEl ? typeEl.value : 'business';
        d.value = type === 'business' ? (comp || person) : (person || comp);
    }
}

function nvUpdateTaxUi() {
    const taxPrefEl = document.querySelector('input[name="nv_tax"]:checked');
    const isExempt = taxPrefEl && taxPrefEl.value === 'exempt';
    const exRow = $('nv-exempt-row');
    if (exRow) exRow.hidden = !isExempt;
    if (!isExempt) nvMark($('nv_exemption'), '');
}

function nvUpdateGstUi() {
    const gstVal = $('nv_gst') ? $('nv_gst').value : '';
    const r = NV_GST_BY[gstVal] || null;
    document.querySelectorAll('#nv-modal .nv-gst-only').forEach((row) => { row.hidden = !NV.gstOn; });
    if (!NV.gstOn) return;

    const isReg = !!(r && r.reg);
    if ($('nv-gstin-row')) $('nv-gstin-row').hidden = !isReg;
    if ($('nv-legal-row')) $('nv-legal-row').hidden = !isReg;
    if ($('nv-trade-row')) $('nv-trade-row').hidden = !isReg;
    if ($('nv-pos-row')) $('nv-pos-row').hidden = !!(r && !r.pos);

    const need = !!(r && r.req);
    const lbl = $('nv-gstin-lbl');
    if (lbl) {
        lbl.textContent = need ? 'GSTIN / UIN*' : 'GSTIN / UIN';
        lbl.classList.toggle('req', need);
    }
}

function nvUpdateCurrencyUi() {
    const curVal = $('nv_currency') ? $('nv_currency').value : '';
    const cur = NV.currencies.find((c) => String(c.currency_id) === curVal);
    if ($('nv_obCur')) $('nv_obCur').textContent = cur ? cur.currency_code : (NV.baseCurrency ? NV.baseCurrency.currency_code : 'INR');
}

// Documents / Files Management
function nvRenderFiles() {
    const ul = $('nvFileList');
    if (!ul) return;
    ul.innerHTML = '';
    NV.files.forEach((f, i) => {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.textContent = f.name + ' (' + Math.ceil(f.size / 1024) + ' KB)';
        li.appendChild(span);
        const x = document.createElement('button');
        x.type = 'button';
        x.innerHTML = '&times;';
        x.title = 'Remove';
        x.addEventListener('click', () => { NV.files.splice(i, 1); nvRenderFiles(); });
        li.appendChild(x);
        ul.appendChild(li);
    });
}

function nvAddFiles(list) {
    let msg = '';
    Array.from(list || []).forEach((f) => {
        if (NV.files.length >= 10) { msg = 'Maximum 10 files allowed'; return; }
        if (f.size > 10 * 1024 * 1024) { msg = f.name + ' exceeds 10MB'; return; }
        if (NV.files.some((x) => x.name === f.name && x.size === f.size)) return;
        NV.files.push(f);
    });
    if ($('nv-status')) $('nv-status').textContent = msg;
    nvRenderFiles();
}

// ============================================================
// BANK DETAILS MANAGEMENT & MULTIPLE BANKS
// ============================================================

function nvWirePasswordToggle(inputId, btnId) {
    const inp = $(inputId), btn = $(btnId);
    if (!inp || !btn) return;
    btn.addEventListener('click', () => {
        const isPwd = inp.type === 'password';
        inp.type = isPwd ? 'text' : 'password';
        btn.innerHTML = isPwd
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    });
}

function nvRenderExtraBanks() {
    const list = $('nv_extra_banks_list');
    if (!list) return;
    list.innerHTML = '';

    NV.extraBanks.forEach((eb, idx) => {
        const card = document.createElement('div');
        card.className = 'nv-extra-bank-card';

        const info = document.createElement('div');
        info.className = 'nv-extra-bank-info';

        const title = document.createElement('div');
        title.className = 'nv-extra-bank-title';
        title.textContent = eb.bank_name || 'Bank Account';
        if (eb.account_holder_name) {
            const hSpan = document.createElement('span');
            hSpan.style.fontWeight = 'normal';
            hSpan.style.color = '#64748b';
            hSpan.textContent = '(' + eb.account_holder_name + ')';
            title.appendChild(hSpan);
        }
        info.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'nv-extra-bank-meta';
        const masked = '•••• •••• ' + (eb.account_number.slice(-4) || '••••');
        meta.innerHTML = '<span>Acc: ' + masked + '</span><span>IFSC: ' + eb.ifsc + '</span>';
        info.appendChild(meta);
        card.appendChild(info);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'nv-cp-del';
        delBtn.innerHTML = '&times;';
        delBtn.title = 'Remove Bank Account';
        delBtn.addEventListener('click', () => {
            NV.extraBanks.splice(idx, 1);
            nvRenderExtraBanks();
        });
        card.appendChild(delBtn);

        list.appendChild(card);
    });
}

function nvResetExtraBankForm() {
    ['nv_xb_holder', 'nv_xb_name', 'nv_xb_acc', 'nv_xb_acc_re', 'nv_xb_ifsc'].forEach((id) => {
        const el = $(id);
        if (el) { el.value = ''; el.classList.remove('invalid'); }
    });
    if ($('nv_xb_status')) $('nv_xb_status').textContent = '';
    if ($('nv_extra_bank_box')) $('nv_extra_bank_box').hidden = true;
    if ($('nv_add_bank_btn')) $('nv_add_bank_btn').style.display = '';
}

function nvSaveExtraBankInline() {
    const holder = nvVal('nv_xb_holder');
    const bName = nvVal('nv_xb_name');
    const acc = nvVal('nv_xb_acc');
    const accRe = nvVal('nv_xb_acc_re');
    const ifsc = nvVal('nv_xb_ifsc').toUpperCase();

    if (!acc) {
        if ($('nv_xb_status')) $('nv_xb_status').textContent = 'Account number is required.';
        if ($('nv_xb_acc')) $('nv_xb_acc').focus();
        return;
    }
    if (!/^[0-9A-Za-z]{6,25}$/.test(acc)) {
        if ($('nv_xb_status')) $('nv_xb_status').textContent = 'Enter a valid account number (6 to 25 characters).';
        if ($('nv_xb_acc')) $('nv_xb_acc').focus();
        return;
    }
    if (!accRe) {
        if ($('nv_xb_status')) $('nv_xb_status').textContent = 'Re-entering account number is required.';
        if ($('nv_xb_acc_re')) $('nv_xb_acc_re').focus();
        return;
    }
    if (acc !== accRe) {
        if ($('nv_xb_status')) $('nv_xb_status').textContent = 'Account numbers do not match.';
        if ($('nv_xb_acc_re')) $('nv_xb_acc_re').focus();
        return;
    }
    if (!ifsc) {
        if ($('nv_xb_status')) $('nv_xb_status').textContent = 'IFSC is required.';
        if ($('nv_xb_ifsc')) $('nv_xb_ifsc').focus();
        return;
    }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
        if ($('nv_xb_status')) $('nv_xb_status').textContent = 'Enter a valid 11-character IFSC code (e.g. SBIN0001234).';
        if ($('nv_xb_ifsc')) $('nv_xb_ifsc').focus();
        return;
    }

    NV.extraBanks.push({
        id: Date.now(),
        account_holder_name: holder,
        bank_name: bName,
        account_number: acc,
        ifsc: ifsc,
        is_default: false
    });

    nvResetExtraBankForm();
    nvRenderExtraBanks();
}

async function nvLoadRefs() {
    if (NV.refsLoaded) return;
    const jobs = [
        zbApi('GET', '/settings/currencies').then((j) => { NV.currencies = j.currencies || []; }).catch(() => { NV.currencies = []; }),
        zbApi('GET', '/settings/paymentterms').then((j) => {
            const list = (j.data && j.data.payment_terms) || j.payment_terms || [];
            NV.terms = list.map((t) => ({
                days: Number(t.payment_terms) || 0,
                label: t.payment_terms_label || (Number(t.payment_terms) === 0 ? 'Due on Receipt' : 'Net ' + t.payment_terms),
                isDefault: !!t.is_default
            }));
        }).catch(() => { NV.terms = []; }),
        zbApi('GET', '/settings/taxexemptions').then((j) => { NV.exemptions = j.tax_exemptions || []; }).catch(() => { NV.exemptions = []; }),
        zbApi('GET', '/chartofaccounts', { filter_by: 'AccountType.Active', per_page: 200 }).then((j) => {
            const all = j.chartofaccounts || [];
            NV.accounts = all.filter(a => /payable|liability|current_liability/i.test(a.account_type || ''));
        }).catch(() => { NV.accounts = []; }),
        zbApi('GET', '/pricebooks').then((j) => { NV.pricebooks = j.pricebooks || []; }).catch(() => { NV.pricebooks = []; }),
        zbApi('GET', '/settings/taxes', { filter_by: 'Taxes.All', usestate: 'false', per_page: 100, is_tds_request: 'true' }).then((j) => {
            NV.tdsTaxes = (j.taxes || []).filter(t => !t.is_inactive);
        }).catch(() => { NV.tdsTaxes = []; })
    ];

    await Promise.all(jobs);
    NV.baseCurrency = NV.currencies.find((c) => c.is_base_currency) || NV.currencies[0] || null;
    NV.refsLoaded = true;
}

function nvDetectGst() {
    const o = state.org || {};
    return o.country_code === 'IN' || /india/i.test(String(o.country || '')) ||
        !!(NV.baseCurrency && NV.baseCurrency.currency_code === 'INR');
}

function nvWire() {
    if (NV.wired) return;
    NV.wired = true;

    document.querySelectorAll('#nv-modal .nv-tab').forEach((t) => t.addEventListener('click', () => nvSwitchTab(t.dataset.pane)));
    ['nv_salutation', 'nv_firstName', 'nv_lastName', 'nv_companyName'].forEach((id) => {
        const el = $(id);
        if (el) {
            el.addEventListener('input', nvUpdateDisplayOptions);
            el.addEventListener('change', nvUpdateDisplayOptions);
        }
    });

    if ($('nv_displayName')) {
        $('nv_displayName').addEventListener('input', () => {
            $('nv_displayName').dataset.userEdited = $('nv_displayName').value ? '1' : '';
        });
    }

    document.querySelectorAll('input[name="nv_type"]').forEach((r) => r.addEventListener('change', () => {
        if ($('nv_displayName')) $('nv_displayName').dataset.userEdited = '';
        nvUpdateDisplayOptions();
    }));

    document.querySelectorAll('input[name="nv_tax"]').forEach((r) => r.addEventListener('change', nvUpdateTaxUi));

    if ($('nv_gst')) $('nv_gst').addEventListener('change', nvUpdateGstUi);
    if ($('nv_currency')) $('nv_currency').addEventListener('change', nvUpdateCurrencyUi);

    if ($('nv_pan')) {
        $('nv_pan').addEventListener('input', function () { this.value = this.value.toUpperCase(); this.dataset.auto = ''; });
    }

    if ($('nv_gstin')) {
        $('nv_gstin').addEventListener('input', function () {
            this.value = this.value.toUpperCase();
            if (GSTIN_RE.test(this.value)) {
                const pan = $('nv_pan'), pos = $('nv_pos');
                if (pan && (!pan.value.trim() || pan.dataset.auto === '1')) {
                    pan.value = this.value.slice(2, 12);
                    pan.dataset.auto = '1';
                    nvMark(pan, '');
                }
                const sc = GST_STATE_NUM[this.value.slice(0, 2)];
                if (pos && sc && Array.from(pos.options).some(o => o.value === sc)) {
                    pos.value = sc;
                    nvMark(pos, '');
                }
            }
        });
    }

    if ($('nv-more-link')) {
        $('nv-more-link').addEventListener('click', () => {
            const m = $('nv-more');
            if (m) {
                m.hidden = !m.hidden;
                $('nv-more-link').textContent = m.hidden ? 'Add more details' : 'Show fewer details';
            }
        });
    }

    if ($('nv-copy')) {
        $('nv-copy').addEventListener('click', () => {
            ['attention', 'country', 'address', 'street2', 'city', 'state', 'zip', 'phone', 'fax'].forEach((k) => {
                const b = $('vb_' + k), s = $('vs_' + k);
                if (b && s) s.value = b.value;
            });
        });
    }

    // Bank Details: eye buttons and partner callout
    nvWirePasswordToggle('nv_bank_acc', 'nv_bank_acc_eye');
    nvWirePasswordToggle('nv_xb_acc', 'nv_xb_acc_eye');

    if ($('nv_bank_ifsc')) {
        $('nv_bank_ifsc').addEventListener('input', function () { this.value = this.value.toUpperCase(); });
    }
    if ($('nv_xb_ifsc')) {
        $('nv_xb_ifsc').addEventListener('input', function () { this.value = this.value.toUpperCase(); });
    }

    if ($('nv_bank_callout_close')) {
        $('nv_bank_callout_close').addEventListener('click', () => {
            if ($('nv_bank_callout')) $('nv_bank_callout').hidden = true;
        });
    }

    // Multiple Banks: Add / Save / Cancel
    if ($('nv_add_bank_btn')) {
        $('nv_add_bank_btn').addEventListener('click', () => {
            if ($('nv_extra_bank_box')) $('nv_extra_bank_box').hidden = false;
            if ($('nv_add_bank_btn')) $('nv_add_bank_btn').style.display = 'none';
            if ($('nv_xb_holder')) $('nv_xb_holder').focus();
        });
    }
    if ($('nv_xb_save_btn')) $('nv_xb_save_btn').addEventListener('click', nvSaveExtraBankInline);
    if ($('nv_xb_cancel_btn')) $('nv_xb_cancel_btn').addEventListener('click', nvResetExtraBankForm);

    // File attachments
    if ($('nvFileBtn')) $('nvFileBtn').addEventListener('click', () => { if ($('nv_files')) $('nv_files').click(); });
    if ($('nv_files')) $('nv_files').addEventListener('change', function () { nvAddFiles(this.files); this.value = ''; });

    if ($('nv-close')) $('nv-close').addEventListener('click', closeNewVendorModal);
    if ($('nv-cancel')) $('nv-cancel').addEventListener('click', closeNewVendorModal);
    if ($('nv-save')) $('nv-save').addEventListener('click', saveNewVendor);
    if ($('nv-modal')) $('nv-modal').addEventListener('mousedown', (ev) => { if (ev.target === $('nv-modal')) closeNewVendorModal(); });

    document.addEventListener('keydown', (ev) => {
        if ($('nv-modal') && $('nv-modal').hidden) return;
        if (ev.key === 'Escape') {
            if ($('nv_extra_bank_box') && !$('nv_extra_bank_box').hidden) { nvResetExtraBankForm(); return; }
            closeNewVendorModal();
            return;
        }
        if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && ev.target.type !== 'radio' && ev.target.type !== 'checkbox') {
            if (ev.target.closest('#nv_extra_bank_box')) {
                ev.preventDefault();
                nvSaveExtraBankInline();
                return;
            }
            ev.preventDefault();
            saveNewVendor();
        }
    });
}

async function openNewVendorModal() {
    nvWire();
    const modal = $('nv-modal');
    if (!modal) return;

    modal.querySelectorAll('input[type=text], input[type=password], textarea').forEach((el) => { el.value = ''; el.classList.remove('invalid'); });
    modal.querySelectorAll('select').forEach((s) => s.classList.remove('invalid'));
    modal.querySelectorAll('.nv-fe').forEach((e) => e.remove());
    modal.querySelectorAll('.nv-tab').forEach((t) => t.classList.remove('has-err'));

    const bType = document.querySelector('input[name="nv_type"][value="business"]');
    if (bType) bType.checked = true;

    const tTaxable = document.querySelector('input[name="nv_tax"][value="taxable"]');
    if (tTaxable) tTaxable.checked = true;

    if ($('nv_displayName')) $('nv_displayName').dataset.userEdited = '';
    if ($('nv_pan')) $('nv_pan').dataset.auto = '';
    if ($('nv_salutation')) $('nv_salutation').value = '';
    if ($('nv-more')) $('nv-more').hidden = true;
    if ($('nv-more-link')) $('nv-more-link').textContent = 'Add more details';
    if ($('nv_bank_callout')) $('nv_bank_callout').hidden = false;
    if ($('nv-status')) $('nv-status').textContent = 'Loading…';
    if ($('nv-save')) $('nv-save').disabled = true;
    NV.saving = false;
    NV.files = [];
    NV.extraBanks = [];
    nvRenderFiles();
    nvRenderExtraBanks();
    nvResetExtraBankForm();

    nvSwitchTab('other');
    modal.hidden = false;

    await nvLoadRefs();
    NV.gstOn = nvDetectGst();

    nvFill($('nv_workCode'), NV_DIAL.map((c) => [c, c]), null);
    nvFill($('nv_mobCode'), NV_DIAL.map((c) => [c, c]), null);
    nvFill($('nv_gst'), NV_GST.map((t) => [t.value, t.label]), 'Select a GST treatment');
    nvFill($('nv_pos'), NV_STATES.map((s) => [s[0], '[' + s[0] + '] - ' + s[1]]), 'Select a state');
    nvFill($('nv_currency'), NV.currencies.map((c) => [c.currency_id, c.currency_code + ' - ' + c.currency_name]), null);
    if (NV.baseCurrency && $('nv_currency')) $('nv_currency').value = String(NV.baseCurrency.currency_id);

    // Vendor Languages
    const langs = [['en', 'English'], ['hi', 'Hindi'], ['mr', 'Marathi'], ['ta', 'Tamil'], ['te', 'Telugu'], ['gu', 'Gujarati'], ['bn', 'Bengali'], ['kn', 'Kannada'], ['ml', 'Malayalam']];
    nvFill($('nv_language'), langs, null);

    // Payment terms
    const terms = NV.terms.length ? NV.terms : [{ days: 0, label: 'Due on Receipt', isDefault: true }];
    nvFill($('nv_terms'), terms.map((t, i) => [i, t.label]), null);
    const defIdx = terms.findIndex((t) => t.isDefault);
    if ($('nv_terms')) $('nv_terms').value = String(defIdx > -1 ? defIdx : 0);

    // Accounts Payable
    if (NV.accounts.length) {
        nvFill($('nv_ap'), NV.accounts.map(a => [a.account_id, a.account_name]), 'Select Accounts Payable');
    } else {
        nvFill($('nv_ap'), [['', 'Accounts Payable (Default)']], null);
    }

    // TDS rates
    if (NV.tdsTaxes.length) {
        nvFill($('nv_tds'), NV.tdsTaxes.map(t => [t.tax_id, t.tax_name + ' [' + t.tax_percentage + '%]']), 'Select TDS Tax');
    } else {
        nvFill($('nv_tds'), [], 'Select TDS Tax');
    }

    // Pricebooks
    if (NV.pricebooks.length) {
        nvFill($('nv_pb'), NV.pricebooks.map(p => [p.pricebook_id, p.pricebook_name]), 'Select Price List');
    } else {
        nvFill($('nv_pb'), [], 'Select Price List');
    }

    // Datalist for states
    const sl = $('nv-states');
    if (sl) {
        sl.innerHTML = '';
        NV_STATES.forEach((s) => sl.appendChild(new Option('', s[1])));
    }

    nvBuildAddress('vb', 'nv-billing');
    nvBuildAddress('vs', 'nv-shipping');
    nvUpdateGstUi();
    nvUpdateTaxUi();
    nvUpdateCurrencyUi();

    if ($('nv-status')) $('nv-status').textContent = '';
    if ($('nv-save')) $('nv-save').disabled = false;
    setTimeout(() => { if ($('nv_firstName')) $('nv_firstName').focus(); }, 30);
}

function closeNewVendorModal() {
    if (NV.saving) return;
    if ($('nv-modal')) $('nv-modal').hidden = true;
}

function nvValidate() {
    const errs = [];
    const bad = (id, msg) => { const el = $(id); if (el) { nvMark(el, msg); errs.push({ el, msg }); } };
    ['nv_displayName', 'nv_email', 'nv_workPhone', 'nv_mobile', 'nv_gst', 'nv_gstin', 'nv_pos', 'nv_pan', 'nv_exemption', 'nv_obAmt', 'vb_phone', 'vs_phone', 'nv_bank_acc', 'nv_bank_acc_re', 'nv_bank_ifsc']
        .forEach((id) => nvMark($(id), ''));

    const dispName = nvVal('nv_displayName').trim();
    if (!dispName) bad('nv_displayName', 'Display name is required');
    else if (dispName.length > 200) bad('nv_displayName', 'Display name is too long (max 200)');
    else if (state.vendors.some((v) => (v.name || '').trim().toLowerCase() === dispName.toLowerCase())) {
        bad('nv_displayName', 'A vendor with this display name already exists.');
    }

    const em = nvVal('nv_email');
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) bad('nv_email', 'Enter a valid email address');

    [['nv_workPhone', 'work phone'], ['nv_mobile', 'mobile number'], ['vb_phone', 'billing phone number'], ['vs_phone', 'shipping phone number']].forEach((p) => {
        const v = nvVal(p[0]);
        if (!v) return;
        const digits = v.replace(/\D/g, '');
        if (!/^[0-9 ()+\-]+$/.test(v) || digits.length < 6 || digits.length > 15) bad(p[0], 'Enter a valid ' + p[1]);
    });

    if ($('nv_portal') && $('nv_portal').checked && !em) {
        bad('nv_email', 'An email address is required to enable portal access');
    }

    if (NV.gstOn) {
        const r = NV_GST_BY[$('nv_gst') ? $('nv_gst').value : ''];
        if (!r) {
            bad('nv_gst', 'Select a GST treatment');
        } else {
            const g = nvVal('nv_gstin');
            if (r.reg) {
                if (!g) { if (r.req) bad('nv_gstin', 'GSTIN is required for this GST treatment'); }
                else if (!GSTIN_RE.test(g)) bad('nv_gstin', 'Enter a valid 15-character GSTIN');
            }
            if (r.pos && $('nv_pos') && !$('nv_pos').value) bad('nv_pos', 'Select the source of supply');
            const pan = nvVal('nv_pan');
            if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) bad('nv_pan', 'Enter a valid 10-character PAN');
            else if (pan && r.reg && GSTIN_RE.test(g) && g.slice(2, 12) !== pan) bad('nv_pan', 'PAN does not match the GSTIN');
        }
    }

    const taxPrefEl = document.querySelector('input[name="nv_tax"]:checked');
    if (taxPrefEl && taxPrefEl.value === 'exempt') {
        const exReason = nvVal('nv_exemption');
        if (!exReason) bad('nv_exemption', 'Enter an exemption reason');
        else if (exReason.length > 200) bad('nv_exemption', 'Exemption reason is too long (max 200)');
    }

    const ob = nvVal('nv_obAmt');
    if (ob) {
        const n = parseFloat(ob);
        if (!/^-?\d+(\.\d+)?$/.test(ob) || !isFinite(n)) bad('nv_obAmt', 'Opening balance must be a number');
        else if (n < 0) bad('nv_obAmt', 'Opening balance cannot be negative');
    }

    ['vb_zip', 'vs_zip'].forEach((id) => {
        const z = $(id);
        if (z && z.value.trim().length > 20) bad(id, 'Pin code is too long');
    });

    // Bank Details Validation
    const bHolder = nvVal('nv_bank_holder');
    const bName = nvVal('nv_bank_name');
    const bAcc = nvVal('nv_bank_acc');
    const bAccRe = nvVal('nv_bank_acc_re');
    const bIfsc = nvVal('nv_bank_ifsc').toUpperCase();

    const hasPrimaryBank = !!(bHolder || bName || bAcc || bAccRe || bIfsc);
    if (hasPrimaryBank) {
        if (!bAcc) {
            bad('nv_bank_acc', 'Account number is required');
        } else if (!/^[0-9A-Za-z]{6,25}$/.test(bAcc)) {
            bad('nv_bank_acc', 'Enter a valid account number (6 to 25 characters)');
        }

        if (!bAccRe) {
            bad('nv_bank_acc_re', 'Re-entering account number is required');
        } else if (bAcc && bAcc !== bAccRe) {
            bad('nv_bank_acc_re', 'Account numbers do not match');
        }

        if (!bIfsc) {
            bad('nv_bank_ifsc', 'IFSC is required');
        } else if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bIfsc)) {
            bad('nv_bank_ifsc', 'Enter a valid 11-character IFSC code (e.g. SBIN0001234)');
        }
    }

    return errs;
}

function nvShowFirstError(errs) {
    document.querySelectorAll('#nv-modal .nv-tab').forEach((t) => t.classList.remove('has-err'));
    errs.forEach((e) => {
        const pane = e.el.closest('.nv-pane');
        if (pane) {
            const tab = document.querySelector('#nv-modal .nv-tab[data-pane="' + pane.dataset.pane + '"]');
            if (tab) tab.classList.add('has-err');
        }
    });
    const f = errs[0], pane = f.el.closest('.nv-pane');
    if (pane) nvSwitchTab(pane.dataset.pane);
    if (f.el.scrollIntoView) f.el.scrollIntoView({ block: 'center' });
    if (f.el.focus) f.el.focus();
    if ($('nv-status')) $('nv-status').textContent = errs.length + ' field(s) need attention: ' + f.msg;
}

function nvAddress(prefix) {
    const o = {};
    let any = false;
    NV_ADDR.forEach((k) => {
        const v = nvVal(prefix + '_' + k[0]);
        if (!v) return;
        if (k[0] === 'phone') {
            const codeEl = $('nv_workCode');
            o.phone = (codeEl ? codeEl.value + ' ' : '') + v;
        } else {
            o[k[0]] = v;
        }
        if (k[0] !== 'country') any = true;
    });
    if (o.state && /^india$/i.test(o.country || '')) {
        const st = NV_STATES.find((s) => s[1].toLowerCase() === o.state.toLowerCase());
        if (st) o.state_code = st[0];
    }
    return any ? o : null;
}

function nvPayload() {
    const typeEl = document.querySelector('input[name="nv_type"]:checked');
    const type = typeEl ? typeEl.value : 'business';
    const p = {
        contact_type: 'vendor',
        contact_name: nvVal('nv_displayName'),
        vendor_sub_type: type
    };
    if (nvVal('nv_companyName')) p.company_name = nvVal('nv_companyName');
    if (nvVal('nv_website')) p.website = nvVal('nv_website');
    if (nvVal('nv_language')) p.language_code = nvVal('nv_language');
    if ($('nv_portal') && $('nv_portal').checked) p.is_portal_enabled = true;

    const cur = NV.currencies.find((c) => String(c.currency_id) === ($('nv_currency') ? $('nv_currency').value : ''));
    if (cur) {
        p.currency_id = String(cur.currency_id);
        if (NV.baseCurrency && String(cur.currency_id) !== String(NV.baseCurrency.currency_id) && cur.exchange_rate != null) {
            p.exchange_rate = Number(cur.exchange_rate);
        }
    }

    const terms = NV.terms.length ? NV.terms : [{ days: 0, label: 'Due on Receipt' }];
    const tIdx = $('nv_terms') ? parseInt($('nv_terms').value, 10) : 0;
    const t = terms[tIdx];
    if (t) { p.payment_terms = t.days; p.payment_terms_label = t.label; }

    if (nvVal('nv_ap')) p.accounts_payable_id = nvVal('nv_ap');
    if (nvVal('nv_pb')) p.pricebook_id = nvVal('nv_pb');
    if (nvVal('nv_tds')) p.tax_id = nvVal('nv_tds');

    if (nvVal('nv_obAmt')) p.opening_balance_amount = parseFloat(nvVal('nv_obAmt'));

    const taxPrefEl = document.querySelector('input[name="nv_tax"]:checked');
    const isExempt = taxPrefEl && taxPrefEl.value === 'exempt';
    if (isExempt) {
        p.tax_treatment = 'tax_exempt';
        const exReason = nvVal('nv_exemption');
        const matchEx = NV.exemptions.find(e => (e.tax_exemption_code || '').toLowerCase() === exReason.toLowerCase() || (e.description || '').toLowerCase() === exReason.toLowerCase());
        if (matchEx) p.tax_exemption_id = String(matchEx.tax_exemption_id);
        else p.notes = (p.notes ? p.notes + '\n' : '') + 'Tax exemption reason: ' + exReason;
    } else {
        p.tax_treatment = 'taxable';
    }

    if (NV.gstOn) {
        const r = NV_GST_BY[$('nv_gst') ? $('nv_gst').value : ''];
        if (r) {
            p.gst_treatment = r.value;
            if (r.reg) {
                if (nvVal('nv_gstin')) p.gst_no = nvVal('nv_gstin');
                if (nvVal('nv_legalName')) p.legal_name = nvVal('nv_legalName');
                if (nvVal('nv_tradeName')) p.trade_name = nvVal('nv_tradeName');
            }
            if (r.pos && $('nv_pos') && $('nv_pos').value) p.source_of_supply = $('nv_pos').value;
            if (nvVal('nv_pan')) p.pan_no = nvVal('nv_pan');
        }
    }

    // Primary Contact Person
    const primaryCp = {};
    let hasPrimary = false;
    [
        ['salutation', nvVal('nv_salutation')], ['first_name', nvVal('nv_firstName')], ['last_name', nvVal('nv_lastName')],
        ['email', nvVal('nv_email')],
        ['phone', nvVal('nv_workPhone') ? ($('nv_workCode') ? $('nv_workCode').value + ' ' : '') + nvVal('nv_workPhone') : ''],
        ['mobile', nvVal('nv_mobile') ? ($('nv_mobCode') ? $('nv_mobCode').value + ' ' : '') + nvVal('nv_mobile') : ''],
        ['designation', nvVal('nv_desig')], ['department', nvVal('nv_dept')]
    ].forEach((x) => { if (x[1]) { primaryCp[x[0]] = x[1]; hasPrimary = true; } });

    if (hasPrimary) {
        primaryCp.is_primary_contact = true;
        p.contact_persons = [primaryCp];
    }

    const b = nvAddress('vb'), s = nvAddress('vs');
    if (b) p.billing_address = b;
    if (s) p.shipping_address = s;

    // Bank Accounts
    const bankAccounts = [];
    if (nvVal('nv_bank_acc') && nvVal('nv_bank_ifsc')) {
        bankAccounts.push({
            account_holder_name: nvVal('nv_bank_holder') || nvVal('nv_displayName'),
            bank_name: nvVal('nv_bank_name'),
            account_number: nvVal('nv_bank_acc'),
            ifsc: nvVal('nv_bank_ifsc').toUpperCase(),
            is_default: true
        });
    }
    NV.extraBanks.forEach((eb) => {
        bankAccounts.push({
            account_holder_name: eb.account_holder_name || nvVal('nv_displayName'),
            bank_name: eb.bank_name,
            account_number: eb.account_number,
            ifsc: eb.ifsc.toUpperCase(),
            is_default: false
        });
    });
    if (bankAccounts.length) {
        p.bank_accounts = bankAccounts;
    }

    if (nvVal('nv_remarks')) p.notes = (p.notes ? p.notes + '\n' : '') + nvVal('nv_remarks');
    return p;
}

async function saveNewVendor() {
    if (NV.saving) return;
    const errs = nvValidate();
    if (errs.length) { nvShowFirstError(errs); return; }

    NV.saving = true;
    if ($('nv-save')) $('nv-save').disabled = true;
    document.querySelectorAll('#nv-modal .nv-tab').forEach((t) => t.classList.remove('has-err'));
    if ($('nv-status')) $('nv-status').textContent = 'Creating vendor…';

    let payload;
    try {
        payload = nvPayload();
    } catch (e) {
        console.error('[NewVendor] Build payload failed', e);
        NV.saving = false;
        if ($('nv-save')) $('nv-save').disabled = false;
        if ($('nv-status')) $('nv-status').textContent = 'Could not build vendor request: ' + (e.message || e);
        return;
    }
    log('NEW_VENDOR', 'Payload', payload);

    try {
        const data = await zbApi('POST', '/contacts', {}, payload);
        const c = data.contact;
        if (!c || !c.contact_id) throw new Error('Zoho Books did not return the created vendor.');

        // If bank accounts were entered, call the contact bankaccount sub-endpoint to ensure persistence
        if (payload.bank_accounts && payload.bank_accounts.length) {
            for (const b of payload.bank_accounts) {
                try {
                    await zbApi('POST', '/contacts/' + c.contact_id + '/bankaccount', {}, {
                        account_holder_name: b.account_holder_name,
                        bank_name: b.bank_name,
                        account_number: b.account_number,
                        ifsc: b.ifsc,
                        is_default: b.is_default
                    });
                    log('NEW_VENDOR', 'Bank account linked via sub-endpoint:', b.bank_name || b.ifsc);
                } catch (bkErr) {
                    log('NEW_VENDOR', 'Sub-endpoint bankaccount note (already handled in create or requires connected banking):', bkErr.message || bkErr);
                }
            }
        }

        NV.saving = false;
        if ($('nv-save')) $('nv-save').disabled = false;
        if ($('nv-modal')) $('nv-modal').hidden = true;
        const norm = normVendor(c);
        selectVendor(norm);
        log('NEW_VENDOR', 'Vendor successfully created and selected:', norm.name);
    } catch (err) {
        logError('NEW_VENDOR', 'Create vendor failed', err);
        NV.saving = false;
        if ($('nv-save')) $('nv-save').disabled = false;
        if ($('nv-status')) $('nv-status').textContent = 'Save failed: ' + (err.message || 'Request failed');
    }
}


// ============================================================
// VENDOR ADDRESS BLOCK (billing / shipping / GST)
//   Load : GET /contacts/{id}
//   Save : PUT /contacts/{id}  { contact_name, billing_address | shipping_address | gst_treatment, gst_no }
// ============================================================

const VA = { vendorId: '', contact: null, loading: false, error: '', msg: '', msgTimer: null, token: 0, saving: false, cache: {} };
const VA_FIELDS = ['attention', 'address', 'street2', 'city', 'state', 'zip', 'phone', 'fax'];
const VA_PENCIL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

const vaStr = (v) => (v === null || v === undefined) ? '' : String(v).trim();

function vaNorm(a) {
    const o = {};
    VA_FIELDS.concat(['country', 'state_code']).forEach((k) => { o[k] = vaStr(a && a[k]); });
    return o;
}
function vaHas(a) { return VA_FIELDS.some((k) => vaStr(a && a[k]) !== ''); }   // country alone = no address
function vaGstOn(c) {
    const o = state.org || {};
    return o.country_code === 'IN' || /india/i.test(String(o.country || '')) || !!(c && c.gst_treatment);
}
function vaGstLabel(t) {
    const r = NV_GST_BY[t];
    return r ? r.label : String(t || '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

/** One request per vendor, shared by the address block and ptApplyVendor (30 s cache). */
function vaFetchContact(id) {
    const hit = VA.cache[id];
    if (hit && Date.now() - hit.t < 30000) return hit.p;
    const p = zbApi('GET', '/contacts/' + id).then((d) => d.contact || null);
    VA.cache[id] = { p, t: Date.now() };
    p.catch(() => { if (VA.cache[id] && VA.cache[id].p === p) delete VA.cache[id]; });
    return p;
}

async function vaLoad(id, force) {
    if ($('src-supply')) $('src-supply').dataset.touched = '';
    if (!$('va-block')) return;
    const my = ++VA.token;
    VA.vendorId = String(id);
    VA.contact = null;                 // previous vendor's data is gone before anything renders
    VA.loading = true; VA.error = ''; VA.msg = '';
    vaRender();
    if (force) delete VA.cache[VA.vendorId];
    try {
        const c = await vaFetchContact(VA.vendorId);
        if (my !== VA.token) return;   // a newer selection took over
        if (!c) throw new Error('Vendor details were not returned.');
        VA.contact = c;
        vaSyncReverseCharge(c);
        if (typeof updateAllLineItemGst === 'function') updateAllLineItemGst(true);
    } catch (err) {
        if (my !== VA.token) return;
        VA.error = err.message || 'Request failed';
        logError('VENDOR_ADDRESS', 'Could not load vendor details', err);
    }
    VA.loading = false;
    vaRender();
}

function vaClear() {
    if ($('src-supply')) $('src-supply').dataset.touched = '';
    VA.token++;
    VA.vendorId = ''; VA.contact = null; VA.loading = false; VA.error = ''; VA.msg = '';
    clearTimeout(VA.msgTimer);
    vaRender();
}

function vaToast(text) {
    VA.msg = text;
    vaRender();
    clearTimeout(VA.msgTimer);
    VA.msgTimer = setTimeout(() => { VA.msg = ''; vaRender(); }, 4000);
}



/** Unregistered / overseas vendors require reverse charge in Zoho Books. Ticks the box unless the user has set it. */
// function vaSyncReverseCharge(c) {
//     const cb = $('reverse-charge');
//     if (!cb || cb.dataset.touched === '1' || !c) return;
//     const t = String(c.gst_treatment || '');
//     cb.checked = (t === 'business_none' || t === 'overseas');
// }

function vaSyncReverseCharge(c) {
    const cb = $('reverse-charge');
    if (!cb || !c) return;
    const t = String(c.gst_treatment || '').trim().toLowerCase();
    if (t === 'overseas') {
        cb.checked = true;            // Zoho requires it for overseas vendors
    } else if (cb.dataset.touched !== '1') {
        cb.checked = false;           // Do not assume unregistered automatically requires RCM
    }
}

// ---------- render ----------
function vaEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}
function vaPencilBtn(title, fn) {
    const b = vaEl('button', 'va-pencil');
    b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
    b.innerHTML = VA_PENCIL;                       // static markup only
    b.addEventListener('click', fn);
    return b;
}

function vaCol(parent, kind, label) {
    const col = vaEl('div', 'va-col');
    const h = vaEl('div', 'va-h');
    h.appendChild(vaEl('span', '', label));
    col.appendChild(h);

    const a = vaNorm(VA.contact[kind + '_address']);
    if (vaHas(a)) {
        h.appendChild(vaPencilBtn('Edit ' + kind + ' address', () => vaOpenAddress(kind)));
        const box = vaEl('div', 'va-lines');
        const add = (t, cls) => { if (t) box.appendChild(vaEl('div', cls || '', t)); };
        add(a.attention, 'va-b');
        add(a.address); add(a.street2); add(a.city);
        add([a.state, a.zip].filter(Boolean).join(' '));
        add(a.country);
        add(a.phone ? 'Phone: ' + a.phone : '', 'va-sub');
        add(a.fax ? 'Fax: ' + a.fax : '', 'va-sub');
        col.appendChild(box);
    } else {
        const b = vaEl('button', 'va-new', 'New Address');
        b.type = 'button';
        b.addEventListener('click', () => vaOpenAddress(kind));
        col.appendChild(b);
    }
    parent.appendChild(col);
}

function vaRender() {
    const box = $('va-block');
    if (!box) return;
    box.innerHTML = '';
    if (!VA.vendorId) { box.hidden = true; return; }
    box.hidden = false;

    if (VA.loading) { box.appendChild(vaEl('div', 'va-msg', 'Loading address…')); return; }
    if (VA.error) {
        const d = vaEl('div', 'va-err', 'Could not load vendor address: ' + VA.error + ' ');
        const r = vaEl('button', 'va-new', 'Retry');
        r.type = 'button';
        r.addEventListener('click', () => vaLoad(VA.vendorId, true));
        d.appendChild(r);
        box.appendChild(d);
        return;
    }
    const c = VA.contact;
    if (!c) return;

    if (VA.msg) box.appendChild(vaEl('div', 'va-ok', VA.msg));

    const cols = vaEl('div', 'va-cols');
    vaCol(cols, 'billing', 'Billing Address');
    vaCol(cols, 'shipping', 'Shipping Address');
    box.appendChild(cols);

    if (vaGstOn(c)) {
        const g = vaEl('div', 'va-gst');
        const l1 = vaEl('div');
        l1.appendChild(vaEl('span', 'va-k', 'GST Treatment: '));
        l1.appendChild(vaEl('span', '', c.gst_treatment ? vaGstLabel(c.gst_treatment) : 'Not set'));
        l1.appendChild(document.createTextNode(' '));
        l1.appendChild(vaPencilBtn('Edit GST treatment', () => vaOpenGst(false)));
        g.appendChild(l1);

        const r = NV_GST_BY[c.gst_treatment];
        const no = vaStr(c.gst_no);
        if ((r && r.reg) || no) {
            const l2 = vaEl('div', 'va-gstin');
            l2.appendChild(vaEl('span', 'va-k', 'GSTIN: '));
            l2.appendChild(vaEl('span', '', no || '—'));
            l2.appendChild(document.createTextNode(' '));
            l2.appendChild(vaPencilBtn('Edit GSTIN', () => vaOpenGst(true)));
            g.appendChild(l2);
        }
        box.appendChild(g);
    }
}

// ---------- shared modal helpers ----------
function vaMark(el, msg) {
    if (!el) return;
    el.classList.toggle('invalid', !!msg);
    const h = el.closest('.va-f');
    if (!h) return;
    let fe = h.querySelector(':scope > .nv-fe');
    if (msg) {
        if (!fe) { fe = document.createElement('div'); fe.className = 'nv-fe'; h.appendChild(fe); }
        fe.textContent = msg;
    } else if (fe) fe.remove();
}

/** Builds one modal (any previous instance with the same id is removed first, so listeners never stack). */
function vaShell(id, title, bodyHtml, z) {
    const old = $(id);
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = id;
    ov.className = 'nv-overlay va-modal';
    ov.style.zIndex = String(z || 21000);
    ov.innerHTML =
        '<div class="nv-box" role="dialog" aria-modal="true">' +
        '<div class="nv-head"><h3></h3><button type="button" class="nv-x" data-x aria-label="Close">&times;</button></div>' +
        '<div class="nv-body">' + bodyHtml + '</div>' +
        '<div class="nv-foot"><button type="button" class="btn btn-primary" data-save>Save</button>' +
        '<button type="button" class="btn btn-secondary" data-cancel>Cancel</button>' +
        '<span class="va-status"></span></div></div>';
    ov.querySelector('h3').textContent = title;
    document.body.appendChild(ov);
    return ov;
}

function vaWireModal(ov, go) {
    const close = () => { if (!VA.saving) ov.remove(); };      // Cancel / X / outside click / Esc discard changes
    ov.querySelector('[data-x]').addEventListener('click', close);
    ov.querySelector('[data-cancel]').addEventListener('click', close);
    ov.querySelector('[data-save]').addEventListener('click', go);
    ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) close(); });
    ov.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
        else if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); go(); }
    });
}

async function vaPut(c, fields) {
    const body = Object.assign({ contact_name: c.contact_name }, fields);
    log('VENDOR_ADDRESS', 'PUT /contacts/' + c.contact_id, body);
    const d = await zbApi('PUT', '/contacts/' + c.contact_id, {}, body);
    const c2 = d.contact || null;
    if (c2) vendorSrc.upsert(normVendor(c2));
    return c2;
}

// ---------- Billing / Shipping address modal ----------
function vaSplitPhone(p) {
    p = vaStr(p);
    const m = /^(\+\d{1,4})[\s-]*(.*)$/.exec(p);
    return m ? { code: m[1], num: m[2] } : { code: '+91', num: p };
}

function vaOpenAddress(kind) {
    const c = VA.contact;
    if (!c || VA.saving) return;

    const cur = vaNorm(c[kind + '_address']);       // a fresh copy: billing and shipping never share data
    const other = vaNorm(c[(kind === 'billing' ? 'shipping' : 'billing') + '_address']);
    const has = vaHas(cur);
    const title = kind === 'billing' ? 'Billing Address' : (has ? 'Shipping Address' : 'Additional Address');
    const f = (l, inner) => '<div class="va-f"><label>' + l + '</label>' + inner + '</div>';

    const ov = vaShell('va-modal', title,
        f('Attention', '<input type="text" id="va_attention" maxlength="100" autocomplete="off">') +
        f('Country/Region', '<select id="va_country"></select>') +
        f('Address', '<textarea id="va_address" rows="2" placeholder="Street 1" maxlength="255"></textarea>' +
            '<textarea id="va_street2" rows="2" placeholder="Street 2" maxlength="255" style="margin-top:8px"></textarea>') +
        f('City', '<input type="text" id="va_city" maxlength="100" autocomplete="off">') +
        '<div class="va-grid2">' +
        f('State', '<input type="text" id="va_state" list="va-states" placeholder="Select or type to add" maxlength="100" autocomplete="off">') +
        f('Pin Code', '<input type="text" id="va_zip" maxlength="10" autocomplete="off">') + '</div>' +
        '<div class="va-grid2">' +
        f('Phone', '<div class="va-phone"><select id="va_code"></select><input type="text" id="va_phone" inputmode="tel" maxlength="20" autocomplete="off"></div>') +
        f('Fax Number', '<input type="text" id="va_fax" maxlength="30" autocomplete="off">') + '</div>' +
        '<p class="va-note"><b>Note:</b> Changes made here will be updated for this vendor.</p>' +
        '<datalist id="va-states"></datalist>');

    const q = (id) => ov.querySelector('#' + id);
    const status = ov.querySelector('.va-status');
    const save = ov.querySelector('[data-save]');

    // country
    const csel = q('va_country');
    const countries = NV_COUNTRIES.slice();
    const defCountry = cur.country || other.country || ((state.org || {}).country_code === 'IN' ? 'India' : '');
    if (defCountry && countries.indexOf(defCountry) < 0) countries.unshift(defCountry);
    nvFill(csel, countries.map((x) => [x, x]), 'Select');
    csel.value = defCountry;

    // states for the chosen country (India list; other countries accept free text)
    const fillStates = () => {
        const dl = q('va-states');
        dl.innerHTML = '';
        if (/^india$/i.test(csel.value)) NV_STATES.forEach((s) => dl.appendChild(new Option('', s[1])));
    };
    fillStates();
    csel.addEventListener('change', fillStates);

    // phone
    const ph = vaSplitPhone(cur.phone);
    nvFill(q('va_code'), NV_DIAL.map((x) => [x, x]), null);
    if (NV_DIAL.indexOf(ph.code) < 0) q('va_code').appendChild(new Option(ph.code, ph.code));
    q('va_code').value = ph.code;
    q('va_phone').value = ph.num;

    q('va_attention').value = cur.attention;
    q('va_address').value = cur.address;
    q('va_street2').value = cur.street2;
    q('va_city').value = cur.city;
    q('va_state').value = cur.state;
    q('va_zip').value = cur.zip;
    q('va_fax').value = cur.fax;

    function read() {
        const g = (id) => String(q(id).value).trim();
        const o = {
            attention: g('va_attention'), country: g('va_country'), address: g('va_address'), street2: g('va_street2'),
            city: g('va_city'), state: g('va_state'), zip: g('va_zip'),
            phone: g('va_phone') ? q('va_code').value + ' ' + g('va_phone') : '', fax: g('va_fax'), state_code: ''
        };
        if (/^india$/i.test(o.country) && o.state) {
            const st = NV_STATES.find((s) => s[1].toLowerCase() === o.state.toLowerCase());
            if (st) { o.state = st[1]; o.state_code = st[0]; }
        }
        return o;
    }

    function validate(o) {
        ov.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
        ov.querySelectorAll('.nv-fe').forEach((e) => e.remove());
        if (!vaHas(o)) return 'Enter at least one address detail before saving.';

        const errs = [];
        const bad = (id, m) => { vaMark(q(id), m); errs.push(m); };
        const india = /^india$/i.test(o.country);

        if (india && o.state && !o.state_code) bad('va_state', 'Select a valid Indian state');
        if (o.zip) {
            if (india && !/^[1-9]\d{5}$/.test(o.zip)) bad('va_zip', 'Enter a valid 6-digit PIN code');
            else if (!india && !/^[A-Za-z0-9][A-Za-z0-9 \-]{1,9}$/.test(o.zip)) bad('va_zip', 'Enter a valid postal code');
        }
        const pnum = String(q('va_phone').value).trim();
        if (pnum && (!/^[0-9 ()\-]+$/.test(pnum) || pnum.replace(/\D/g, '').length < 6 || pnum.replace(/\D/g, '').length > 15)) {
            bad('va_phone', 'Enter a valid phone number');
        }
        if (o.fax && (!/^[0-9 ()+\-]+$/.test(o.fax) || o.fax.replace(/\D/g, '').length < 6 || o.fax.replace(/\D/g, '').length > 15)) {
            bad('va_fax', 'Enter a valid fax number');
        }
        if (errs.length) { const f = ov.querySelector('.invalid'); if (f && f.focus) f.focus(); return errs[0]; }
        return '';
    }

    async function go() {
        if (VA.saving) return;
        const o = read();
        const err = validate(o);
        status.textContent = err;
        if (err) return;

        VA.saving = true;
        save.disabled = true;
        status.textContent = '';
        const label = kind === 'billing' ? 'Billing' : 'Shipping';
        try {
            const nc = await vaPut(c, { [kind + '_address']: o });
            const saved = (nc && vaHas(nc[kind + '_address'])) ? nc[kind + '_address'] : o;
            c[kind + '_address'] = saved;            // c is the cached contact, so it stays consistent
            VA.saving = false;
            ov.remove();
            if (VA.contact === c) vaToast(label + ' address updated.');
        } catch (e) {
            logError('VENDOR_ADDRESS', 'Save failed', e);
            VA.saving = false;
            save.disabled = false;
            status.textContent = 'Save failed: ' + (e.message || 'Request failed');
        }
    }

    vaWireModal(ov, go);
    setTimeout(() => q('va_attention').focus(), 30);
}

// ---------- GST Treatment / GSTIN modal ----------
function vaOpenGst(focusGstin) {
    const c = VA.contact;
    if (!c || VA.saving) return;

    const f = (l, inner, id) => '<div class="va-f"' + (id ? ' id="' + id + '"' : '') + '><label>' + l + '</label>' + inner + '</div>';
    const ov = vaShell('vg-modal', 'GST Details',
        f('GST Treatment*', '<select id="vg_treat"></select>') +
        f('GSTIN / UIN', '<input type="text" id="vg_gstin" maxlength="15" autocomplete="off">', 'vg-row') +
        '<p class="va-note"><b>Note:</b> Changes made here will be updated for this vendor.</p>');

    const q = (id) => ov.querySelector('#' + id);
    const sel = q('vg_treat'), gin = q('vg_gstin'), status = ov.querySelector('.va-status'), save = ov.querySelector('[data-save]');

    nvFill(sel, NV_GST.map((t) => [t.value, t.label]), 'Select a GST treatment');
    if (c.gst_treatment && !NV_GST_BY[c.gst_treatment]) sel.appendChild(new Option(vaGstLabel(c.gst_treatment), c.gst_treatment));
    sel.value = c.gst_treatment || '';
    gin.value = vaStr(c.gst_no);

    const isReg = () => { const r = NV_GST_BY[sel.value]; return r ? !!r.reg : !!vaStr(c.gst_no); };
    const sync = () => {
        q('vg-row').hidden = !isReg();
        const r = NV_GST_BY[sel.value];
        q('vg-row').querySelector('label').textContent = (r && r.req) ? 'GSTIN / UIN*' : 'GSTIN / UIN';
    };
    sel.addEventListener('change', sync);
    gin.addEventListener('input', () => { gin.value = gin.value.toUpperCase(); });
    sync();

    async function go() {
        if (VA.saving) return;
        ov.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
        ov.querySelectorAll('.nv-fe').forEach((e) => e.remove());
        status.textContent = '';

        const r = NV_GST_BY[sel.value], reg = isReg(), no = gin.value.trim().toUpperCase();
        if (!sel.value) { vaMark(sel, 'Select a GST treatment'); return; }
        if (reg && r && r.req && !no) { vaMark(gin, 'GSTIN is required for this GST treatment'); return; }
        if (reg && no && !GSTIN_RE.test(no)) { vaMark(gin, 'Enter a valid 15-character GSTIN'); return; }

        VA.saving = true;
        save.disabled = true;
        try {
            const nc = await vaPut(c, { gst_treatment: sel.value, gst_no: reg ? no : '' });
            c.gst_treatment = (nc && nc.gst_treatment) || sel.value;
            c.gst_no = (nc && nc.gst_no !== undefined) ? nc.gst_no : (reg ? no : '');
            VA.saving = false;
            ov.remove();
            if (VA.contact === c) vaToast('GST details updated.');
        } catch (e) {
            logError('VENDOR_ADDRESS', 'GST save failed', e);
            VA.saving = false;
            save.disabled = false;
            status.textContent = 'Save failed: ' + (e.message || 'Request failed');
        }
    }

    vaWireModal(ov, go);
    setTimeout(() => { if (focusGstin && !q('vg-row').hidden) gin.focus(); else sel.focus(); }, 30);
}

// ============================================================
// LOCATION
// ============================================================
state.locations = [];

// antigravity update with location GST details mapping
function mapLocation(l, depth = 0) {
    const a = l.address || {};
    const children = (l.child_locations || [])
        .filter((c) => c.is_location_active !== false && c.status !== 'inactive')
        .map((c) => mapLocation(c, depth + 1));
    const o = {
        id: String(l.location_id),
        name: l.location_name,
        primary: !!l.is_primary_location,
        depth: depth,
        attention: a.attention || '',
        street1: a.street_address1 || '',
        street2: a.street_address2 || '',
        city: a.city || '',
        state: a.state || l.state || '',
        state_code: a.state_code || l.state_code || '',
        zip: a.postal_code || '',
        country: a.country || '',
        phone: l.phone || '',
        gst_no: l.gst_no || a.gst_no || l.gstin || a.gstin || '',
        is_sez: !!(l.is_sez || a.is_sez || /special_economic_zone|sez_developer/i.test(l.tax_treatment || a.tax_treatment || '')),
        tax_treatment: l.tax_treatment || a.tax_treatment || '',
        raw: l,
        fromLocation: true,
        children: children
    };
    o.lines = adLines(o);
    return o;
}

async function loadLocations() {
    try {
        const data = await zbApi('GET', '/locations', { is_hierarchical_response: 'true' });
        state.locations = (data.locations || [])
            .filter((l) => !l.parent_location_id && (l.depth || 0) === 0)
            .filter((l) => l.is_location_active !== false && l.status !== 'inactive')
            .map((l) => mapLocation(l, 0));
        log('LOCATION', `Loaded ${state.locations.length} root locations`, state.locations);
    } catch (err) {
        state.locations = [];
        logError('LOCATION', 'Could not load locations (org may not use locations)', err);
    }
}

/** Turns a native <select> into a searchable dropdown. */
function lkEnhance(sel, opt) {
    opt = opt || {};
    const wrap = document.createElement('div');
    wrap.className = 'lk po-w';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('lk-native');

    const box = document.createElement('div');
    box.className = 'lk-box';
    const text = document.createElement('input');
    text.type = 'text'; text.readOnly = true; text.className = 'lk-text'; text.autocomplete = 'off';
    box.appendChild(text);

    let clearBtn = null;
    if (opt.clearable) {
        clearBtn = document.createElement('button');
        clearBtn.type = 'button'; clearBtn.className = 'lk-x'; clearBtn.title = 'Clear'; clearBtn.innerHTML = '&times;';
        box.appendChild(clearBtn);
    }
    const chev = document.createElement('span');
    chev.className = 'lk-chev';
    box.appendChild(chev);
    wrap.appendChild(box);

    const panel = document.createElement('div');
    panel.className = 'lk-panel';
    panel.hidden = true;
    panel.innerHTML =
        '<div class="lk-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a94a6" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
        '<input type="text" placeholder="Search" autocomplete="off"></div><div class="lk-list"></div>';
    document.body.appendChild(panel);
    const search = panel.querySelector('input');
    const list = panel.querySelector('.lk-list');

    let foot = null;
    let noteEl = null;

    function renderFooter(footerItems, noteHtml) {
        if (foot) { foot.remove(); foot = null; }
        if (noteEl) { noteEl.remove(); noteEl = null; }

        if (footerItems && footerItems.length) {
            foot = document.createElement('div');
            foot.className = 'lk-foot';
            footerItems.forEach((f) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'lk-foot-btn';
                const ic = document.createElement('span');
                ic.className = 'lk-plus' + (f.icon && f.icon !== '+' ? ' lk-ico' : '');
                ic.textContent = f.icon || '+';
                const tx = document.createElement('span');
                tx.textContent = f.label;
                b.appendChild(ic);
                b.appendChild(tx);
                b.addEventListener('mousedown', (ev) => { ev.preventDefault(); close(); f.onClick(); });
                foot.appendChild(b);
            });
            panel.appendChild(foot);
        }

        if (noteHtml) {
            noteEl = document.createElement('div');
            noteEl.className = 'lk-note';
            noteEl.innerHTML = noteHtml;
            panel.appendChild(noteEl);
        }
    }

    if ((opt.footer && opt.footer.length) || opt.note) {
        renderFooter(opt.footer, opt.note);
    }

    sel._updateFooter = renderFooter;

    const st = { open: false, active: 0, items: [] };

    function sync() {
        const o = sel.options[sel.selectedIndex];
        text.value = (o && o.value !== '') ? o.text : '';
        text.placeholder = opt.placeholder || 'Select';
        if (clearBtn) clearBtn.hidden = !(o && o.value !== '');
    }

    function paint() {
        const q = search.value.trim().toLowerCase();
        st.items = Array.prototype.filter.call(sel.options, (o) => o.value !== '' && (!q || o.text.toLowerCase().indexOf(q) > -1));
        list.innerHTML = '';
        st.lastGroup = '';
        if (!st.items.length) {
            const m = document.createElement('div');
            m.className = 'lk-msg';
            m.textContent = opt.emptyText || 'No matches found';
            list.appendChild(m);
            return;
        }
        if (st.active >= st.items.length) st.active = 0;

        st.items.forEach((o, i) => {
            const group = o.parentElement &&
                o.parentElement.tagName === 'OPTGROUP'
                ? o.parentElement.label
                : '';

            if (group && group !== st.lastGroup) {
                const heading = document.createElement('div');
                heading.className = 'lk-group-heading';
                const titleSpan = document.createElement('span');
                titleSpan.textContent = group;
                const arrSpan = document.createElement('span');
                arrSpan.className = 'lk-group-arr';
                arrSpan.textContent = '▲';
                heading.appendChild(titleSpan);
                heading.appendChild(arrSpan);
                list.appendChild(heading);
            }

            st.lastGroup = group;

            const d = document.createElement('div');

            d.className =
                'lk-item' +
                (i === st.active ? ' active' : '') +
                (o.value === sel.value ? ' chosen' : '');

            if (o.dataset.description) {
                const main = document.createElement('div');
                main.className = 'tax-option-title';
                main.textContent = o.text;

                const desc = document.createElement('div');
                desc.className = 'tax-option-description';
                desc.textContent = o.dataset.description;

                d.appendChild(main);
                d.appendChild(desc);
            } else {
                d.textContent = o.text;
            }

            d.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                choose(i);
            });

            d.addEventListener('mouseenter', () => {
                st.active = i;
                setActive();
            });

            list.appendChild(d);
        });

    }

    function setActive() {
        list.querySelectorAll('.lk-item').forEach((n, i) => n.classList.toggle('active', i === st.active));
        const a = list.querySelector('.lk-item.active');
        if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
    }

    function place() {
        const r = box.getBoundingClientRect();
        const minW = opt.panelWidth || 240;
        const w = Math.max(r.width, minW);
        panel.style.width = w + 'px';
        panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
        const below = window.innerHeight - r.bottom - 12;
        if (below >= 200 || below >= r.top) {
            panel.style.top = (r.bottom + 4) + 'px'; panel.style.bottom = 'auto';
            panel.style.maxHeight = Math.max(140, Math.min(360, below)) + 'px';
        } else {
            panel.style.bottom = (window.innerHeight - r.top + 4) + 'px'; panel.style.top = 'auto';
            panel.style.maxHeight = Math.max(140, Math.min(360, r.top - 12)) + 'px';
        }
    }

    function open() {
        if (st.open) return;
        st.open = true;
        panel.hidden = false;
        box.classList.add('open');
        search.value = '';
        st.active = Math.max(0, Array.prototype.filter.call(sel.options, (o) => o.value !== '').findIndex((o) => o.value === sel.value));
        paint(); place();
        setTimeout(() => search.focus(), 0);
    }
    function close() {
        if (!st.open) return;
        st.open = false;
        panel.hidden = true;
        box.classList.remove('open');
    }
    function choose(i) {
        const o = st.items[i];
        if (!o) return;
        sel.value = o.value;
        sync(); close();
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    box.addEventListener('click', (ev) => {
        if (ev.target === clearBtn) return;
        if (st.open) close(); else open();
    });
    if (clearBtn) {
        clearBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            sel.value = '';
            sync(); close();
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }
    text.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === 'ArrowDown' || ev.key === ' ') { ev.preventDefault(); open(); }
    });
    search.addEventListener('input', () => { st.active = 0; paint(); });
    search.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); st.active = Math.min(st.items.length - 1, st.active + 1); setActive(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); st.active = Math.max(0, st.active - 1); setActive(); }
        else if (ev.key === 'Enter') { ev.preventDefault(); choose(st.active); }
        else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); text.focus(); }
        else if (ev.key === 'Tab') close();
    });
    const onDown = (ev) => {
        if (!wrap.isConnected) { cleanup(); return; }
        if (st.open && !panel.contains(ev.target) && !box.contains(ev.target)) close();
    };
    const onScroll = (ev) => { if (st.open && !panel.contains(ev.target)) place(); };
    const onResize = () => { if (st.open) place(); };
    function cleanup() {
        document.removeEventListener('mousedown', onDown);
        document.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
        panel.remove();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    sel._sync = sync;
    sync();
}


function initLocationField() {
    const sel = $('po-location');
    const row = sel.closest('.po-row');

    if (!state.locations.length) {
        row.hidden = true;
        return;
    }

    row.hidden = false;
    sel.innerHTML = '';
    sel.appendChild(new Option('', ''));

    // First field: ROOT/PARENT locations only.
    getRootLocations().forEach((loc) => {
        sel.appendChild(new Option(loc.name, loc.id));
    });

    const def =
        state.locations.find(
            (l) => /^head\s*office$/i.test(String(l.name).trim())
        ) ||
        state.locations.find((l) => l.primary) ||
        state.locations[0];

    if (def) sel.value = def.id;

    lkEnhance(sel, {
        clearable: true,
        placeholder: 'Select a location',
        emptyText: 'No locations found'
    });

    sel.addEventListener('change', () => {
        markDirty();

        // Refresh Delivery Address options.
        if (DEL.ready && deliverMode() === 'location') {
            refreshDeliveryTarget(false);
        }

        // Refresh third Warehouse Location dropdown.
        refreshWarehouseLocation();

        // Refresh all item-line warehouse options.
        refreshItemLineLocations();

        refreshStockInfo();

        // antigravity update with location change line item GST update
        if (typeof updateAllLineItemGst === 'function') {
            updateAllLineItemGst(true);
        }
    });
}


// ============================================================
// DELIVERY ADDRESS
// ============================================================

const DEL = { ready: false, options: [] };

function deliverMode() {
    const r = document.querySelector('input[name="deliver_to"]:checked');
    return r ? r.value : 'location';
}

function buildDeliveryOptions() {
    if (deliverMode() === 'customer') {
        if (CU.chosen) return [CU.chosen];
        const so = state.salesOrder || {};
        if (!so.customerId) return [];
        const a = so.shippingAddress || {};
        return [{
            id: String(so.customerId),
            name: so.customerName || 'Customer',
            attention: a.attention || '',
            lines: [a.address || a.street_address1, a.street2 || a.street_address2, a.city, a.state, a.zip || a.postal_code, a.country]
                .filter(Boolean)
        }];
    }

    const selId = $('po-location') ? $('po-location').value : '';
    const allFlat = flatLocations();
    const parent = allFlat.find((l) => l.id === selId);
    if (parent) {
        function collect(node) {
            let res = [node];
            (node.children || []).forEach((c) => { res = res.concat(collect(c)); });
            return res;
        }
        const rootNode = state.locations.find((l) => l.id === selId) || parent;
        return collect(rootNode);
    }

    return allFlat;
}

function renderDeliveryAddress() {
    const id = $('delivery-target').value;
    const opt = DEL.options.find((o) => o.id === id);
    $('delivery-addr-name').textContent = opt ? (opt.attention || opt.name) : '';
    $('delivery-addr-lines').innerHTML = opt
        ? opt.lines.map((x) => `<div>${escapeHtml(x)}</div>`).join('')
        : '';
    if (typeof updateAllLineItemGst === 'function') updateAllLineItemGst(true);
}

function refreshDeliveryTarget(keepSelection) {
    const sel = $('delivery-target');
    const prev = keepSelection ? sel.value : '';

    DEL.options = buildDeliveryOptions();
    sel.innerHTML = '';
    DEL.options.forEach((o) => {
        const indent = '\u00A0\u00A0'.repeat(o.depth || 0);
        const prefix = o.depth ? '└ ' : '';
        sel.appendChild(new Option(indent + prefix + o.name, o.id));
    });

    const exists = DEL.options.some((o) => o.id === prev);
    sel.value = exists ? prev : (DEL.options[0] ? DEL.options[0].id : '');

    if (sel._sync) sel._sync();
    renderDeliveryAddress();
    cuSync();
}

function initDeliveryField() {
    const sel = $('delivery-target');

    if (!state.locations.length) {
        const locRadio = document.querySelector('input[name="deliver_to"][value="location"]');
        locRadio.closest('label').hidden = true;
        document.querySelector('input[name="deliver_to"][value="customer"]').checked = true;
    }


    lkEnhance(sel, { placeholder: 'Select', emptyText: 'No matches found' });
    cuBuild();

    document.querySelectorAll('input[name="deliver_to"]').forEach((r) =>
        r.addEventListener('change', () => { refreshDeliveryTarget(false); markDirty(); }));
    sel.addEventListener('change', () => { renderDeliveryAddress(); markDirty(); });

    $('btn-change-dest').addEventListener('click', (ev) => {
        ev.stopPropagation();
        adToggle();
    });

    DEL.ready = true;
    refreshDeliveryTarget(false);
}


// ============================================================
// DELIVERY: CUSTOMER PICKER
//   Data : GET /contacts?contact_type=customer (customerSrc: IndexedDB + memory, paginated)
//   Pick : GET /contacts/{id} -> shipping_address (billing_address as fallback)
// ============================================================

const CU = {
    built: false, el: null, input: null, open: false, query: '', sq: '', active: 0, items: [],
    loading: false, error: '', timer: null, limit: 60, pending: false, chosen: null, token: 0
};

function normCustomer(c) {
    const name = c.contact_name || c.customer_name || '';
    const company = c.company_name || '';
    const number = c.contact_number || c.customer_number || '';
    const email = c.email || '';
    return {
        id: String(c.contact_id),
        name, companyName: company, number, email,
        status: String(c.status || 'active').toLowerCase(),
        _k: (name + ' ' + company + ' ' + number + ' ' + email).toLowerCase()
    };
}

const customerSrc = createSource({
    entity: 'customers_v2',
    idOf: (c) => c.id,
    compare: (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    fetchPage: async (page, per, search) => {
        const q = { contact_type: 'customer', filter_by: 'Status.Active', page, per_page: per, sort_column: 'contact_name' };
        if (search) q.search_text = search;
        const d = await zbApi('GET', '/contacts', q);
        const records = (d.contacts || [])
        .filter((c) => !c.contact_type || String(c.contact_type).toLowerCase() === 'customer')
        .filter((c) => String(c.status || 'active').toLowerCase() === 'active')
        .map(normCustomer);
        return { records, hasMore: (d.page_context || {}).has_more_page === true };
    }
});
customerSrc.onChange = () => { if (CU.open) cuPaint(); };

const cuQ = () => (CU.query.length >= 2 ? CU.query : '');
const CU_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="12" height="18" rx="1"/><path d="M16 9h4v12h-4"/><path d="M8 7h4M8 11h4M8 15h4"/></svg>';

function cuBuild() {
    if (CU.built) return;
    const sel = $('delivery-target');
    if (!sel) return;
    const lk = sel.closest('.lk') || sel;
    CU.built = true;

    const box = document.createElement('div');
    box.id = 'cu-wrap';
    box.className = 'vendor-wrap';
    box.hidden = true;
    box.innerHTML =
        '<div class="vendor-combobox">' +
        '<input type="text" class="form-control" readonly placeholder="Select Customer" autocomplete="off">' +
        '<div class="vendor-dropdown vp-panel">' +
        '<div class="vp-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a94a6" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
        '<input type="text" class="cu-search" placeholder="Search" autocomplete="off"></div>' +
        '<div class="vp-list cu-list" role="listbox"></div>' +
        '</div>' +
        '</div>' +
        '<button type="button" class="vendor-go" title="Search customers" aria-label="Search customers">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg></button>';
    lk.after(box);
    CU.el = box;
    CU.input = box.querySelector('.form-control');

    const combo = box.querySelector('.vendor-combobox');
    const search = box.querySelector('.cu-search');
    const list = box.querySelector('.cu-list');

    combo.addEventListener('click', (ev) => {
        if (ev.target.closest('.vendor-dropdown')) return;
        if (CU.open) cuClose(); else cuOpen();
    });
    box.querySelector('.vendor-go').addEventListener('click', (ev) => { ev.stopPropagation(); csOpen(); });
    CU.input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === 'ArrowDown' || ev.key === ' ') { ev.preventDefault(); cuOpen(); }
    });

    search.addEventListener('input', () => {
        CU.query = search.value.trim();
        CU.active = 0; CU.limit = 60; CU.error = '';
        list.scrollTop = 0;
        cuPaint();
        clearTimeout(CU.timer);
        CU.timer = setTimeout(() => { CU.sq = CU.query; if (cuQ()) cuFetchMore(); }, 350);
    });
    search.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); cuSetActive(CU.active + 1, true); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); cuSetActive(CU.active - 1, true); }
        else if (ev.key === 'Enter') { ev.preventDefault(); cuChoose(CU.active); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cuClose(); CU.input.focus(); }
        else if (ev.key === 'Tab') cuClose();
    });
    attachInfiniteScroll(list, cuNear);
    document.addEventListener('mousedown', (ev) => {
        if (CU.open && !combo.contains(ev.target)) cuClose();
    });
}

/** Shows the customer picker in Customer mode and the location dropdown in Locations mode. */
function cuSync() {
    if (!CU.built) return;
    const sel = $('delivery-target');
    const lk = sel.closest('.lk');
    const customer = deliverMode() === 'customer';
    if (lk) lk.hidden = customer;
    CU.el.hidden = !customer;
    if (!customer) { cuClose(); return; }
    const opt = DEL.options.find((o) => o.id === sel.value);
    CU.input.value = opt ? opt.name : '';
}

function cuOpen() {
    if (CU.open) return;
    CU.open = true;
    CU.query = ''; CU.sq = ''; CU.active = 0; CU.limit = 60; CU.error = '';
    const combo = CU.el.querySelector('.vendor-combobox');
    combo.classList.add('open');
    combo.querySelector('.vendor-dropdown').classList.add('open');
    const s = CU.el.querySelector('.cu-search');
    s.value = '';
    cuPaint();
    (async () => {
        CU.loading = true; cuPaint();
        try { await customerSrc.init(); }
        catch (e) { CU.error = e.message || 'Request failed'; logError('CUSTOMER', 'Customer fetch failed', e); }
        CU.loading = false; cuPaint();
    })();
    customerSrc.staleCheck();
    setTimeout(() => s.focus(), 0);
}

function cuClose() {
    if (!CU.open) return;
    CU.open = false;
    clearTimeout(CU.timer);
    const combo = CU.el.querySelector('.vendor-combobox');
    combo.classList.remove('open');
    combo.querySelector('.vendor-dropdown').classList.remove('open');
}

function cuMsg(list, text, retry) {
    const d = document.createElement('div');
    d.className = 'vp-msg';
    d.textContent = text;
    if (retry) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-secondary'; b.textContent = 'Retry';
        b.addEventListener('mousedown', (ev) => { ev.preventDefault(); CU.error = ''; cuFetchMore(); });
        d.appendChild(document.createElement('br'));
        d.appendChild(b);
    }
    list.appendChild(d);
}

function cuPaint() {
    if (!CU.open) return;
    const list = CU.el.querySelector('.cu-list');
    const all = customerSrc.view(CU.query);
    CU.items = all;
    const top = list.scrollTop;
    list.innerHTML = '';

    if (!all.length) {
        if (CU.loading) cuMsg(list, 'Loading customers…');
        else if (CU.error) cuMsg(list, 'Could not load customers: ' + CU.error, true);
        else if (customerSrc.canMore(cuQ())) {
            cuMsg(list, 'Searching Zoho Books…');
            if (!CU.query) setTimeout(cuFetchMore, 0);
        } else cuMsg(list, 'No customers found');
        return;
    }

    const shown = Math.min(all.length, CU.limit);
    if (CU.active >= shown) CU.active = 0;
    const chosenId = $('delivery-target').value;

    all.slice(0, shown).forEach((c, i) => {
        const d = document.createElement('div');
        d.className = 'vp-item' + (i === CU.active ? ' active' : '') + (c.id === chosenId ? ' chosen' : '');
        d.setAttribute('role', 'option');
        d.dataset.i = String(i);

        const av = document.createElement('span');
        av.className = 'vp-av';
        av.textContent = (c.name.trim().charAt(0) || '?').toUpperCase();
        d.appendChild(av);

        const tx = document.createElement('div');
        tx.className = 'vp-tx';
        const nm = document.createElement('span');
        nm.className = 'vp-nm';
        nm.textContent = c.name;
        if (c.number) {
            const no = document.createElement('span');
            no.className = 'vp-no';
            no.textContent = '| ' + c.number;
            nm.appendChild(no);
        }
        tx.appendChild(nm);
        const sub = document.createElement('span');
        sub.className = 'vp-sub cu-sub';
        sub.innerHTML = CU_ICON;
        sub.appendChild(document.createTextNode(c.companyName || c.name));
        tx.appendChild(sub);
        d.appendChild(tx);

        d.addEventListener('mousedown', (ev) => { ev.preventDefault(); cuChoose(i); });
        d.addEventListener('mouseenter', () => cuSetActive(i, false));
        list.appendChild(d);
    });

    if (CU.loading) cuMsg(list, 'Loading more…');
    else if (CU.error) cuMsg(list, 'Could not load more customers.', true);
    list.scrollTop = top;

    const more = CU.limit < all.length || (customerSrc.canMore(cuQ()) && (!CU.query || CU.sq === CU.query));
    if (!CU.loading && !CU.error && more && list.scrollHeight <= list.clientHeight + 40) setTimeout(cuNear, 0);
}

function cuSetActive(i, scroll) {
    const nodes = CU.el.querySelectorAll('.cu-list .vp-item');
    if (!nodes.length) return;
    CU.active = Math.max(0, Math.min(nodes.length - 1, i));
    nodes.forEach((n) => n.classList.toggle('active', Number(n.dataset.i) === CU.active));
    if (scroll && nodes[CU.active].scrollIntoView) nodes[CU.active].scrollIntoView({ block: 'nearest' });
}

function cuNear() {
    if (!CU.open) return;
    if (CU.limit < CU.items.length) { CU.limit += 60; cuPaint(); return; }
    if (!CU.error) cuFetchMore();
}

function cuFetchMore() {
    if (CU.loading) { CU.pending = true; return; }
    const q = cuQ();
    if (!customerSrc.canMore(q)) return;
    CU.loading = true; CU.error = '';
    cuPaint();
    customerSrc.loadMore(q)
        .catch((e) => { CU.error = e.message || 'Request failed'; logError('CUSTOMER', 'Customer fetch failed', e); })
        .then(() => {
            CU.loading = false;
            cuPaint();
            const again = CU.pending && !CU.error;
            CU.pending = false;
            if (again) cuFetchMore();
        });
}

function cuApply() {
    refreshDeliveryTarget(false);   // customer branch of buildDeliveryOptions() returns CU.chosen
    markDirty();
}

async function cuChoose(i) {
    const c = CU.items[i];
    if (!c) return;
    cuClose();
    return cuChooseRec(c);
}

async function cuChooseRec(c) {
    const my = ++CU.token;
    CU.chosen = { id: c.id, name: c.name, attention: '', lines: [] };
    cuApply();                      // name shows at once, address follows

    try {
        const full = await vaFetchContact(c.id);
        if (my !== CU.token || !full) return;
        const a = vaHas(vaNorm(full.shipping_address)) ? vaNorm(full.shipping_address) : vaNorm(full.billing_address);
        CU.chosen.lines = [a.address, a.street2, a.city, a.state, a.zip, a.country].filter(Boolean);
        cuApply();
    } catch (e) {
        logError('CUSTOMER', 'Could not load customer address', e);
    }
}




// ============================================================
// ADVANCED CUSTOMER SEARCH (popup opened by the blue magnifier button)
//   GET /contacts?contact_type=customer&page=N&per_page=10
//   + contact_name_contains | company_name_contains | email_contains | phone_contains | search_text
// ============================================================

const CS = { built: false, el: null, field: 'number', text: '', page: 1, more: false, rows: [], loading: false, error: '', token: 0 };
const CS_PER = 10;
const CS_FIELDS = [['number', 'Customer Number'], ['name', 'Customer Name'], ['email', 'Email'], ['company', 'Company Name'], ['phone', 'Phone']];

function csParams() {
    const q = { contact_type: 'customer', filter_by: 'Status.Active', page: CS.page, per_page: CS_PER, sort_column: 'contact_name' };
    const t = CS.text;
    if (!t) return q;
    if (CS.field === 'name') q.contact_name_contains = t;
    else if (CS.field === 'company') q.company_name_contains = t;
    else if (CS.field === 'email') q.email_contains = t;
    else if (CS.field === 'phone') q.phone_contains = t;
    else q.search_text = t;
    return q;
}

async function csLoad() {
    const my = ++CS.token;
    CS.loading = true; CS.error = '';
    csPaint();
    try {
        const d = await zbApi('GET', '/contacts', csParams());
        if (my !== CS.token) return;
        let list = (d.contacts || [])
        .filter((c) => !c.contact_type || String(c.contact_type).toLowerCase() === 'customer')
        .filter((c) => String(c.status || 'active').toLowerCase() === 'active');
                let rows = list.map((c) => Object.assign(normCustomer(c), { phone: c.phone || c.mobile || '' }));
        customerSrc.upsert(rows.map((r) => ({ id: r.id, name: r.name, companyName: r.companyName, number: r.number, email: r.email, status: r.status, _k: r._k })));
        if (CS.field === 'number' && CS.text && rows.some((r) => r.number)) {
            const t = CS.text.toLowerCase();
            rows = rows.filter((r) => String(r.number).toLowerCase().indexOf(t) > -1);
        }
        CS.rows = rows;
        CS.more = (d.page_context || {}).has_more_page === true;
    } catch (e) {
        if (my !== CS.token) return;
        CS.rows = []; CS.more = false;
        CS.error = e.message || 'Request failed';
        logError('CUSTOMER', 'Advanced search failed', e);
    }
    CS.loading = false;
    csPaint();
}

function csPaint() {
    if (!CS.el) return;
    const body = CS.el.querySelector('.cs-body');
    body.innerHTML = '';
    const th = document.createElement('div');
    th.className = 'cs-th';
    ['Customer Name', 'Email', 'Company Name', 'Phone'].forEach((t) => { const s = document.createElement('span'); s.textContent = t; th.appendChild(s); });
    body.appendChild(th);

    const msg = (text, retry) => {
        const d = document.createElement('div');
        d.className = 'cs-msg';
        d.textContent = text;
        if (retry) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn btn-secondary'; b.setAttribute('data-retry', '1'); b.textContent = 'Retry';
            d.appendChild(document.createElement('br'));
            d.appendChild(b);
        }
        body.appendChild(d);
    };

    if (CS.loading) msg('Loading customers…');
    else if (CS.error) msg('Could not load customers: ' + CS.error, true);
    else if (!CS.rows.length) msg('No customers found');
    else {
        CS.rows.forEach((r, i) => {
            const tr = document.createElement('div');
            tr.className = 'cs-tr';

            const c1 = document.createElement('div');
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'cs-nm'; b.dataset.i = String(i); b.textContent = r.name; b.title = r.name;
            c1.appendChild(b);
            if (r.number) { const n = document.createElement('div'); n.className = 'cs-no'; n.textContent = r.number; c1.appendChild(n); }
            tr.appendChild(c1);

            [r.email, r.companyName, r.phone].forEach((v) => {
                const s = document.createElement('div');
                s.className = 'cs-cell'; s.textContent = v || ''; s.title = v || '';
                tr.appendChild(s);
            });
            body.appendChild(tr);
        });
    }

    const start = (CS.page - 1) * CS_PER + 1;
    CS.el.querySelector('.cs-range').textContent = CS.rows.length ? (start + ' - ' + (start + CS.rows.length - 1)) : '0';
    CS.el.querySelector('.cs-prev').disabled = CS.loading || CS.page <= 1;
    CS.el.querySelector('.cs-next').disabled = CS.loading || !CS.more;
}

function csSearch() {
    CS.text = CS.el.querySelector('.cs-text').value.trim();
    CS.field = CS.el.querySelector('.cs-field').value;
    CS.page = 1;
    csLoad();
}

function csClose() {
    if (!CS.el) return;
    CS.el.hidden = true;
    CS.token++;
}

function csBuild() {
    if (CS.built) return;
    CS.built = true;
    const ov = document.createElement('div');
    ov.className = 'cs-overlay';
    ov.hidden = true;
    ov.innerHTML =
        '<div class="cs-box" role="dialog" aria-modal="true" aria-label="Advanced Customer Search">' +
        '<div class="cs-head"><h3>Advanced Customer Search</h3><button type="button" class="cs-x" aria-label="Close">&times;</button></div>' +
        '<div class="cs-bar"><div class="cs-search"><select class="cs-field"></select>' +
        '<input type="text" class="cs-text" autocomplete="off"></div>' +
        '<button type="button" class="btn btn-primary cs-go">Search</button></div>' +
        '<div class="cs-body"></div>' +
        '<div class="cs-foot"><div class="cs-pager"><button type="button" class="cs-prev" aria-label="Previous">&#8249;</button>' +
        '<span class="cs-range">0</span><button type="button" class="cs-next" aria-label="Next">&#8250;</button></div></div>' +
        '</div>';
    document.body.appendChild(ov);
    CS.el = ov;

    const sel = ov.querySelector('.cs-field');
    CS_FIELDS.forEach((f) => sel.appendChild(new Option(f[1], f[0])));

    ov.querySelector('.cs-x').addEventListener('click', csClose);
    ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) csClose(); });
    ov.querySelector('.cs-go').addEventListener('click', csSearch);
    ov.querySelector('.cs-text').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); csSearch(); } });
    ov.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); csClose(); } });
    ov.querySelector('.cs-prev').addEventListener('click', () => { if (CS.page > 1) { CS.page--; csLoad(); } });
    ov.querySelector('.cs-next').addEventListener('click', () => { if (CS.more) { CS.page++; csLoad(); } });
    ov.querySelector('.cs-body').addEventListener('click', (ev) => {
        if (ev.target.closest('[data-retry]')) { csLoad(); return; }
        const b = ev.target.closest('.cs-nm');
        if (!b) return;
        const r = CS.rows[Number(b.dataset.i)];
        if (!r) return;
        csClose();
        cuChooseRec({ id: r.id, name: r.name });
    });
}

function csOpen() {
    csBuild();
    cuClose();
    CS.field = 'number'; CS.text = ''; CS.page = 1; CS.rows = []; CS.more = false; CS.error = '';
    CS.el.querySelector('.cs-field').value = 'number';
    CS.el.querySelector('.cs-text').value = '';
    CS.el.hidden = false;
    csLoad();
    setTimeout(() => CS.el.querySelector('.cs-text').focus(), 30);
}

// ============================================================
// DELIVERY ADDRESS BOOK
// ============================================================

const ADDR = {
    items: [], loaded: false, loading: false, error: '', readOnly: false,
    query: '', open: false, editId: null, saving: false, panel: null, modal: null
};

function adNorm(a) {
    return {
        id: String(a.address_id || a.org_address_id || a.id || ''),
        attention: a.attention || '',
        street1: a.address || a.street_address1 || a.street1 || '',
        street2: a.street2 || a.street_address2 || '',
        city: a.city || '',
        state: a.state || '',
        zip: a.zip || a.postal_code || '',
        country: a.country || '',
        phone: a.phone || ''
    };
}

function adLines(a) {
    const l = [];
    if (a.street1) l.push(a.street1);
    if (a.street2) l.push(a.street2);
    const cs = [a.city, a.state].filter(Boolean).join(', ');
    if (cs) l.push(cs);
    const cz = [a.country, a.zip].filter(Boolean).join(' , ');
    if (cz) l.push(cz);
    if (a.phone) l.push(a.phone);
    return l;
}

function adConfirm(title, text) {
    return new Promise((resolve) => {
        const b = document.createElement('div');
        b.className = 'confirm-dialog-backdrop';
        b.style.zIndex = '40000';
        b.innerHTML = `<div class="confirm-dialog"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>` +
            `<div class="confirm-dialog-actions"><button class="btn btn-secondary" id="ac-no">Cancel</button>` +
            `<button class="btn btn-primary" id="ac-yes">Delete</button></div></div>`;
        document.body.appendChild(b);
        b.querySelector('#ac-no').onclick = () => { b.remove(); resolve(false); };
        b.querySelector('#ac-yes').onclick = () => { b.remove(); resolve(true); };
    });
}

function adFromLocations() { return flatLocations(); }

async function adLoad(force) {
    if (ADDR.loading || (ADDR.loaded && !force)) return;
    ADDR.loading = true;
    ADDR.error = '';
    adPaint();

    const locItems = adFromLocations();
    let orgItems = [];

    try {
        const data = await zbApi('GET', '/organizations/address');
        log('ADDRESS', 'Address book raw response', data);
        const arr = Object.keys(data).map((k) => data[k]).find((v) => Array.isArray(v) && v.length) || [];
        orgItems = arr.map(adNorm).filter((a) => a.id);
    } catch (err) {
        logError('ADDRESS', 'Address book not available, showing location addresses only', err);
    }

    ADDR.items = locItems.concat(orgItems);
    ADDR.readOnly = false;
    ADDR.loaded = true;
    ADDR.loading = false;
    adPaint();
}

function adBuildPanel() {
    if (ADDR.panel) return;
    const p = document.createElement('div');
    p.className = 'ad-panel';
    p.hidden = true;
    p.innerHTML =
        '<div class="ad-search"><input type="text" placeholder="Search" autocomplete="off"></div>' +
        '<div class="ad-note" hidden></div>' +
        '<div class="ad-list"></div>' +
        '<div class="ad-foot"><button type="button" class="ad-new"><span class="vp-plus">+</span><span>New Address</span></button></div>';
    document.body.appendChild(p);
    ADDR.panel = p;

    p.querySelector('.ad-search input').addEventListener('input', (ev) => { ADDR.query = ev.target.value.trim().toLowerCase(); adPaint(); });
    p.querySelector('.ad-search input').addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); adClose(); } });
    p.querySelector('.ad-new').addEventListener('click', () => { adClose(); adOpenModal(null); });

    document.addEventListener('mousedown', (ev) => {
        if (ADDR.open && !p.contains(ev.target) && ev.target.id !== 'btn-change-dest') adClose();
    });
    document.addEventListener('scroll', (ev) => { if (ADDR.open && !p.contains(ev.target)) adPlace(); }, true);
    window.addEventListener('resize', () => { if (ADDR.open) adPlace(); });
}

function adPlace() {
    const a = $('btn-change-dest').getBoundingClientRect();
    const p = ADDR.panel;
    const w = Math.min(460, window.innerWidth - 16);
    p.style.width = w + 'px';
    p.style.left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8)) + 'px';
    const below = window.innerHeight - a.bottom - 12;
    if (below >= 260 || below >= a.top) {
        p.style.top = (a.bottom + 6) + 'px'; p.style.bottom = 'auto';
        p.style.maxHeight = Math.max(200, Math.min(440, below)) + 'px';
    } else {
        p.style.bottom = (window.innerHeight - a.top + 6) + 'px'; p.style.top = 'auto';
        p.style.maxHeight = Math.max(200, Math.min(440, a.top - 12)) + 'px';
    }
}

function adPaint() {
    if (!ADDR.open || !ADDR.panel) return;
    const list = ADDR.panel.querySelector('.ad-list');
    const note = ADDR.panel.querySelector('.ad-note');
    list.innerHTML = '';

    note.hidden = !ADDR.error;
    note.textContent = ADDR.error ? 'Showing location addresses only (address book unavailable: ' + ADDR.error + ')' : '';
    ADDR.panel.querySelector('.ad-new').disabled = false;

    if (ADDR.loading && !ADDR.items.length) { list.innerHTML = '<div class="ad-msg">Loading addresses…</div>'; return; }

    const q = ADDR.query;
    const items = ADDR.items.filter((a) => !q || (adLines(a).join(' ') + ' ' + a.attention).toLowerCase().indexOf(q) > -1);
    if (!items.length) { list.innerHTML = '<div class="ad-msg">No addresses found</div>'; return; }

    const chosenId = $('delivery-target').value;
    items.forEach((a) => {
        const card = document.createElement('div');
        card.className = 'ad-card' + (a.id === chosenId ? ' chosen' : '');
        card.innerHTML = (a.attention ? `<div><strong>${escapeHtml(a.attention)}</strong></div>` : '') +
            adLines(a).map((x) => `<div>${escapeHtml(x)}</div>`).join('');

        if (!a.fromLocation) {
            const ico = document.createElement('div');
            ico.className = 'ad-ico';
            ico.innerHTML = '<button type="button" class="edit" title="Edit">&#9998;</button>' +
                '<button type="button" class="del" title="Delete">&#128465;</button>';
            ico.querySelector('.edit').addEventListener('click', (ev) => { ev.stopPropagation(); adClose(); adOpenModal(a); });
            ico.querySelector('.del').addEventListener('click', async (ev) => {
                ev.stopPropagation();
                if (await adConfirm('Delete address', 'Delete this address permanently?')) adDelete(a);
            });
            card.appendChild(ico);
        }
        card.addEventListener('click', () => adPick(a));
        list.appendChild(card);
    });
}

function adOpen() {
    adBuildPanel();
    ADDR.open = true;
    ADDR.query = '';
    ADDR.panel.querySelector('.ad-search input').value = '';
    ADDR.panel.hidden = false;
    adPlace();
    adPaint();
    adLoad(false);
    setTimeout(() => ADDR.panel.querySelector('.ad-search input').focus(), 0);
}
function adClose() {
    if (!ADDR.panel) return;
    ADDR.open = false;
    ADDR.panel.hidden = true;
}
function adToggle() { if (ADDR.open) adClose(); else adOpen(); }

function adPick(a) {
    const sel = $('delivery-target');
    const opt = {
        id: a.id,
        name: a.name || a.attention || a.street1 || 'Address',
        attention: a.fromLocation ? '' : a.attention,
        lines: adLines(a)
    };
    const existing = DEL.options.findIndex((o) => o.id === opt.id);
    if (existing > -1) {
        DEL.options[existing] = opt;
        Array.prototype.forEach.call(sel.options, (o) => { if (o.value === opt.id) o.text = opt.name; });
    } else {
        DEL.options.push(opt);
        sel.appendChild(new Option(opt.name, opt.id));
    }
    document.querySelector('input[name="deliver_to"][value="location"]').checked = true;
    sel.value = opt.id;
    if (sel._sync) sel._sync();
    renderDeliveryAddress();
    markDirty();
    adClose();
}

function adBuildModal() {
    if (ADDR.modal) return;
    const m = document.createElement('div');
    m.className = 'nv-overlay ad-modal';
    m.hidden = true;
    m.innerHTML =
        '<div class="nv-box" role="dialog" aria-modal="true" style="max-width:520px">' +
        '<div class="nv-head"><h3 id="ad-title">New address</h3><button type="button" class="nv-x" id="ad-x" aria-label="Close">&times;</button></div>' +
        '<div class="nv-body">' +
        row('Attention', '<input type="text" id="ad_attention" class="nv-main">') +
        row('Street 1', '<textarea id="ad_street1" rows="2" class="nv-main"></textarea>') +
        row('Street 2', '<textarea id="ad_street2" rows="2" class="nv-main"></textarea>') +
        row('City', '<input type="text" id="ad_city" class="nv-main">') +
        row('State/Province', '<input type="text" id="ad_state" class="nv-main" list="ad-states" placeholder="Select or type state">') +
        row('ZIP/Postal Code', '<input type="text" id="ad_zip" class="nv-main">') +
        row('Country/Region', '<select id="ad_country" class="nv-main"></select>') +
        row('Phone', '<input type="text" id="ad_phone" class="nv-main" inputmode="tel">') +
        '<datalist id="ad-states"></datalist></div>' +
        '<div class="nv-foot"><button type="button" class="btn btn-primary" id="ad-save">Save</button>' +
        '<button type="button" class="btn btn-secondary" id="ad-cancel">Cancel</button>' +
        '<span class="nv-status" id="ad-status"></span></div></div>';
    document.body.appendChild(m);
    ADDR.modal = m;

    function row(label, field) {
        return `<div class="nv-row"><label class="nv-l">${label}</label><div class="nv-c">${field}</div></div>`;
    }

    const dl = m.querySelector('#ad-states');
    NV_STATES.forEach((s) => dl.appendChild(new Option('', s[1])));
    nvFill(m.querySelector('#ad_country'), NV_COUNTRIES.map((c) => [c, c]), 'Select or type to add');

    m.querySelector('#ad-x').addEventListener('click', adCloseModal);
    m.querySelector('#ad-cancel').addEventListener('click', adCloseModal);
    m.querySelector('#ad-save').addEventListener('click', adSave);
    m.addEventListener('mousedown', (ev) => { if (ev.target === m) adCloseModal(); });
    m.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.stopPropagation(); adCloseModal(); }
        else if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); adSave(); }
    });
}

function adOpenModal(a) {
    adBuildModal();
    ADDR.editId = a ? a.id : null;
    const m = ADDR.modal;
    m.querySelector('#ad-title').textContent = a ? 'Edit address' : 'New address';
    m.querySelector('#ad_attention').value = a ? a.attention : '';
    m.querySelector('#ad_street1').value = a ? a.street1 : '';
    m.querySelector('#ad_street2').value = a ? a.street2 : '';
    m.querySelector('#ad_city').value = a ? a.city : '';
    m.querySelector('#ad_state').value = a ? a.state : '';
    m.querySelector('#ad_zip').value = a ? a.zip : '';
    m.querySelector('#ad_country').value = a ? a.country : 'India';
    m.querySelector('#ad_phone').value = a ? a.phone : '';
    m.querySelector('#ad-status').textContent = '';
    m.querySelector('#ad-save').disabled = false;
    ADDR.saving = false;
    m.hidden = false;
    setTimeout(() => m.querySelector('#ad_attention').focus(), 30);
}

function adCloseModal() {
    if (ADDR.saving) return;
    ADDR.modal.hidden = true;
}

function adPayload() {
    const g = (id) => String(ADDR.modal.querySelector('#' + id).value).trim();
    const p = {
        attention: g('ad_attention'),
        address: g('ad_street1'),
        street2: g('ad_street2'),
        city: g('ad_city'),
        state: g('ad_state'),
        zip: g('ad_zip'),
        country: g('ad_country'),
        phone: g('ad_phone')
    };
    Object.keys(p).forEach((k) => { if (!p[k]) delete p[k]; });
    return p;
}

async function adSave() {
    if (ADDR.saving) return;
    const status = ADDR.modal.querySelector('#ad-status');
    const payload = adPayload();

    if (!payload.attention && !payload.address && !payload.city) {
        status.textContent = 'Enter at least an attention name, street or city.';
        return;
    }
    if (payload.phone && !/^[0-9 ()+\-]{6,20}$/.test(payload.phone)) {
        status.textContent = 'Enter a valid phone number.';
        return;
    }

    ADDR.saving = true;
    ADDR.modal.querySelector('#ad-save').disabled = true;
    status.textContent = 'Saving…';

    try {
        const editing = !!ADDR.editId;
        const data = await zbApi(editing ? 'PUT' : 'POST',
            editing ? '/organizations/address/' + ADDR.editId : '/organizations/address', {}, payload);

        const rec = Object.keys(data).map((k) => data[k])
            .find((v) => v && typeof v === 'object' && !Array.isArray(v) && (v.address_id || v.org_address_id));

        ADDR.saving = false;
        ADDR.modal.hidden = true;
        await adLoad(true);

        const savedId = rec ? String(rec.address_id || rec.org_address_id) : (editing ? ADDR.editId : '');
        const saved = ADDR.items.find((a) => a.id === savedId);
        if (saved) adPick(saved);
        else adOpen();
    } catch (err) {
        logError('ADDRESS', 'Save failed', err);
        ADDR.saving = false;
        ADDR.modal.querySelector('#ad-save').disabled = false;
        status.textContent = 'Save failed: ' + (err.message || 'Request failed');
    }
}

async function adDelete(a) {
    try {
        await zbApi('DELETE', '/organizations/address/' + a.id);
        if ($('delivery-target').value === a.id) refreshDeliveryTarget(false);
        await adLoad(true);
    } catch (err) {
        logError('ADDRESS', 'Delete failed', err);
        ADDR.error = 'Delete failed: ' + (err.message || 'Request failed');
        adPaint();
    }
}

// ============================================================
// SHIPMENT PREFERENCE
// ============================================================

const SHIP = { values: [], open: false, active: -1, items: [], panel: null, wired: false, loaded: false };
const SHIP_API_PATHS = ['/settings/deliverymethods', '/deliverymethods'];

function shipKey() { return 'po_ship_prefs_' + state.organizationId; }

function shipMerge(list) {
    const seen = {};
    SHIP.values.forEach((v) => { seen[v.toLowerCase()] = 1; });
    (list || []).forEach((raw) => {
        const v = String(raw == null ? '' : raw).trim();
        if (!v || seen[v.toLowerCase()]) return;
        seen[v.toLowerCase()] = 1;
        SHIP.values.push(v);
    });
    SHIP.values.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function shipCollectFromPOs(pos) {
    shipMerge((pos || []).map((p) => p.delivery_method || p.ship_via || p.shipment_preference || ''));
}

function shipRemember(value) {
    const v = String(value || '').trim();
    if (!v) return;
    shipMerge([v]);
    try { localStorage.setItem(shipKey(), JSON.stringify(SHIP.values)); } catch (e) { /* storage not available */ }
}

async function shipLoadFromApi() {
    for (const path of SHIP_API_PATHS) {
        try {
            const j = await zbApi('GET', path);
            log('SHIPMENT', 'Raw response from ' + path, j);
            const arr = Object.keys(j).map((k) => j[k]).find(Array.isArray) || [];
            const names = arr.map((x) => typeof x === 'string' ? x : (x.delivery_method || x.name || x.label || x.value || '')).filter(Boolean);
            if (names.length) return names;
        } catch (e) { /* try the next path */ }
    }
    return [];
}

async function shipLoadSaved() {
    try {
        const saved = JSON.parse(localStorage.getItem(shipKey()) || '[]');
        if (Array.isArray(saved)) shipMerge(saved);
    } catch (e) { /* storage not available */ }
    shipMerge(await shipLoadFromApi());
    SHIP.loaded = true;
}

function shipFiltered() {
    const q = $('delivery-method').value.trim().toLowerCase();
    return q ? SHIP.values.filter((v) => v.toLowerCase().indexOf(q) > -1) : SHIP.values;
}

function shipPlace() {
    const r = $('delivery-method').getBoundingClientRect();
    const p = SHIP.panel;
    const w = Math.max(r.width, 240);
    p.style.width = w + 'px';
    p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    const below = window.innerHeight - r.bottom - 12;
    if (below >= 140 || below >= r.top) {
        p.style.top = (r.bottom + 4) + 'px'; p.style.bottom = 'auto';
        p.style.maxHeight = Math.max(100, Math.min(260, below)) + 'px';
    } else {
        p.style.bottom = (window.innerHeight - r.top + 4) + 'px'; p.style.top = 'auto';
        p.style.maxHeight = Math.max(100, Math.min(260, r.top - 12)) + 'px';
    }
}

function shipPaint() {
    SHIP.items = shipFiltered();
    if (!SHIP.items.length) { shipClose(); return; }
    if (SHIP.active >= SHIP.items.length) SHIP.active = 0;
    SHIP.panel.innerHTML = '';
    SHIP.items.forEach((v, i) => {
        const d = document.createElement('div');
        d.className = 'sh-item' + (i === SHIP.active ? ' active' : '');
        d.textContent = v;
        d.addEventListener('mousedown', (ev) => { ev.preventDefault(); shipPick(i); });
        d.addEventListener('mouseenter', () => { SHIP.active = i; shipMarkActive(false); });
        SHIP.panel.appendChild(d);
    });
}

function shipMarkActive(scroll) {
    SHIP.panel.querySelectorAll('.sh-item').forEach((n, i) => {
        n.classList.toggle('active', i === SHIP.active);
        if (scroll && i === SHIP.active && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
    });
}

function shipOpen() {
    if (!SHIP.values.length) return;
    SHIP.open = true;
    SHIP.active = -1;
    SHIP.panel.hidden = false;
    $('delivery-method').closest('.sh-wrap').classList.add('open');
    shipPlace();
    shipPaint();
    if (!SHIP.items.length) shipClose();
}

function shipClose() {
    if (!SHIP.panel) return;
    SHIP.open = false;
    SHIP.panel.hidden = true;
    const w = $('delivery-method').closest('.sh-wrap');
    if (w) w.classList.remove('open');
}

function shipPick(i) {
    const v = SHIP.items[i];
    if (v === undefined) return;
    $('delivery-method').value = v;
    shipClose();
    markDirty();
}

async function initShipmentPreference() {
    const inp = $('delivery-method');
    if (!inp || SHIP.wired) return;
    SHIP.wired = true;

    if (inp.tagName === 'SELECT') {
        console.error('[SHIPMENT] #delivery-method is still a <select>. Replace it with the text input from index.html.');
        return;
    }

    shipMerge([state.salesOrder && state.salesOrder.deliveryMethod]);
    await shipLoadSaved();
    if (state.salesOrder && state.salesOrder.deliveryMethod && !inp.value) inp.value = state.salesOrder.deliveryMethod;

    const p = document.createElement('div');
    p.className = 'sh-panel';
    p.hidden = true;
    document.body.appendChild(p);
    SHIP.panel = p;

    inp.addEventListener('focus', shipOpen);
    inp.addEventListener('click', () => { if (!SHIP.open) shipOpen(); });
    inp.addEventListener('input', () => {
        markDirty();
        if (!SHIP.open) { shipOpen(); return; }
        SHIP.active = -1;
        shipPaint();
    });
    inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown') {
            ev.preventDefault();
            if (!SHIP.open) { shipOpen(); return; }
            SHIP.active = Math.min(SHIP.items.length - 1, SHIP.active + 1);
            shipMarkActive(true);
        } else if (ev.key === 'ArrowUp' && SHIP.open) {
            ev.preventDefault();
            SHIP.active = Math.max(0, SHIP.active - 1);
            shipMarkActive(true);
        } else if (ev.key === 'Enter' && SHIP.open && SHIP.active >= 0) {
            ev.preventDefault();
            shipPick(SHIP.active);
        } else if (ev.key === 'Escape' && SHIP.open) {
            ev.preventDefault();
            ev.stopPropagation();
            shipClose();
        } else if (ev.key === 'Tab') {
            shipClose();
        }
    });
    inp.addEventListener('blur', () => setTimeout(shipClose, 120));
    document.addEventListener('mousedown', (ev) => {
        if (SHIP.open && !p.contains(ev.target) && ev.target !== inp) shipClose();
    });
    document.addEventListener('scroll', (ev) => { if (SHIP.open && !p.contains(ev.target)) shipPlace(); }, true);
    window.addEventListener('resize', () => { if (SHIP.open) shipPlace(); });
}

// ============================================================
// ITEM MASTER + TAXES + ACCOUNTS
// ============================================================

state.itemMaster = {};
state.taxes = [];
state.accounts = [];

function ensureItemUi() {
    injectItemCss();
    buildItemTableShell();
}
function injectItemStyles() { ensureItemUi(); }
function setupItemTableUi() { ensureItemUi(); }

function injectItemCss() {
    let s = document.getElementById('item-styles');
    if (!s) { s = document.createElement('style'); s.id = 'item-styles'; document.head.appendChild(s); }
    s.textContent = `
#item-toolbar{display:flex;align-items:center;gap:22px;padding:2px 2px 14px;font-size:13px;color:#555;flex-wrap:wrap}
#item-toolbar .tb-lbl{color:#777;margin-right:8px}
#item-toolbar .tb-val{padding-bottom:2px;border-bottom:1px dashed #9aa3b2;color:#222}
#item-toolbar .tb-sep{width:1px;height:22px;background:#e0e0e0}
#item-toolbar .tb-chip{display:inline-flex;align-items:center;gap:6px;color:#222;background:#f4f6fa;border:1px solid #e3e7ee;border-radius:14px;padding:3px 12px;font-size:12px}

.form-section.zb{background:#f7f8fa;border:1px solid #e3e6eb;border-radius:8px;padding:0;margin-top:0}
.form-section.zb .form-section-title{text-transform:none;font-size:15px;font-weight:600;color:#1a1a1a;letter-spacing:0;padding:14px 16px 10px;margin:0}
.form-section.zb .items-table-wrapper{margin:0;padding:0 14px 4px;overflow-x:auto}

#items-table.zb-items{width:100%;min-width:1000px;table-layout:fixed;background:#fff;border:1px solid #e0e3e8;border-radius:6px;border-collapse:separate;border-spacing:0;overflow:hidden}
#items-table.zb-items thead th{position:static;background:#fff;border-bottom:1px solid #e0e3e8;border-right:1px solid #eceef2;padding:11px 12px;font-size:11px;font-weight:700;letter-spacing:.5px;color:#555;text-transform:uppercase;text-align:left}
#items-table.zb-items thead th.r{text-align:right}
#items-table.zb-items thead th:last-child{border-right:0}
#items-table.zb-items tbody td{border-right:1px solid #eceef2;border-bottom:1px solid #eef0f3;padding:14px 12px;vertical-align:top;font-size:13px}
#items-table.zb-items tbody td:last-child{border-right:0}
#items-table.zb-items tbody tr:last-child td{border-bottom:0}
#items-table.zb-items tbody tr.fully-purchased{background:#fafafa;opacity:.75}
#items-table.zb-items tbody tr.over-allocated{background:#fff5f5}

.zi-wrap{display:flex;gap:12px}
.zi-img{flex:0 0 36px;height:36px;border:1px solid #d9dde3;border-radius:4px;background:#f2f4f7;color:#b5bcc8;display:flex;align-items:center;justify-content:center;font-size:16px}
.zi-body{flex:1;min-width:0}
.zi-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.zi-name{font-size:14px;font-weight:600;color:#1f2933;word-break:break-word}
.zi-sku{font-size:12px;color:#7a8494;margin-top:2px}
.zi-icons{display:flex;gap:6px;flex-shrink:0}
.zi-icons button{width:20px;height:20px;border:1px solid #9aa3b2;border-radius:50%;background:#fff;color:#6b7280;font-size:11px;line-height:1;cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center}
.zi-icons button:disabled{opacity:.4;cursor:not-allowed}
.zi-icons button.info-btn:hover:not(:disabled){border-color:#1a73e8;color:#1a73e8;background:#e8f0fe}
.desc-input{display:block;width:100%;margin-top:10px;min-height:54px;resize:vertical;padding:8px 10px;border:1px solid transparent;border-radius:4px;background:#f4f5f7;font:inherit;font-size:13px;color:#333;outline:none}
.desc-input:focus{background:#fff;border-color:#408dfb;box-shadow:0 0 0 2px rgba(64,141,251,.15)}
.zi-meta{margin-top:10px;font-size:12px;color:#555;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.zi-badge{background:#2196f3;color:#fff;font-size:9px;font-weight:700;padding:2px 7px;border-radius:2px;letter-spacing:.4px}
.zi-badge.service{background:#7e57c2}

#items-table .tax-select{width:100%;padding:7px 28px 7px 9px;border:1px solid #d0d5dc;border-radius:4px;background:#fff;font:inherit;font-size:13px;color:#333;appearance:none;-webkit-appearance:none;cursor:pointer;text-overflow:ellipsis;
 background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23666'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
#items-table .tax-select:focus{border-color:#408dfb;box-shadow:0 0 0 2px rgba(64,141,251,.15);outline:none}
#items-table .cell-input{width:100%;padding:7px 10px;border:1px solid #d0d5dc;border-radius:4px;font:inherit;font-size:13px;background:#fff;outline:none}
#items-table .cell-input:focus{border-color:#408dfb;box-shadow:0 0 0 2px rgba(64,141,251,.15)}
#items-table .cell-input.error{border-color:#d32f2f;box-shadow:0 0 0 2px rgba(211,47,47,.12)}
#items-table .cell-input:disabled{background:#f5f5f5;color:#9aa0a6}
#items-table .qty-input,#items-table .rate-input{text-align:right}
#items-table td.qty-cell,#items-table td.rate-cell{text-align:right}

.qty-cell .qty-info{margin-top:10px;padding:8px 10px;background:#f7f8fa;border-radius:4px;align-items:stretch;gap:3px;font-size:11.5px}
.qty-cell .qty-info>span{display:flex;justify-content:space-between;gap:10px}

.rate-sub{margin-top:10px;font-size:11px;color:#7a8494;text-align:right;text-transform:uppercase;letter-spacing:.4px}
.discount-wrap{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:4px}
.discount-wrap .discount-input{width:100%}
.disc-unit{color:#7a8494;font-size:12px}

#items-table td.amount-cell{font-size:14px;font-weight:700;color:#1f2933;text-align:right;white-space:nowrap}

.add-item-row{display:flex;gap:10px;padding:12px 14px 14px!important;border-top:0!important;margin:0!important}
.add-item-row .btn-zb{background:#eef1f6;color:#222;border:1px solid transparent;border-radius:4px;padding:7px 14px;font-size:13px;font-weight:500}
.add-item-row .btn-zb:disabled{opacity:.6;cursor:not-allowed}
.add-item-row .plus{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-right:6px;border-radius:50%;background:#2e7bf6;color:#fff;font-size:12px;line-height:1}

.po-bottom-grid{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:32px;margin-top:24px;padding-bottom:20px;align-items:start}
.zb-totals-card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;box-shadow:0 1px 3px rgba(0,0,0,0.03)}
.tot-row{display:flex;justify-content:space-between;align-items:flex-start;padding:10px 0;border-bottom:1px solid #f8fafc;font-size:13px}
.tot-row.grand-total{border-top:1.5px solid #e2e8f0;border-bottom:0;margin-top:8px;padding-top:14px;padding-bottom:4px}

tr.item-detail-row td{padding:0 12px 12px!important;background:#fafbfc;border-right:0!important}
.item-detail{border:1px solid #e8e8e8;border-radius:6px;background:#fff;padding:10px 12px}
.item-detail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px 20px;font-size:12px}
.item-detail-grid .lbl{display:block;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.3px}
.item-detail-msg{font-size:12px;color:#888}
.item-detail-actions{display:flex;gap:12px;margin-top:10px;flex-wrap:wrap}

.qty-control-wrap{display:inline-flex;align-items:center;border:1px solid #d0d5dc;border-radius:4px;overflow:hidden;background:#fff}
.qty-control-wrap:focus-within{border-color:#408dfb;box-shadow:0 0 0 2px rgba(64,141,251,.15)}
.qty-control-wrap .cell-input.qty-input{border:0!important;box-shadow:none!important;width:56px;text-align:center;font-weight:600;padding:6px 4px}
.qty-btn{width:26px;height:32px;border:0;background:#f7f8fa;color:#4b5563;font-size:15px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;user-select:none;transition:background .15s}
.qty-btn:hover:not(:disabled){background:#e8f0fe;color:#1a73e8}
.qty-btn:disabled{opacity:.35;cursor:not-allowed;background:#f0f0f0}
.rate-control-wrap{display:flex;align-items:center;gap:4px;justify-content:flex-end}
.rate-control-wrap .cell-input.rate-input{flex:1;min-width:70px}
.rate-reset-btn{width:24px;height:28px;border:1px solid #d0d5dc;border-radius:4px;background:#f8fafc;color:#64748b;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}
.rate-reset-btn:hover{border-color:#1a73e8;color:#1a73e8;background:#e8f0fe}
.rate-mod-dot{width:6px;height:6px;border-radius:50%;background:#f59e0b;display:inline-block;flex-shrink:0}
.zi-badge.manual{background:#e0f2fe;color:#0284c7;border:1px solid #bae6fd;font-weight:700}
.zi-badge.so-item{background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;font-weight:700}
.zi-status{display:inline-block;font-size:9px;font-weight:700;padding:1px 6px;border-radius:2px;text-transform:uppercase;letter-spacing:.3px}
.zi-status.active{background:#ecfdf5;color:#059669;border:1px solid #a7f3d0}
.zi-status.inactive{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
.zi-code{font-size:11px;color:#64748b;font-weight:500}
.item-detail-field{display:flex;flex-direction:column;gap:2px}
.item-detail-field .lbl{font-size:10.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
.item-detail-field .val{font-size:12.5px;color:#1e293b;font-weight:500;word-break:break-word}`;
}

function buildItemTableShell() {
    const table = $('items-table');
    if (!table || table.dataset.ui === '1') return;
    table.dataset.ui = '1';
    table.classList.add('zb-items');

    const sec = table.closest('.form-section') || $('items-form-section');
    if (sec) {
        sec.classList.add('zb');
        sec.style.marginTop = '0';
        buildItemToolbar(sec);
    }

    const bulkBtn = $('btn-bulk-actions');
    if (bulkBtn && bulkBtn.dataset.wired !== '1') {
        bulkBtn.dataset.wired = '1';
        bulkBtn.addEventListener('click', () => {
            const trs = dom.itemsTbody.querySelectorAll('tr[data-line-item-id]');
            if (!trs.length) return;
            const anyUnselected = Array.from(trs).some((tr) => !tr.classList.contains('row-selected'));
            trs.forEach((tr) => tr.classList.toggle('row-selected', anyUnselected));
        });
    }

    const bulkAdd = $('btn-add-bulk');
    if (bulkAdd && bulkAdd.dataset.wired !== '1') {
        bulkAdd.dataset.wired = '1';
        bulkAdd.addEventListener('click', bkOpen);
    }
}

// ---------- accounts (all types and names come from the org's chart of accounts) ----------

function prettyType(t) {
    return String(t || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function normAccount(a) {
    const type = a.account_type || '';
    return {
        id: String(a.account_id),
        name: a.account_name || '',
        type,
        typeLabel: a.account_type_formatted || prettyType(type) || 'Other',
        parentId: a.parent_account_id ? String(a.parent_account_id) : '',
        depth: 0
    };
}

/** Groups by account type, then parent → children (depth set for indentation). */
function orderAccounts(list) {
    const groups = {};
    list.forEach((a) => { (groups[a.typeLabel] = groups[a.typeLabel] || []).push(a); });
    const out = [];
    Object.keys(groups).sort().forEach((label) => {
        const g = groups[label], ids = {}, kids = {}, seen = {};
        g.forEach((a) => { ids[a.id] = 1; });
        g.forEach((a) => {
            const p = (a.parentId && ids[a.parentId] && a.parentId !== a.id) ? a.parentId : '';
            (kids[p] = kids[p] || []).push(a);
        });
        const walk = (pid, depth) => (kids[pid] || []).slice()
            .sort((x, y) => x.name.localeCompare(y.name))
            .forEach((a) => {
                if (seen[a.id] || depth > 5) return;
                seen[a.id] = 1; a.depth = depth; out.push(a); walk(a.id, depth + 1);
            });
        walk('', 0);
        g.forEach((a) => { if (!seen[a.id]) { a.depth = 0; out.push(a); } });
    });
    return out;
}

async function loadAccountsFresh() {
    try {
        let all = [], page = 1, more = true;
        while (more && page <= 10) {
            const data = await zbApi('GET', '/chartofaccounts', { filter_by: 'AccountType.Active', page, per_page: PER_PAGE });
            all = all.concat(data.chartofaccounts || []);
            more = (data.page_context || {}).has_more_page === true;
            page++;
        }
        state.accounts = orderAccounts(all.map(normAccount).filter((a) => a.id && a.name));
        zcBlobSet('accounts', state.accounts);
        log('ACCOUNT', `Loaded ${state.accounts.length} accounts`);
    } catch (err) {
        logError('ACCOUNT', 'Could not load chart of accounts', err);
    }
}
function loadAccounts() {
    return swrBlob('accounts', loadAccountsFresh, (d) => { state.accounts = d; }, 10 * 60 * 1000);
}

function apNewTypes() {
    const seen = {}, out = [];
    state.accounts.forEach((a) => {
        if (a.type && !seen[a.type]) { seen[a.type] = 1; out.push([a.type, a.typeLabel]); }
    });
    return out.sort((x, y) => x[1].localeCompare(y[1]));
}

function accountOptionsFor(master) {
    // Purchase account only (never account_id / account_name, which is the sales account)
    const defId = master && master.purchase_account_id ? String(master.purchase_account_id) : '';
    const defName = master ? (master.purchase_account_name || '') : '';
    const list = state.accounts.slice();
    if (defId && !list.some((a) => a.id === defId)) {
        list.push({ id: defId, name: defName || 'Account', type: '', typeLabel: 'Other', parentId: '', depth: 0 });
    }
    return { list, defId };
}

// ---------- account picker (one shared panel, grouped by type, hierarchy, + New Account) ----------

const AP = { panel: null, open: false, sel: null, btn: null, q: '', active: 0, items: [] };

/** Replaces the native <select>. A hidden select still holds the value so the rest of the code keeps working. */
function buildAccountField(master, selectedId) {
    const ao = accountOptionsFor(master);
    const wrap = document.createElement('div');
    wrap.className = 'acc-wrap';

    const sel = document.createElement('select');
    sel.className = 'acc-select';
    sel.hidden = true;
    sel.appendChild(new Option('Select an account', ''));
    ao.list.forEach((a) => sel.appendChild(new Option(a.name, a.id)));
    sel.value = selectedId || ao.defId;
    sel.dataset.defaultId = ao.defId;
    sel.addEventListener('change', markDirty);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'acc-pick';
    sel._sync = () => {
        const o = sel.options[sel.selectedIndex];
        const has = o && o.value !== '';
        btn.textContent = has ? o.text : 'Select an account';
        btn.title = has ? o.text : '';
        btn.classList.toggle('empty', !has);
    };
    btn.addEventListener('click', () => apToggle(sel, btn));

    wrap.appendChild(sel);
    wrap.appendChild(btn);
    sel._sync();
    return wrap;
}

function apAll() {
    const all = state.accounts.slice();
    Array.prototype.forEach.call(AP.sel.options, (o) => {
        if (o.value && !all.some((a) => a.id === o.value)) {
            all.push({ id: o.value, name: o.text, typeLabel: 'Other', depth: 0 });
        }
    });
    return all;
}

function apBuild() {
    if (AP.panel) return;
    const p = document.createElement('div');
    p.className = 'lk-panel';
    p.hidden = true;
    p.innerHTML =
        '<div class="lk-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a94a6" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
        '<input type="text" placeholder="Search" autocomplete="off"></div>' +
        '<div class="lk-list"></div>' +
        '<div class="lk-foot"><button type="button" class="lk-foot-btn"><span class="lk-plus">+</span><span>New Account</span></button></div>';
    document.body.appendChild(p);
    AP.panel = p;

    const inp = p.querySelector('input');
    inp.addEventListener('input', () => { AP.q = inp.value; AP.active = 0; apPaint(false); });
    inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); AP.active = Math.min(AP.items.length - 1, AP.active + 1); apMark(true); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); AP.active = Math.max(0, AP.active - 1); apMark(true); }
        else if (ev.key === 'Enter') { ev.preventDefault(); apPick(AP.active); }
        else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); apClose(); }
        else if (ev.key === 'Tab') apClose();
    });
    p.querySelector('.lk-foot-btn').addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const nm = AP.q.trim(), sel = AP.sel;
        apClose();
        openNewAccountModal(nm, sel);
    });
    document.addEventListener('mousedown', (ev) => {
        if (AP.open && !p.contains(ev.target) && !(AP.btn && AP.btn.contains(ev.target))) apClose();
    });
    document.addEventListener('scroll', (ev) => { if (AP.open && !p.contains(ev.target)) apPlace(); }, true);
    window.addEventListener('resize', () => { if (AP.open) apPlace(); });
}

function apPlace() {
    const r = AP.btn.getBoundingClientRect(), p = AP.panel;
    const w = Math.max(r.width, 300);
    p.style.width = w + 'px';
    p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    const below = window.innerHeight - r.bottom - 12;
    if (below >= 240 || below >= r.top) {
        p.style.top = (r.bottom + 4) + 'px'; p.style.bottom = 'auto';
        p.style.maxHeight = Math.max(160, Math.min(380, below)) + 'px';
    } else {
        p.style.bottom = (window.innerHeight - r.top + 4) + 'px'; p.style.top = 'auto';
        p.style.maxHeight = Math.max(160, Math.min(380, r.top - 12)) + 'px';
    }
}

function apPaint(scrollToActive) {
    const list = AP.panel.querySelector('.lk-list');
    list.innerHTML = '';
    const q = AP.q.trim().toLowerCase();
    const all = apAll();
    AP.items = q ? all.filter((a) => a.name.toLowerCase().indexOf(q) > -1) : all;

    if (!AP.items.length) {
        const m = document.createElement('div');
        m.className = 'lk-msg';
        m.textContent = 'No accounts found';
        list.appendChild(m);
        return;
    }
    if (AP.active >= AP.items.length) AP.active = 0;

    const cur = AP.sel.value;
    let lastType = null;
    AP.items.forEach((a, i) => {
        if (a.typeLabel !== lastType) {
            const h = document.createElement('div');
            h.className = 'ap-grp';
            h.textContent = a.typeLabel || 'Other';
            list.appendChild(h);
            lastType = a.typeLabel;
        }
        const d = document.createElement('div');
        d.className = 'lk-item' + (a.depth ? ' lk-child' : '') + (i === AP.active ? ' active' : '') + (a.id === cur ? ' chosen' : '');
        d.dataset.i = String(i);
        if (a.depth) d.style.paddingLeft = (12 + a.depth * 18) + 'px';
        d.textContent = a.name;
        d.addEventListener('mousedown', (ev) => { ev.preventDefault(); apPick(i); });
        d.addEventListener('mouseenter', () => { AP.active = i; apMark(false); });
        list.appendChild(d);
    });
    if (scrollToActive) apMark(true);
}

function apMark(scroll) {
    AP.panel.querySelectorAll('.lk-item').forEach((n) => {
        const on = Number(n.dataset.i) === AP.active;
        n.classList.toggle('active', on);
        if (on && scroll && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
    });
}

function apOpen(sel, btn) {
    apBuild();
    if (AP.open) apClose();
    AP.open = true; AP.sel = sel; AP.btn = btn; AP.q = '';
    const inp = AP.panel.querySelector('input');
    inp.value = '';
    AP.active = Math.max(0, apAll().findIndex((a) => a.id === sel.value));
    AP.panel.hidden = false;
    btn.classList.add('open');
    apPlace();
    apPaint(true);
    setTimeout(() => inp.focus(), 0);
}

function apClose() {
    if (!AP.panel) return;
    AP.open = false;
    AP.panel.hidden = true;
    if (AP.btn) AP.btn.classList.remove('open');
}

function apToggle(sel, btn) {
    if (AP.open && AP.btn === btn) apClose(); else apOpen(sel, btn);
}

function apSelect(sel, a) {
    if (!Array.prototype.some.call(sel.options, (o) => o.value === a.id)) sel.appendChild(new Option(a.name, a.id));
    sel.value = a.id;
    if (sel._sync) sel._sync();
    sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function apPick(i) {
    const a = AP.items[i];
    if (!a) return;
    apSelect(AP.sel, a);
    apClose();
}

// ---------- New Account (POST /chartofaccounts) ----------
function openNewAccountModal(prefill, sel) {
    const old = $('na-modal');
    if (old) old.remove();

    const ov = document.createElement('div');
    ov.id = 'na-modal';
    ov.className = 'nv-overlay';
    ov.style.zIndex = '22000';
    const row = (l, f, req, id) => '<div class="nv-row"' + (id ? ' id="' + id + '"' : '') + '><label class="nv-l' + (req ? ' req' : '') + '">' + l + '</label><div class="nv-c">' + f + '</div></div>';
    ov.innerHTML =
        '<div class="nv-box" role="dialog" aria-modal="true" style="max-width:520px">' +
        '<div class="nv-head"><h3>New Account</h3><button type="button" class="nv-x" data-x aria-label="Close">&times;</button></div>' +
        '<div class="nv-body">' +
        row('Account Type*', '<select id="na_type" class="nv-main"></select>', 1) +
        row('Account Name*', '<input type="text" id="na_name" class="nv-main" maxlength="200" autocomplete="off">', 1) +
        row('Account Code', '<input type="text" id="na_code" class="nv-sm" maxlength="20" autocomplete="off">') +
        row('Sub-account', '<label class="nv-radio"><input type="checkbox" id="na_sub"> Make this a sub-account</label>') +
        row('Parent Account', '<select id="na_parent" class="nv-main"></select>', 1, 'na-parent-row') +
        row('Description', '<textarea id="na_desc" rows="2" class="nv-main" maxlength="500"></textarea>') +
        '</div><div class="nv-foot"><button type="button" class="btn btn-primary" data-save>Save</button>' +
        '<button type="button" class="btn btn-secondary" data-cancel>Cancel</button><span class="nv-status"></span></div></div>';
    document.body.appendChild(ov);

    const q = (id) => ov.querySelector('#' + id);
    const type = q('na_type'), sub = q('na_sub'), parent = q('na_parent'), parentRow = q('na-parent-row');
    const save = ov.querySelector('[data-save]'), status = ov.querySelector('.nv-status');

    const types = apNewTypes();
    nvFill(type, types, null);
    type.value = types.length ? types[0][0] : '';
    q('na_name').value = prefill || '';
    parentRow.hidden = true;

    function fillParents() {
        const opts = state.accounts.filter((a) => a.type === type.value)
            .map((a) => [a.id, '\u00A0\u00A0'.repeat(a.depth || 0) + a.name]);
        nvFill(parent, opts, 'Select a parent account');
    }
    fillParents();
    type.addEventListener('change', fillParents);
    sub.addEventListener('change', () => { parentRow.hidden = !sub.checked; });

    let saving = false;
    const close = () => { if (!saving) ov.remove(); };

    async function go() {
        if (saving) return;
        ['na_name', 'na_parent'].forEach((id) => nvMark(q(id), ''));
        const name = q('na_name').value.trim();
        let ok = true;
        if (!name) { nvMark(q('na_name'), 'Account name is required'); ok = false; }
        else if (state.accounts.some((a) => a.name.trim().toLowerCase() === name.toLowerCase())) {
            nvMark(q('na_name'), 'An account with this name already exists'); ok = false;
        }
        if (!type.value) { nvMark(type, 'Select an account type'); ok = false; }
        if (sub.checked && !parent.value) { nvMark(parent, 'Select a parent account'); ok = false; }
        if (!ok) return;

        saving = true;
        save.disabled = true;
        status.textContent = 'Creating account…';

        const body = { account_name: name, account_type: type.value };
        if (q('na_code').value.trim()) body.account_code = q('na_code').value.trim();
        if (q('na_desc').value.trim()) body.description = q('na_desc').value.trim();
        if (sub.checked && parent.value) body.parent_account_id = parent.value;
        log('NEW_ACCOUNT', 'Payload', body);

        try {
            const d = await zbApi('POST', '/chartofaccounts', {}, body);
            const rec = d.chart_of_account;
            if (!rec || !rec.account_id) throw new Error('Zoho Books did not return the created account.');
            const acc = normAccount(rec);
            if (!acc.type) { acc.type = type.value; acc.typeLabel = prettyType(type.value); }
            state.accounts = orderAccounts(state.accounts.concat(acc));
            zcBlobSet('accounts', state.accounts);
            saving = false;
            ov.remove();
            apSelect(sel, acc);
        } catch (err) {
            logError('NEW_ACCOUNT', 'Create account failed', err);
            saving = false;
            save.disabled = false;
            status.textContent = 'Save failed: ' + (err.message || 'Request failed');
        }
    }

    ov.querySelector('[data-x]').addEventListener('click', close);
    ov.querySelector('[data-cancel]').addEventListener('click', close);
    save.addEventListener('click', go);
    ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) close(); });
    ov.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
        else if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox') { ev.preventDefault(); go(); }
    });
    setTimeout(() => q('na_name').focus(), 30);
}

// ---------- item master / taxes ----------

const DETAIL_TTL = 2 * 60 * 1000;
async function fetchItemById(itemId, fresh) {
    if (!itemId) return null;
    if (!fresh && state.itemMaster[itemId]) return state.itemMaster[itemId];
    if (!fresh) {
        const hit = await zcGetOne('itemdetail', itemId);
        if (hit && Date.now() - hit.at < DETAIL_TTL) { state.itemMaster[itemId] = hit.item; return hit.item; }
    }
    const data = await zbApi('GET', '/items/' + itemId);
    if (data.item) {
        state.itemMaster[itemId] = data.item;
        zcPut('itemdetail', [{ id: String(itemId), at: Date.now(), item: data.item }], (r) => r.id);
    }
    return data.item || null;
}

async function loadItemMasterForSalesOrder(so) {
    const ids = Array.from(new Set(so.lineItems.map((li) => li.itemId).filter(Boolean)));
    await Promise.all(ids.map((id) =>
        fetchItemById(id).catch((err) => logError('ITEM', 'Could not load item ' + id, err))
    ));
    log('ITEM', `Item master loaded for ${Object.keys(state.itemMaster).length}/${ids.length} items`);
}


async function loadTaxes() {
    state.taxes = [];
    state.taxExemptions = [];

    const taxesP = zbApi('GET', '/settings/taxes').then((data) => {
        state.taxes = (data.taxes || [])
            .filter((t) => t.tax_id && t.is_active !== false)
            .map((t) => ({
                id: String(t.tax_id),
                name: t.tax_name || '',
                pct: parseFloat(t.tax_percentage) || 0,
                type: t.tax_type || 'tax',
                specificType: t.tax_specific_type || '',
                raw: t
            }));
    }).catch((err) => { logError('TAX', 'Could not load Zoho Books taxes', err); state.taxes = []; });

    const exemptP = zbApi('GET', '/settings/taxexemptions').then((d) => {
        state.taxExemptions = (d.tax_exemptions || [])
            .filter((e) => e.tax_exemption_id)
            .map((e) => ({
                id: String(e.tax_exemption_id),
                code: e.tax_exemption_code || '',
                description: e.description || '',
                type: e.type || 'item'
            }))
            .filter((e) => e.type !== 'customer');
        log('TAX', 'Tax exemptions loaded', state.taxExemptions);   // check the console if the list is still empty
    }).catch((err) => { logError('TAX', 'Could not load tax exemptions', err); state.taxExemptions = []; });


    const whP = Promise.all([txLoadWithholding('tds'), txLoadWithholding('tcs')])
        .then(([tds, tcs]) => { state.tdsTaxes = tds; state.tcsTaxes = tcs; })
        .catch(() => { state.tdsTaxes = []; state.tcsTaxes = []; });

    await Promise.all([taxesP, exemptP, whP]);

    initTdsUi();
    txFill(true);
}
// ============================================================
// TDS / TCS TAX HANDLING
// ============================================================

// antigravity update with TDS & TCS mode detection
function txMode() {
    const r = document.querySelector('input[name="tds_tcs"]:checked');
    return (r && r.value === 'tcs') ? 'tcs' : 'tds';
}

// antigravity update with TDS & TCS list provider
function txList(mode = txMode()) {
    return mode === 'tcs' ? (state.tcsTaxes || []) : (state.tdsTaxes || []);
}

// antigravity update with withholding rate getter
function withholding() {
    const sel = $('tot-tds-select');
    if (!sel || !sel.value) return 0;
    const o = (sel.selectedOptions && sel.selectedOptions[0]) ||
              (sel.options && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]);
    return o ? (parseFloat(o.dataset.pct) || 0) : 0;
}

// antigravity update with active tax filter
function txActive(list = []) {
    return (list || []).filter((t) => t && t.tax_id && t.is_active !== false);
}

// antigravity update with tax deduplication
function txMerge(existing = [], incoming = []) {
    const seen = new Set((existing || []).map((t) => String(t.id || t.tax_id)));
    const merged = [...(existing || [])];
    (incoming || []).forEach((t) => {
        const id = String(t.id || t.tax_id);
        if (!seen.has(id)) {
            seen.add(id);
            merged.push(t);
        }
    });
    return merged;
}

// antigravity update with paginated withholding loader
async function txFetchAll(kind, query = {}) {
    let all = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        try {
            const pageQuery = Object.assign({}, query, { page });
            const res = await zbApi('GET', '/settings/taxes', pageQuery);
            const list = res.taxes || [];
            all = all.concat(list);
            const pageCtx = res.page_context || {};
            if (pageCtx.has_more_page && page < 5) {
                page++;
            } else {
                hasMore = false;
            }
        } catch (err) {
            logError('TAX', `Failed fetching page ${page} of ${kind} taxes`, err);
            hasMore = false;
        }
    }
    return all;
}

// antigravity update with TDS & TCS loading from Zoho Books
async function txLoadWithholding(kind) {
    const isTds = kind === 'tds';
    const query = {
        filter_by: 'Taxes.All',
        usestate: 'false',
        per_page: 100,
        ...(isTds ? { is_tds_request: 'true' } : { is_tcs_request: 'true' })
    };

    try {
        const rawList = await txFetchAll(kind, query);
        const activeList = txActive(rawList);
        const mapped = activeList.map((t) => ({
            id: String(t.tax_id),
            name: t.tax_name || '',
            pct: parseFloat(t.tax_percentage) || 0,
            type: isTds ? 'tds' : 'tcs',
            raw: t
        }));
        return txMerge([], mapped);
    } catch (err) {
        logError('TAX', `Could not load ${kind.toUpperCase()} taxes`, err);
        return [];
    }
}

// antigravity update with dynamic TDS / TCS labels and footer guidance
function txLabels(mode = txMode()) {
    const sel = $('tot-tds-select');
    if (!sel) return;

    const isTds = mode === 'tds';

    const footerBtn = {
        icon: '+',
        label: isTds ? 'New TDS Tax' : 'New TCS Tax',
        onClick: () => {
            openNewWithholdingTaxModal(mode);
        }
    };

    const noteHtml = `<strong>Note:</strong> To view or manage ${isTds ? 'TDS' : 'TCS'}, go to <strong>Settings &gt; Direct Taxes &gt; ${isTds ? 'TDS' : 'TCS'} Rates</strong>.`;

    if (sel._updateFooter) {
        sel._updateFooter([footerBtn], noteHtml);
    }
}

// antigravity update with TDS / TCS dropdown population
function txFill(keepSelected = true) {
    const sel = $('tot-tds-select');
    if (!sel) return;

    const mode = txMode();
    const list = txList(mode);
    const prevVal = keepSelected ? sel.value : '';

    sel.innerHTML = '';
    const placeholder = new Option('Select a Tax', '');
    placeholder.dataset.pct = '0';
    sel.appendChild(placeholder);

    if (list && list.length > 0) {
        list.forEach((t) => {
            const label = t.name.includes(`[${t.pct}%]`) ? t.name : `${t.name} [${t.pct}%]`;
            const opt = new Option(label, t.id);
            opt.dataset.pct = String(t.pct);
            opt.dataset.name = t.name;
            opt.dataset.kind = mode;
            sel.appendChild(opt);
        });
    }

    const exists = Array.from(sel.options).some((o) => o.value === prevVal && o.value !== '');
    sel.value = exists ? prevVal : '';

    txLabels(mode);

    if (sel._sync) sel._sync();
}

function initTdsUi() {
    const sel = $('tot-tds-select');
    if (!sel || sel.dataset.enhanced === '1') return;
    sel.dataset.enhanced = '1';

    lkEnhance(sel, {
        placeholder: 'Select a Tax',
        emptyText: 'No taxes found',
        panelWidth: 280
    });
}

function populateTdsOptions() {
    initTdsUi();
    txFill(true);
}

// ============================================================
// NEW TDS / TCS MODAL CONTROLLER
// ============================================================

// antigravity update with New TDS / TCS modal caching and controllers
const sectionCache = new Map();
let coaCache = null;
let currentWithholdingModalMode = 'tds';

async function fetchSections(taxType, version) {
    const key = `${taxType}_${version}`;
    if (sectionCache.has(key)) {
        return sectionCache.get(key);
    }
    try {
        const res = await zbApi('GET', '/autocomplete/taxspecifictype', {
            search_text: '',
            tax_type: taxType,
            version: parseInt(version) || 2
        });
        const list = Array.isArray(res.data) ? res.data :
                     Array.isArray(res.results) ? res.results :
                     Array.isArray(res.tax_specific_types) ? res.tax_specific_types :
                     Array.isArray(res) ? res : [];
        const mapped = list.map((s) => ({
            value: String(s.value || s.tax_specific_type || s.id || s.section_no || ''),
            section_no: s.section_no || s.section || s.label || s.value || '',
            description: s.description || s.desc || '',
            old_section_no: s.old_section_no || ''
        })).filter((s) => s.value);
        sectionCache.set(key, mapped);
        return mapped;
    } catch (err) {
        logError('TAX', `Failed fetching sections for ${taxType} v${version}`, err);
        return [];
    }
}

async function fetchChartOfAccounts() {
    if (coaCache) return coaCache;
    try {
        const res = await zbApi('GET', '/chartofaccounts', {
            filter_by: 'AccountType.Active',
            per_page: 200
        });
        const list = (res && res.chartofaccounts) || [];
        coaCache = list.map((a) => ({
            id: String(a.account_id),
            name: a.account_name || '',
            type: (a.account_type || '').toLowerCase(),
            raw: a
        }));
        return coaCache;
    } catch (err) {
        logError('TAX', 'Failed to fetch chart of accounts', err);
        return [];
    }
}

async function loadSectionDropdown(taxType, version, selectedValue = '') {
    const sel = $('tx_section');
    if (!sel) return;
    const isTds = taxType === 'tds';
    const placeholderText = isTds ? 'Select a Section' : 'Select a Nature of Collection';

    sel.innerHTML = `<option value="">${placeholderText}</option>`;
    if (sel._sync) sel._sync();

    const sections = await fetchSections(taxType, version);
    sections.forEach((s) => {
        const opt = new Option(s.section_no, s.value);
        if (s.description) opt.dataset.description = s.description;
        sel.appendChild(opt);
    });

    if (selectedValue) {
        sel.value = selectedValue;
    } else if (sections.length > 0) {
        sel.value = sections[0].value;
    }

    if (sel._sync) sel._sync();
}

async function loadAccountDropdowns(taxType) {
    const isTds = taxType === 'tds';
    const accounts = await fetchChartOfAccounts();

    const paySel = $('tx_payable');
    const recSel = $('tx_receivable');

    if (paySel) {
        paySel.innerHTML = '<option value="">Select an account</option>';
        const liabilityAccounts = accounts.filter((a) =>
            a.type === 'other_current_liability' ||
            a.type.includes('liability') ||
            /payable|tds|tcs/i.test(a.name)
        );
        liabilityAccounts.forEach((a) => {
            paySel.appendChild(new Option(a.name, a.id));
        });

        const defPay = isTds
            ? liabilityAccounts.find((a) => /tds\s*payable/i.test(a.name)) || liabilityAccounts[0]
            : liabilityAccounts.find((a) => /tcs\s*payable/i.test(a.name)) || liabilityAccounts.find((a) => a.type === 'other_current_liability') || liabilityAccounts[0];
        if (defPay) paySel.value = defPay.id;
        if (paySel._sync) paySel._sync();
    }

    if (recSel) {
        recSel.innerHTML = '<option value="">Select an account</option>';
        if (isTds) {
            const assetAccounts = accounts.filter((a) =>
                a.type === 'other_current_asset' ||
                a.type.includes('asset') ||
                /advance|receivable/i.test(a.name)
            );
            assetAccounts.forEach((a) => {
                recSel.appendChild(new Option(a.name, a.id));
            });

            // Requirement 5: Default selection find an account named Advance Tax if available
            const defRec = assetAccounts.find((a) => /advance\s*tax/i.test(a.name)) || assetAccounts[0];
            if (defRec) recSel.value = defRec.id;
            if (recSel._sync) recSel._sync();
        }
    }
}

function initWithholdingModalDropdowns() {
    const actSel = $('tx_act');
    if (actSel && actSel.dataset.enhanced !== '1') {
        actSel.dataset.enhanced = '1';
        lkEnhance(actSel, { placeholder: 'Select Income Tax Act' });
    }
    const secSel = $('tx_section');
    if (secSel && secSel.dataset.enhanced !== '1') {
        secSel.dataset.enhanced = '1';
        lkEnhance(secSel, { placeholder: 'Select', panelWidth: 320 });
    }
    const paySel = $('tx_payable');
    if (paySel && paySel.dataset.enhanced !== '1') {
        paySel.dataset.enhanced = '1';
        lkEnhance(paySel, { placeholder: 'Select an account' });
    }
    const recSel = $('tx_receivable');
    if (recSel && recSel.dataset.enhanced !== '1') {
        recSel.dataset.enhanced = '1';
        lkEnhance(recSel, { placeholder: 'Select an account' });
    }
    const whySel = $('tx_why');
    if (whySel && whySel.dataset.enhanced !== '1') {
        whySel.dataset.enhanced = '1';
        lkEnhance(whySel, { placeholder: 'Select a reason' });
    }
}

function wireNewWithholdingTaxModalEvents() {
    const modal = $('tx-modal');
    if (!modal || modal.dataset.wired === '1') return;
    modal.dataset.wired = '1';

    const closeBtn = $('tx-close');
    const cancelBtn = $('tx-cancel');
    const saveBtn = $('tx-save');
    const actSel = $('tx_act');
    const editAccBtn = $('tx-edit-accounts');
    const higherCheck = $('tx_higher_rate');

    if (closeBtn) closeBtn.addEventListener('click', closeNewWithholdingTaxModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeNewWithholdingTaxModal);

    if (actSel) {
        actSel.addEventListener('change', () => {
            loadSectionDropdown(currentWithholdingModalMode, actSel.value);
        });
    }

    if (editAccBtn) {
        editAccBtn.addEventListener('click', () => {
            const wrap = $('tx-custom-accounts');
            if (wrap) {
                wrap.style.display = wrap.style.display === 'none' ? 'grid' : 'none';
            }
        });
    }

    if (higherCheck) {
        higherCheck.addEventListener('change', () => {
            const whyWrap = $('tx-higher-reason-wrap');
            if (whyWrap) {
                whyWrap.style.display = higherCheck.checked ? 'block' : 'none';
            }
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', saveNewWithholdingTax);
    }
}

function openNewWithholdingTaxModal(mode = 'tds') {
    currentWithholdingModalMode = mode;
    const isTds = mode === 'tds';

    const modal = $('tx-modal');
    if (!modal) return;

    initWithholdingModalDropdowns();
    wireNewWithholdingTaxModalEvents();

    const title = $('tx-modal-title');
    if (title) title.textContent = isTds ? 'New TDS' : 'New TCS';

    const nameIn = $('tx_name');
    if (nameIn) { nameIn.value = ''; nameIn.classList.remove('invalid'); }

    const rateIn = $('tx_rate');
    if (rateIn) { rateIn.value = ''; rateIn.classList.remove('invalid'); }

    const actSel = $('tx_act');
    if (actSel) {
        actSel.value = '2';
        if (actSel._sync) actSel._sync();
    }

    const secLbl = $('tx_section_lbl');
    if (secLbl) secLbl.textContent = isTds ? 'Section*' : 'Nature of Collection*';

    const calloutText = $('tx-account-callout-text');
    if (calloutText) {
        calloutText.innerHTML = isTds
            ? 'By default, TDS will be tracked under <strong>TDS Payable</strong> and <strong>TDS Receivable</strong> accounts. Click Edit to choose an account of your choice.'
            : 'By default, TCS will be tracked under <strong>TCS Payable</strong> account. Click Edit to choose an account of your choice.';
    }

    const recWrap = $('tx-receivable-wrap');
    if (recWrap) recWrap.style.display = isTds ? 'block' : 'none';

    const customAccounts = $('tx-custom-accounts');
    if (customAccounts) customAccounts.style.display = 'none';

    const higherCheck = $('tx_higher_rate');
    if (higherCheck) higherCheck.checked = false;

    const higherText = $('tx_higher_rate_text');
    if (higherText) higherText.textContent = isTds ? 'This is a Higher TDS Rate' : 'This is a Higher TCS Rate';

    const higherWrap = $('tx-higher-reason-wrap');
    if (higherWrap) higherWrap.style.display = 'none';

    const whyLbl = $('tx-why-lbl');
    if (whyLbl) whyLbl.textContent = isTds ? 'Reason for Higher TDS Rate*' : 'Reason for Higher TCS Rate*';

    const whySel = $('tx_why');
    if (whySel) {
        whySel.value = 'non_filing_of_return';
        if (whySel._sync) whySel._sync();
    }

    const today = new Date();
    const curYear = today.getFullYear();
    const curMonth = today.getMonth() + 1;
    const fyStartYear = curMonth >= 4 ? curYear : curYear - 1;
    const startIn = $('tx_start_date');
    if (startIn) {
        startIn.value = `${fyStartYear}-04-01`;
    }

    const endIn = $('tx_end_date');
    if (endIn) endIn.value = '';

    const statusEl = $('tx-status');
    if (statusEl) {
        statusEl.textContent = '';
        statusEl.style.color = '';
    }

    const saveBtn = $('tx-save');
    if (saveBtn) saveBtn.disabled = false;

    modal.hidden = false;

    // Load dynamic dropdowns
    loadSectionDropdown(mode, '2');
    loadAccountDropdowns(mode);
}

function closeNewWithholdingTaxModal() {
    const modal = $('tx-modal');
    if (modal) modal.hidden = true;
}

async function saveNewWithholdingTax() {
    const isTds = currentWithholdingModalMode === 'tds';
    const nameIn = $('tx_name');
    const rateIn = $('tx_rate');
    const actSel = $('tx_act');
    const secSel = $('tx_section');
    const paySel = $('tx_payable');
    const recSel = $('tx_receivable');
    const higherCheck = $('tx_higher_rate');
    const whySel = $('tx_why');
    const startIn = $('tx_start_date');
    const endIn = $('tx_end_date');
    const statusEl = $('tx-status');
    const saveBtn = $('tx-save');

    const name = nameIn ? nameIn.value.trim() : '';
    const rate = rateIn ? parseFloat(rateIn.value) : NaN;
    const section = secSel ? secSel.value : '';
    const isHigher = higherCheck ? higherCheck.checked : false;
    const why = whySel ? whySel.value : '';

    if (!name) {
        if (nameIn) nameIn.classList.add('invalid');
        if (statusEl) { statusEl.style.color = '#e11d48'; statusEl.textContent = 'Please enter Tax Name.'; }
        if (nameIn) nameIn.focus();
        return;
    }
    if (nameIn) nameIn.classList.remove('invalid');

    if (isNaN(rate) || rate < 0 || rate > 100) {
        if (rateIn) rateIn.classList.add('invalid');
        if (statusEl) { statusEl.style.color = '#e11d48'; statusEl.textContent = 'Please enter a valid rate between 0 and 100.'; }
        if (rateIn) rateIn.focus();
        return;
    }
    if (rateIn) rateIn.classList.remove('invalid');

    if (!section) {
        if (statusEl) { statusEl.style.color = '#e11d48'; statusEl.textContent = `Please select a ${isTds ? 'Section' : 'Nature of Collection'}.`; }
        return;
    }

    if (isHigher && !why) {
        if (statusEl) { statusEl.style.color = '#e11d48'; statusEl.textContent = 'Please select a reason for higher rate.'; }
        return;
    }

    if (statusEl) {
        statusEl.style.color = '#2563eb';
        statusEl.textContent = 'Creating tax in Zoho Books...';
    }
    if (saveBtn) saveBtn.disabled = true;

    const payload = {
        tax_name: name,
        tax_percentage: rate,
        tax_type: isTds ? 'tds' : 'tcs',
        is_tds: isTds,
        is_active: true,
        applicable_income_tax_act: parseInt(actSel ? actSel.value : 2) || 2,
        tax_specific_type: section,
        section: section,
        ...(paySel && paySel.value ? { payable_account_id: paySel.value } : {}),
        ...(isTds && recSel && recSel.value ? { receivable_account_id: recSel.value } : {}),
        is_higher_tax: isHigher,
        ...(isHigher && why ? { higher_tax_reason: why } : {}),
        ...(startIn && startIn.value ? { start_date: startIn.value } : {}),
        ...(endIn && endIn.value ? { end_date: endIn.value } : {})
    };

    try {
        const res = await zbApi('POST', '/settings/taxes', null, payload);
        const createdTax = (res && res.tax) || { tax_id: res && res.tax_id, tax_name: name, tax_percentage: rate };
        log('TAX', `Created ${isTds ? 'TDS' : 'TCS'} tax`, createdTax);

        // Refresh withholding taxes list
        const freshList = await txLoadWithholding(isTds ? 'tds' : 'tcs');
        if (isTds) {
            state.tdsTaxes = freshList;
        } else {
            state.tcsTaxes = freshList;
        }

        // Refill dropdown and select the created tax
        txFill(false);
        const tdsDropdown = $('tot-tds-select');
        if (tdsDropdown && createdTax.tax_id) {
            tdsDropdown.value = String(createdTax.tax_id);
            if (tdsDropdown._sync) tdsDropdown._sync();
        }

        markDirty();
        recalculateAllAmounts();
        closeNewWithholdingTaxModal();
    } catch (err) {
        logError('TAX', 'Failed to create tax in Zoho Books', err);
        if (statusEl) {
            statusEl.style.color = '#e11d48';
            statusEl.textContent = err.message || 'Failed to create tax in Zoho Books.';
        }
        if (saveBtn) saveBtn.disabled = false;
    }
}

function wireTotalsCardEvents() {
    const txDisc = $('tx-disc');
    const txUnit = $('tx-disc-unit');
    const tdsSel = $('tot-tds-select');
    const adjVal = $('tot-adj-val');

    initTdsUi();

    if (txDisc && txDisc.dataset.wired !== '1') {
        txDisc.dataset.wired = '1';
        txDisc.addEventListener('input', () => { markDirty(); recalculateAllAmounts(); });
    }
    if (txUnit && txUnit.dataset.wired !== '1') {
        txUnit.dataset.wired = '1';
        txUnit.addEventListener('change', () => { markDirty(); recalculateAllAmounts(); });
    }
    if (tdsSel && tdsSel.dataset.wired !== '1') {
        tdsSel.dataset.wired = '1';
        tdsSel.addEventListener('change', () => { markDirty(); recalculateAllAmounts(); });
    }
    document.querySelectorAll('input[name="tds_tcs"]').forEach((r) => {
        if (r.dataset.wired !== '1') {
            r.dataset.wired = '1';
            r.addEventListener('change', () => {
                txFill(false);
                markDirty();
                recalculateAllAmounts();
            });
        }
    });
    if (adjVal && adjVal.dataset.wired !== '1') {
        adjVal.dataset.wired = '1';
        adjVal.addEventListener('input', () => { markDirty(); recalculateAllAmounts(); });
    }
    const adjBox = $('tot-adj-box');
    if (adjBox && adjBox.dataset.wired !== '1') {
        adjBox.dataset.wired = '1';
        adjBox.addEventListener('click', () => {
            const cur = adjBox.textContent.trim() || 'Adjustment';
            const val = prompt('Enter adjustment description:', cur);
            if (val !== null && val.trim()) {
                adjBox.textContent = val.trim();
                markDirty();
            }
        });
    }

    // antigravity update with discount timing link wiring
    if (typeof initDiscountUi === 'function') {
        initDiscountUi();
    }
}

// ============================================================
// VENDOR-BASED GST DETERMINATION FOR LINE ITEMS
// ============================================================

// antigravity update with GST state mapping
const GST_STATE_MAP = [
    { code: '01', alpha: 'JK', name: 'Jammu and Kashmir' },
    { code: '02', alpha: 'HP', name: 'Himachal Pradesh' },
    { code: '03', alpha: 'PB', name: 'Punjab' },
    { code: '04', alpha: 'CH', name: 'Chandigarh' },
    { code: '05', alpha: 'UK', name: 'Uttarakhand' },
    { code: '06', alpha: 'HR', name: 'Haryana' },
    { code: '07', alpha: 'DL', name: 'Delhi' },
    { code: '08', alpha: 'RJ', name: 'Rajasthan' },
    { code: '09', alpha: 'UP', name: 'Uttar Pradesh' },
    { code: '10', alpha: 'BR', name: 'Bihar' },
    { code: '11', alpha: 'SK', name: 'Sikkim' },
    { code: '12', alpha: 'AR', name: 'Arunachal Pradesh' },
    { code: '13', alpha: 'NL', name: 'Nagaland' },
    { code: '14', alpha: 'MN', name: 'Manipur' },
    { code: '15', alpha: 'MZ', name: 'Mizoram' },
    { code: '16', alpha: 'TR', name: 'Tripura' },
    { code: '17', alpha: 'ML', name: 'Meghalaya' },
    { code: '18', alpha: 'AS', name: 'Assam' },
    { code: '19', alpha: 'WB', name: 'West Bengal' },
    { code: '20', alpha: 'JH', name: 'Jharkhand' },
    { code: '21', alpha: 'OD', name: 'Odisha' },
    { code: '22', alpha: 'CG', name: 'Chhattisgarh' },
    { code: '23', alpha: 'MP', name: 'Madhya Pradesh' },
    { code: '24', alpha: 'GJ', name: 'Gujarat' },
    { code: '26', alpha: 'DN', name: 'Dadra and Nagar Haveli and Daman and Diu' },
    { code: '27', alpha: 'MH', name: 'Maharashtra' },
    { code: '28', alpha: 'AP', name: 'Andhra Pradesh' },
    { code: '29', alpha: 'KA', name: 'Karnataka' },
    { code: '30', alpha: 'GA', name: 'Goa' },
    { code: '31', alpha: 'LD', name: 'Lakshadweep' },
    { code: '32', alpha: 'KL', name: 'Kerala' },
    { code: '33', alpha: 'TN', name: 'Tamil Nadu' },
    { code: '34', alpha: 'PY', name: 'Puducherry' },
    { code: '35', alpha: 'AN', name: 'Andaman and Nicobar Islands' },
    { code: '36', alpha: 'TS', name: 'Telangana' },
    { code: '37', alpha: 'AP', name: 'Andhra Pradesh' },
    { code: '38', alpha: 'LA', name: 'Ladakh' },
    { code: '97', alpha: 'OT', name: 'Other Territory' }
];

function extractGstStateCode(val) {
    if (!val) return '';
    const s = String(val).trim();
    if (!s) return '';

    const numMatch = s.match(/^(\d{2})/);
    if (numMatch && GST_STATE_MAP.some((m) => m.code === numMatch[1])) {
        return numMatch[1];
    }

    const clean = s.toLowerCase();
    const byAlpha = GST_STATE_MAP.find((m) => m.alpha.toLowerCase() === clean);
    if (byAlpha) return byAlpha.code;

    const byName = GST_STATE_MAP.find((m) => m.name.toLowerCase() === clean);
    if (byName) return byName.code;

    const byPartial = GST_STATE_MAP.find((m) => clean.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(clean));
    if (byPartial) return byPartial.code;

    return '';
}


/** Any state value (GSTIN, 2-digit code, alpha code, name) -> alpha code like 'MH'. */
function gstAlpha(val) {
    const code = extractGstStateCode(val);
    const m = GST_STATE_MAP.find((x) => x.code === code);
    return m ? m.alpha : '';
}

function setSupplySel(sel, code) {
    const a = gstAlpha(code);
    sel.value = (a && Array.from(sel.options).some((o) => o.value === a)) ? a : '';
    if (sel._sync) sel._sync();
}

/** Fills Source / Destination of Supply from the vendor and delivery data, unless the user has set them by hand. */
function supplySync() {
    const s = $('src-supply'), d = $('dst-supply');
    if (!s || !d) return;
    if (s.dataset.touched !== '1') setSupplySel(s, getVendorGstInfo(true).stateCode);
    if (d.dataset.touched !== '1') setSupplySel(d, getDeliveryLocationGstInfo(true).stateCode);
}

/** Adds the Source of Supply / Destination of Supply row above Reference#. */
/** Adds Source of Supply / Destination of Supply to the grey top block, around Location (matches Zoho Books). */
function buildSupplyFields() {
    if (!orgHasGst() || $('src-supply')) return;

    const top = document.querySelector('.po-top');
    if (!top) return;
    const locRow = $('po-location') ? $('po-location').closest('.po-row') : null;

    const mkRow = (id, label) => {
        const row = document.createElement('div');
        row.className = 'po-row';
        row.innerHTML =
            '<label class="po-label req" for="' + id + '">' + label + '*</label>' +
            '<div class="po-field"><select id="' + id + '" class="form-control po-w"></select></div>';
        return row;
    };

    const srcRow = mkRow('src-supply', 'Source of Supply');
    const dstRow = mkRow('dst-supply', 'Destination of Supply');

    if (locRow) {
        locRow.before(srcRow);   // Source of Supply*
        locRow.after(dstRow);    // Destination of Supply*
    } else {
        top.appendChild(srcRow);
        top.appendChild(dstRow);
    }

    ['src-supply', 'dst-supply'].forEach((id) => {
        const sel = $(id);
        nvFill(sel, NV_STATES.map((s) => [s[0], '[' + s[0] + '] - ' + s[1]]), '');
        lkEnhance(sel, { placeholder: 'Select state', emptyText: 'No states found' });
        sel.addEventListener('change', () => {
            sel.dataset.touched = sel.value ? '1' : '';
            markDirty();
            updateAllLineItemGst(true);
        });
    });
}
// antigravity update with vendor GST determination
function getVendorGstInfo(raw) {
    const c = VA.contact || {};
    const vendorId = dom.vendorId ? dom.vendorId.value : (VA.vendorId || '');
    const treatment = String(c.gst_treatment || '').trim().toLowerCase();
    const gstin = String(c.gst_no || '').trim().toUpperCase();

    const isRegistered = treatment === 'business_gst' ||
        treatment === 'business_composition' ||
        treatment === 'special_economic_zone' ||
        treatment === 'sez_developer' ||
        treatment === 'tax_deductor' ||
        treatment === 'input_service_distributor' ||
        /registered/i.test(treatment) ||
        GSTIN_RE.test(gstin);

    const isUnregistered = (treatment === 'business_none' || (!treatment && !gstin && !!vendorId)) && !isRegistered;
    const isOverseas = treatment === 'overseas';

    // Source of Supply: manual choice > vendor's place_of_contact > GSTIN state > billing > shipping
    let stateCode = '';
    const sel = $('src-supply');
    if (!raw && sel && sel.dataset.touched === '1') stateCode = extractGstStateCode(sel.value);
    if (!stateCode && !isOverseas) {
        stateCode = extractGstStateCode(c.place_of_contact) ||
            extractGstStateCode(c.source_of_supply) ||
            extractGstStateCode(gstin) ||
            extractGstStateCode((c.billing_address || {}).state_code || (c.billing_address || {}).state) ||
            extractGstStateCode((c.shipping_address || {}).state_code || (c.shipping_address || {}).state);
    }

    return {
        vendorId,
        contactName: c.contact_name || '',
        treatment,
        gstin,
        stateCode,
        isRegistered,
        isUnregistered,
        isOverseas
    };
}

// antigravity update with delivery location GST determination
function getDeliveryLocationGstInfo(raw) {
        const mode = deliverMode();
    let stateCode = '';
    let gstin = '';
    let isSez = false;
    let label = '';

    if (mode === 'customer') {
        const so = state.salesOrder || {};
        const custAddress = (CU.chosen && CU.chosen.lines) ? CU.chosen : (so.shippingAddress || so.billingAddress || {});
        label = (CU.chosen && CU.chosen.name) || so.customerName || 'Customer';

        const custGstTreatment = String(so.customer_gst_treatment || CU.chosen?.gst_treatment || '').toLowerCase();
        isSez = custGstTreatment === 'special_economic_zone' || custGstTreatment === 'sez_developer';

        gstin = so.customer_gst_no || so.gst_no || CU.chosen?.gst_no || '';
        stateCode = extractGstStateCode(gstin) ||
                    extractGstStateCode(custAddress.state || custAddress.state_code || so.destination_of_supply || '');
        if (!isSez) {
            const rawAddrText = (Array.isArray(custAddress.lines) ? custAddress.lines.join(' ') : (custAddress.address || '')) + ' ' + (custAddress.attention || '');
            if (/special\s*economic\s*zone|\bsez\b/i.test(rawAddrText)) {
                isSez = true;
            }
        }
    } else {
        const targetId = $('delivery-target') ? $('delivery-target').value : '';
        const locId = $('po-location') ? $('po-location').value : '';
        const loc = findLocationById(targetId) || findLocationById(locId);

        if (loc) {
            label = loc.name || 'Location';
            const rawLoc = loc.raw || {};
            gstin = loc.gst_no || loc.gstin || rawLoc.gst_no || rawLoc.gstin || '';
            stateCode = extractGstStateCode(gstin) || extractGstStateCode(loc.state || loc.state_code || rawLoc.state || '');
            isSez = !!(loc.is_sez || rawLoc.is_sez || /special_economic_zone|sez_developer/i.test(loc.tax_treatment || rawLoc.tax_treatment || ''));
            if (!isSez && /special\s*economic\s*zone|\bsez\b/i.test((loc.name || '') + ' ' + (loc.attention || '') + ' ' + (loc.street1 || ''))) {
                isSez = true;
            }
        }

        if (!stateCode && state.org) {
            const o = state.org;
            const oAddr = o.address || {};
            gstin = gstin || o.gst_no || o.gstin || '';
            stateCode = extractGstStateCode(gstin) || extractGstStateCode(o.state_code || o.state || oAddr.state || '');
            if (!isSez && (o.is_sez || /special_economic_zone|sez_developer/i.test(o.tax_treatment || ''))) {
                isSez = true;
            }
        }

        if (!stateCode && state.salesOrder && state.salesOrder.destination_of_supply) {
            stateCode = extractGstStateCode(state.salesOrder.destination_of_supply);
        }
    }
    // Destination of Supply: manual choice wins
    const dsel = $('dst-supply');
    if (!raw && dsel && dsel.dataset.touched === '1') {
        const manual = extractGstStateCode(dsel.value);
        if (manual) stateCode = manual;
    }

    return {
        mode,
        label,
        gstin,
        stateCode,
        isSez
    };
}

// antigravity update with GST supply type determination
function determineGstSupplyType() {
    const vendor = getVendorGstInfo();
    const dest = getDeliveryLocationGstInfo();
    const rcCheckbox = $('reverse-charge');
    const isRcm = !!((rcCheckbox && rcCheckbox.checked) || vendor.isOverseas);

    // Unregistered vendor without RCM: no GST
    if (vendor.isUnregistered && !isRcm) {
        return {
            supplyType: 'UNREGISTERED',
            taxCategory: 'none',
            vendor,
            dest,
            isRcm: false,
            description: 'Unregistered Vendor (No GST / 0%)'
        };
    }

    // SEZ destination: inter-state
    if (dest.isSez) {
        return {
            supplyType: 'SEZ',
            taxCategory: 'inter',
            vendor,
            dest,
            isRcm,
            description: 'SEZ Supply (Inter-State IGST / Zero-Rated)'
        };
    }

    const vendorState = gstAlpha(vendor.stateCode);
    const destState = gstAlpha(dest.stateCode);

    // Same state: CGST + SGST
    if (vendorState && destState && vendorState === destState) {
        return {
            supplyType: 'INTRA_STATE',
            taxCategory: 'intra',
            vendor,
            dest,
            isRcm,
            description: `Intra-State Supply (CGST + SGST) [State: ${vendorState}]`
        };
    }

    // Different state (or unknown): IGST
    return {
        supplyType: 'INTER_STATE',
        taxCategory: 'inter',
        vendor,
        dest,
        isRcm,
        description: `Inter-State Supply (IGST) [Vendor: ${vendorState || 'Unknown'} → Dest: ${destState || 'Unknown'}]`
    };
}

// antigravity update with tax classification helpers
function isInterStateTax(t) {
    if (!t) return false;
    const spec = String(t.specificType || '').toLowerCase();
    if (spec === 'inter') return true;
    if (spec === 'intra') return false;
    const name = String(t.name || '').toLowerCase();
    return /igst|inter/i.test(name + ' ' + spec);
}

function isIntraStateTax(t) {
    if (!t) return false;
    const spec = String(t.specificType || '').toLowerCase();
    if (spec === 'intra') return true;
    if (spec === 'inter') return false;
    const name = String(t.name || '').toLowerCase();
    if (/igst|inter/i.test(name + ' ' + spec)) return false;
    return t.type === 'tax_group' || /cgst|sgst|gst/i.test(name + ' ' + spec);
}

// antigravity update with auto tax selection for line item
function findBestTaxForLineItem(soItem, masterItem, taxCategory, currentTaxId) {
    if (taxCategory === 'none') {
        return '';
    }

    const m = masterItem || (soItem && soItem.itemId ? state.itemMaster[soItem.itemId] : null);

    if (m && m.is_taxable === false) {
        if (m.tax_exemption_id) return 'exemption:' + m.tax_exemption_id;
        return '';
    }

    if (m && Array.isArray(m.item_tax_preferences) && m.item_tax_preferences.length > 0) {
        const spec = (taxCategory === 'inter') ? 'inter' : 'intra';
        const pref = m.item_tax_preferences.find((p) => p.tax_specification === spec);
        if (pref && pref.tax_id) {
            const exists = state.taxes.some((t) => t.id === String(pref.tax_id));
            if (exists) return String(pref.tax_id);
        }
    }

    let targetPct = null;

    if (currentTaxId) {
        const curTax = state.taxes.find((t) => t.id === String(currentTaxId));
        if (curTax) targetPct = curTax.pct;
    }

    if (targetPct === null && m) {
        if (m.purchase_tax_percentage !== undefined && m.purchase_tax_percentage !== null) {
            targetPct = parseFloat(m.purchase_tax_percentage);
        } else if (m.purchase_tax_id) {
            const pt = state.taxes.find((t) => t.id === String(m.purchase_tax_id));
            if (pt) targetPct = pt.pct;
        }
    }

    if (targetPct === null && soItem) {
        if (soItem.taxPercentage !== undefined && soItem.taxPercentage !== null) {
            targetPct = parseFloat(soItem.taxPercentage);
        } else if (soItem.taxId) {
            const st = state.taxes.find((t) => t.id === String(soItem.taxId));
            if (st) targetPct = st.pct;
        }
    }


        if (targetPct === null || isNaN(targetPct)) {
            return '';   // no preference and no known rate: leave the tax unselected
        }

    let candidateTaxes = (taxCategory === 'inter')
        ? state.taxes.filter(isInterStateTax)
        : state.taxes.filter(isIntraStateTax);

    if (!candidateTaxes.length) {
        candidateTaxes = state.taxes.slice();
    }

    const exactMatch = candidateTaxes.find((t) => Math.abs(t.pct - targetPct) < 0.001);
    if (exactMatch) return exactMatch.id;

    if (candidateTaxes.length > 0) {
        const sorted = candidateTaxes.slice().sort((a, b) => Math.abs(a.pct - targetPct) - Math.abs(b.pct - targetPct));
        return sorted[0].id;
    }

    return '';
}

function taxOptionsFor(soItem) {
    const isGstOrg = orgHasGst();
    const supply = isGstOrg ? determineGstSupplyType() : { taxCategory: 'all' };
    if (!isGstOrg || supply.taxCategory === 'all') return state.taxes.slice();
    if (supply.taxCategory === 'inter') return state.taxes.filter(isInterStateTax);
    if (supply.taxCategory === 'intra') return state.taxes.filter(isIntraStateTax);
    return state.taxes.filter((t) => t.pct === 0);
}


const TAX_EXEMPTION_DESCRIPTIONS = {
    'out of scope':
        "Supplies on which you don't charge any GST or include them in the returns.",
    'non-gst supply':
        'Supplies which do not come under GST such as petroleum products and liquor.'
};

function getTaxExemptionLabel(exemption) {
    const code = String(exemption.code || '').trim();
    const description = String(exemption.description || '').trim();

    if (/out[\s-]*of[\s-]*scope/i.test(code + ' ' + description)) {
        return 'Out of Scope';
    }

    if (/non[\s-]*gst/i.test(code + ' ' + description)) {
        return 'Non-GST Supply';
    }

    return code || description || 'Tax Exemption';
}


// ===== Built-in no-GST tax choices: Non-Taxable / Out of Scope / Non-GST Supply =====
const RE_OOS_TAX = /out[\s-]*of[\s-]*scope/i;
const RE_NONGST_TAX = /non[\s-]*gst/i;

function findExemptionByKind(kind) {
    const re = kind === 'oos' ? RE_OOS_TAX : RE_NONGST_TAX;
    return (state.taxExemptions || []).find((e) => re.test(e.code + ' ' + e.description));
}

// Zoho Books keeps these as normal tax exemptions; create the record once if the org has none yet
async function ensureBuiltinExemption(kind) {
    const found = findExemptionByKind(kind);
    if (found) return found.id;
    const code = kind === 'oos' ? 'Out of Scope' : 'Non-GST Supply';
    const d = await zbApi('POST', '/settings/taxexemptions', {}, {
        tax_exemption_code: code,
        description: TAX_EXEMPTION_DESCRIPTIONS[code.toLowerCase()] || code,
        type: 'item'
    });
    const rec = d && d.tax_exemption;
    if (!rec || !rec.tax_exemption_id) throw new Error('Could not create the "' + code + '" exemption in Zoho Books.');
    const n = { id: String(rec.tax_exemption_id), code: rec.tax_exemption_code || code, description: rec.description || '', type: 'item' };
    state.taxExemptions.push(n);
    return n.id;
}

function taxWarnSync(sel) {
    const td = sel.closest('td');
    if (!td) return;
    const opt = sel.options[sel.selectedIndex];
    const isNT = !!(opt && opt.dataset.builtin === 'nontaxable' && sel.value !== '');
    let w = td.querySelector('.tax-warn');
    if (!isNT) { if (w) w.remove(); return; }
    if (!w) { w = document.createElement('div'); td.appendChild(w); }
    const pending = sel.value === '__nontaxable__';
    w.className = 'tax-warn' + (pending ? ' pending' : '');
    w.innerHTML = '';
    const t = document.createElement('span');
    t.textContent = pending ? 'Exemption reason not chosen*' : 'Reason: ' + (opt.dataset.reason || '');
    const b = document.createElement('button');
    b.type = 'button'; b.title = 'Choose exemption reason'; b.innerHTML = '&#9998;';
    b.addEventListener('click', () => openExemptionReasonPopup(sel));
    w.appendChild(t); w.appendChild(b);
}

function onTaxChoice(sel) {
    const v = sel.value;
    if (v === '__nontaxable__') { taxWarnSync(sel); openExemptionReasonPopup(sel); return; }
    if (v === '__oos__' || v === '__nongst__') {
        ensureBuiltinExemption(v === '__oos__' ? 'oos' : 'nongst').then((id) => {
            const opt = Array.from(sel.options).find((o) => o.value === v);
            if (opt) opt.value = 'exemption:' + id;
            sel.value = 'exemption:' + id;
            if (sel._sync) sel._sync();
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }).catch((err) => {
            logError('TAX', 'Could not apply tax exemption', err);
            setText(dom.footerStatus, err.message || 'Could not apply the tax exemption.');
            sel.value = '';
            if (sel._sync) sel._sync();
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return;
    }
    taxWarnSync(sel);
}

function bindTaxChoice(sel) {
    if (sel.dataset.txBound === '1') return;
    sel.dataset.txBound = '1';
    sel.addEventListener('change', () => onTaxChoice(sel));
}

function openExemptionReasonPopup(sel) {
    const old = document.getElementById('xr-modal');
    if (old) old.remove();
    const reasons = (state.taxExemptions || []).filter((e) => !RE_OOS_TAX.test(e.code + ' ' + e.description) && !RE_NONGST_TAX.test(e.code + ' ' + e.description));
    const ov = document.createElement('div');
    ov.id = 'xr-modal';
    ov.className = 'nv-overlay';
    ov.innerHTML =
        '<div class="nv-box xr-box" role="dialog" aria-modal="true">' +
        '<div class="nv-head"><h3>Choose the reason for exemption</h3><button type="button" class="nv-x" data-x aria-label="Close">&times;</button></div>' +
        '<div class="nv-body"><label class="xr-lbl" for="xr-input">Exemption Reason*</label>' +
        '<input type="text" id="xr-input" class="xr-input" list="xr-list" maxlength="200" placeholder="Select or type to add" autocomplete="off">' +
        '<datalist id="xr-list">' + reasons.map((e) => '<option value="' + escapeHtml(e.code || e.description) + '"></option>').join('') + '</datalist>' +
        '<div class="nv-fe" id="xr-err"></div></div>' +
        '<div class="nv-foot"><button type="button" class="btn btn-primary" id="xr-ok" disabled>Update</button>' +
        '<button type="button" class="btn btn-secondary" data-x>Cancel</button><span class="nv-status" id="xr-st"></span></div></div>';
    document.body.appendChild(ov);

    const input = ov.querySelector('#xr-input');
    const ok = ov.querySelector('#xr-ok');
    const err = ov.querySelector('#xr-err');
    const st = ov.querySelector('#xr-st');
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
    ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) close(); });
    input.addEventListener('input', () => { ok.disabled = !input.value.trim(); err.textContent = ''; });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ok.disabled) ok.click(); });

    ok.addEventListener('click', async () => {
        const text = input.value.trim();
        if (!text) return;
        ok.disabled = true; st.textContent = 'Saving...';
        try {
            const lc = text.toLowerCase();
            let ex = reasons.find((e) => String(e.code).toLowerCase() === lc || String(e.description).toLowerCase() === lc);
            if (!ex) {                                    // typed a new reason -> add it to Zoho Books
                const d = await zbApi('POST', '/settings/taxexemptions', {}, { tax_exemption_code: text, description: text, type: 'item' });
                const rec = d && d.tax_exemption;
                if (!rec || !rec.tax_exemption_id) throw new Error('Could not add the exemption reason.');
                ex = { id: String(rec.tax_exemption_id), code: rec.tax_exemption_code || text, description: rec.description || text, type: 'item' };
                state.taxExemptions.push(ex);
            }
            const nt = Array.from(sel.options).find((o) => o.dataset.builtin === 'nontaxable');
            if (nt) { nt.value = 'exemption:' + ex.id; nt.dataset.reason = ex.code || ex.description; sel.value = nt.value; }
            if (sel._sync) sel._sync();
            close();
            sel.dispatchEvent(new Event('change', { bubbles: true }));    // recalculates + refreshes the reason line
        } catch (e) {
            logError('TAX', 'Exemption reason failed', e);
            err.textContent = e.message || 'Request failed';
            st.textContent = ''; ok.disabled = false;
        }
    });
    setTimeout(() => input.focus(), 0);
}
// antigravity update with dynamic PO line-item GST options
function buildTaxSelect(sel, sourceItem, selectedValue, forceAutoSelect = false, masterItem = null) {
    sel.innerHTML = '';

    const placeholder = new Option('Select a Tax', '');
    placeholder.dataset.pct = '0';
    sel.appendChild(placeholder);

    const isGstOrg = orgHasGst();
    const supply = (isGstOrg && determineGstSupplyType()) || { taxCategory: 'all' };

    // Built-in no-GST choices first, with no group heading (same as Zoho Books)
    if (isGstOrg) {
        const oos = findExemptionByKind('oos');
        const ngs = findExemptionByKind('nongst');
        [
            { kind: 'nontaxable', value: '__nontaxable__', label: 'Non-Taxable', desc: '' },
            { kind: 'oos', value: oos ? 'exemption:' + oos.id : '__oos__', label: 'Out of Scope', desc: TAX_EXEMPTION_DESCRIPTIONS['out of scope'] },
            { kind: 'nongst', value: ngs ? 'exemption:' + ngs.id : '__nongst__', label: 'Non-GST Supply', desc: TAX_EXEMPTION_DESCRIPTIONS['non-gst supply'] }
        ].forEach((b) => {
            const opt = new Option(b.label, b.value);
            opt.dataset.pct = '0';
            opt.dataset.kind = 'exemption';
            opt.dataset.builtin = b.kind;
            if (b.desc) opt.dataset.description = b.desc;
            sel.appendChild(opt);
        });
    } else if ((state.taxExemptions || []).length) {      // non-GST orgs keep the plain exemption list
        const g = document.createElement('optgroup');
        g.label = 'Tax Exemption';
        state.taxExemptions.forEach((e) => {
            const opt = new Option(getTaxExemptionLabel(e), 'exemption:' + e.id);
            opt.dataset.pct = '0';
            opt.dataset.kind = 'exemption';
            g.appendChild(opt);
        });
        sel.appendChild(g);
    }

    // Filter taxes based on GST classification
    let filteredTaxes = [];
    let groupLabel = 'Tax Group';

    if (!isGstOrg || supply.taxCategory === 'all') {
        filteredTaxes = state.taxes.slice();
    } else if (supply.taxCategory === 'inter') {
        filteredTaxes = state.taxes.filter(isInterStateTax);
        // Fallback: If organization has not configured separate IGST taxes in Zoho Books, show available taxes
        if (!filteredTaxes.length) {
            filteredTaxes = state.taxes.slice();
        }
        groupLabel = 'Tax Group';
    } else if (supply.taxCategory === 'intra') {
        filteredTaxes = state.taxes.filter(isIntraStateTax);
        if (!filteredTaxes.length) {
            filteredTaxes = state.taxes.slice();
        }
        groupLabel = 'Tax Group';
    } else if (supply.taxCategory === 'none') {
        filteredTaxes = state.taxes.filter((t) => t.pct === 0);
        groupLabel = '0% GST / No Tax';
    }

    filteredTaxes.sort((a, b) => a.pct - b.pct);

    const taxGroup = document.createElement('optgroup');
    taxGroup.label = groupLabel;

    filteredTaxes.forEach((t) => {
        const label = t.name.includes(`[${t.pct}%]`) ? t.name : `${t.name} [${t.pct}%]`;
        const opt = new Option(
            label,
            t.id
        );

        opt.dataset.pct = String(t.pct);
        opt.dataset.kind = 'tax';
        opt.dataset.taxType = t.type || 'tax';

        taxGroup.appendChild(opt);
    });

    if (taxGroup.children.length) {
        sel.appendChild(taxGroup);
    }

    let chosenValue = selectedValue || '';
    const isExemption = typeof chosenValue === 'string' && chosenValue.startsWith('exemption:');

    if (!isExemption) {
        const optionExists = Array.from(sel.options).some((o) => o.value === chosenValue && o.value !== '');
        if (forceAutoSelect || !optionExists) {
            chosenValue = findBestTaxForLineItem(sourceItem, masterItem, supply.taxCategory, selectedValue);
        }
    }
    // keep a chosen exemption visible after a rebuild (Non-Taxable keeps its reason)
    if (chosenValue.startsWith('exemption:') && !Array.from(sel.options).some((o) => o.value === chosenValue)) {
        const nt = Array.from(sel.options).find((o) => o.dataset.builtin === 'nontaxable');
        if (nt) {
            nt.value = chosenValue;
            const ex = (state.taxExemptions || []).find((e) => 'exemption:' + e.id === chosenValue);
            nt.dataset.reason = ex ? (ex.code || ex.description) : '';
        }
    }

    sel.value = chosenValue || '';

    if (sel._sync) sel._sync();
    bindTaxChoice(sel);                       // handles Non-Taxable / Out of Scope / Non-GST choices
    setTimeout(() => taxWarnSync(sel), 0);    // "Exemption reason not chosen*" line under the field
    
}


// antigravity update with dynamic vendor GST determination for line items
function updateAllLineItemGst(forceAutoSelect = false) {
    if (!orgHasGst()) return;
    supplySync();
    const supply = determineGstSupplyType();
    log('GST_DETERMINATION', `Supply determined: ${supply.supplyType} (${supply.taxCategory})`, {
        vendorState: supply.vendor.stateCode,
        destState: supply.dest.stateCode,
        isSez: supply.dest.isSez,
        isRcm: supply.isRcm
    });

    allRows().forEach((a) => {
        const inputs = getRowInputs(a.lineItemId);
        if (!inputs || !inputs.tax) return;

        const soItem = (state.salesOrder && state.salesOrder.lineItems
            ? state.salesOrder.lineItems.find((li) => li.lineItemId === a.lineItemId)
            : null) || state.extra[a.lineItemId] || a;
        const masterItem = a.itemId ? state.itemMaster[a.itemId] : null;

        buildTaxSelect(inputs.tax, soItem, inputs.tax.value, forceAutoSelect, masterItem);
    });

    recalculateAllAmounts();
}

// antigravity update with robust row tax percent calculation
function rowTaxPct(sel) {
    if (!sel) return 0;
    const o = (sel.selectedOptions && sel.selectedOptions[0]) ||
              (sel.options && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]);
    if (o && o.dataset && o.dataset.pct !== undefined) {
        return parseFloat(o.dataset.pct) || 0;
    }
    if (sel.value && Array.isArray(state.taxes)) {
        const t = state.taxes.find((tx) => String(tx.id) === String(sel.value));
        if (t) return t.pct;
    }
    return 0;
}

function rowDiscountAmount(inputs, lineTotal) {
    const d = parseFloat(inputs.discount.value) || 0;
    return inputs.discount.dataset.pct === '1' ? (lineTotal * d) / 100 : d;
}

function buildItemDetailPanel(soItem, m, tr) {
    const box = document.createElement('div');
    box.className = 'item-detail';
    if (!m) {
        box.innerHTML = '<div class="item-detail-msg">Item master details are not available for this line.</div>';
        return box;
    }

    const cells = [];
    const add = (label, val, section = '') => {
        if (val === undefined || val === null || String(val).trim() === '') return;
        cells.push(`<div class="item-detail-field${section ? ' s-' + section : ''}"><span class="lbl">${escapeHtml(label)}</span><span class="val">${escapeHtml(String(val))}</span></div>`);
    };

    add('SKU', m.sku, 'id');
    add('Item Code', m.item_code, 'id');
    add('Product Type', m.product_type, 'id');
    add('Item Type', m.item_type, 'id');
    add('Unit', m.unit, 'id');
    add('Status', m.status, 'id');

    add('Sales Rate', m.rate != null ? Number(m.rate).toFixed(2) : '', 'sales');
    add('Sales Account', m.account_name, 'sales');
    add('Sales Description', m.description, 'sales');

    add('Purchase Rate (Cost)', m.purchase_rate != null ? Number(m.purchase_rate).toFixed(2) : '', 'purchase');
    add('Purchase Account', m.purchase_account_name, 'purchase');
    add('Purchase Description', m.purchase_description, 'purchase');
    add('Preferred Vendor', m.vendor_name, 'purchase');

    if (m.track_inventory) {
        add('Track Inventory', 'Yes', 'inventory');
        add('Stock on Hand', m.stock_on_hand != null ? m.stock_on_hand : m.actual_available_stock, 'inventory');
        add('Reorder Point', m.reorder_level, 'inventory');
        add('Inventory Account', m.inventory_account_name, 'inventory');
    }

    add('Tax Name', m.tax_name ? m.tax_name + (m.tax_percentage != null ? ' (' + m.tax_percentage + '%)' : '') : '', 'tax');
    if (m.is_taxable !== undefined) add('Taxable', m.is_taxable ? 'Yes' : 'No', 'tax');
    add('HSN / SAC', m.hsn_or_sac, 'tax');

    if (m.length || m.width || m.height) {
        add('Dimensions (L×W×H)', `${m.length || 0} × ${m.width || 0} × ${m.height || 0} ${m.dimension_unit || ''}`, 'fulfil');
    }
    if (m.weight) {
        add('Weight', `${m.weight} ${m.weight_unit || ''}`, 'fulfil');
    }

    (m.custom_fields || []).forEach((cf) => {
        add(cf.label || cf.placeholder || 'Custom Field', cf.value_formatted || cf.value, 'custom');
    });

    const grid = document.createElement('div');
    grid.className = 'item-detail-grid';
    grid.innerHTML = cells.join('') || '<div class="item-detail-msg">No additional details on this item.</div>';
    box.appendChild(grid);

    const act = document.createElement('div');
    act.className = 'item-detail-actions';
    const mk = (text, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-link';
        b.textContent = text;
        b.addEventListener('click', fn);
        act.appendChild(b);
    };

    if (parseFloat(m.purchase_rate) > 0) {
        mk('Use purchase rate (' + m.purchase_rate + ')', () => {
            const r = tr.querySelector('.rate-input');
            if (r) {
                r.value = String(m.purchase_rate);
                r.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    }
    if (m.purchase_description) {
        mk('Use purchase description', () => {
            const d = tr.querySelector('.desc-input');
            if (d) {
                d.value = m.purchase_description;
                d.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    }
    if (m.purchase_account_id) {
        mk('Use purchase account (' + (m.purchase_account_name || 'Item default') + ')', () => {
            const a = tr.querySelector('.acc-select');
            if (a) {
                a.value = String(m.purchase_account_id);
                if (a._sync) a._sync();
                a.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    }
    if (act.children.length) box.appendChild(act);
    return box;
}

function flagAmountInputs(tr) {
    if (!tr) return;
    const rate = tr.querySelector('.rate-input'), disc = tr.querySelector('.discount-input'), qty = tr.querySelector('.qty-input');
    if (!rate || !disc || !qty) return;
    const r = parseFloat(rate.value), d = parseFloat(disc.value) || 0;
    const lineTotal = (parseFloat(qty.value) || 0) * (isNaN(r) ? 0 : r);
    const rateBad = rate.value !== '' && (isNaN(r) || r < 0);
    const discBad = d < 0 || d > (disc.dataset.pct === '1' ? 100 : lineTotal);
    rate.classList.toggle('error', rateBad);
    rate.title = rateBad ? 'Rate cannot be negative.' : '';
    disc.classList.toggle('error', discBad);
    disc.title = discBad ? 'Discount cannot be negative or exceed the line amount.' : '';
}

// ============================================================
// EXTRA ITEM ROWS: item master picker, new item, add / duplicate / remove
// ============================================================

state.extra = {};
state.itemList = [];
let extraSeq = 0;

function allRows() { return Object.values(state.lineItems).concat(Object.values(state.extra)); }

function injectExtraCss() {
    if ($('extra-styles')) return;
    const s = document.createElement('style');
    s.id = 'extra-styles';
    s.textContent = `
.item-pick{display:block;width:100%;text-align:left;padding:7px 10px;border:1px solid #d0d5dc;border-radius:4px;background:#fff;font:inherit;font-size:13px;font-weight:600;color:#1f2933;cursor:pointer}
.item-pick.empty{color:#9aa3b2;font-weight:400}
.item-pick:hover{border-color:#408dfb}
.zi-top .zi-pick{flex:1;min-width:0}
.row-err-msg{margin-top:6px;font-size:11.5px;color:#d32f2f}
tr.row-err td{background:#fff8f8!important}
.disc-mode{padding:6px 4px;border:1px solid #d0d5dc;border-radius:4px;background:#fff;font-size:12px}
.row-loc .apply-all{border:0;background:none;color:#1a73e8;font-size:11px;cursor:pointer;padding:0;white-space:nowrap}
.row-loc .apply-all:hover{text-decoration:underline}`;
    document.head.appendChild(s);
}



const IP = { panel: null, open: false, anchor: null, onPick: null, query: '', active: 0, items: [], loading: false, error: '', timer: null, limit: 60, pending: false, sq: '' };

const itemSrc = createSource({
    entity: 'items_v4',
    idOf: (i) => i.id,
    compare: (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    fetchPage: async (page, per, search) => {
        const q = { filter_by: 'Status.Active', page, per_page: per, sort_column: 'name' };
        if (search) q.search_text = search;
        const d = await zbApi('GET', '/items', q);
        const records = (d.items || [])
            .filter((i) => String(i.status || 'active').toLowerCase() === 'active')   // active items only
            .map(normItem);
        return { records, hasMore: (d.page_context || {}).has_more_page === true };
    }
});
itemSrc.onChange = () => {
    state.itemList = itemSrc.all();
    if (IP.open) ipPaint();
    if (typeof BK !== 'undefined' && BK.open) bkPaint();
};
itemSrc.onChange = () => { state.itemList = itemSrc.all(); if (IP.open) ipPaint(); };

function itemMerge(list) { itemSrc.upsert(list); }                       // create / edit item -> cache
async function fetchItemList(q) { return itemSrc.peek(q); }               // duplicate checks: one server search, merged into the cache



// const IP = { panel: null, open: false, anchor: null, onPick: null, query: '', active: 0, items: [], loading: false, error: '', timer: null };

function ipBuild() {
    if (IP.panel) return;
    const p = document.createElement('div');
    p.className = 'ad-panel';
    p.hidden = true;
    p.innerHTML =
        '<div class="ad-search"><input type="text" placeholder="Search by item name or SKU" autocomplete="off"></div>' +
        '<div class="ad-list"></div>' +
        '<div class="ad-foot"><button type="button" class="ad-new"><span class="vp-plus">+</span><span>New Item</span></button></div>';
    document.body.appendChild(p);
    IP.panel = p;

    const inp = p.querySelector('input');
    inp.addEventListener('input', () => {
        IP.query = inp.value.trim();
        IP.active = 0; IP.limit = 60; IP.error = '';
        p.querySelector('.ad-list').scrollTop = 0;
        ipPaint();
        clearTimeout(IP.timer);
        IP.timer = setTimeout(ipSearchServer, 300);
    });
    attachInfiniteScroll(p.querySelector('.ad-list'), ipNear);
    inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); IP.active = Math.min(IP.items.length - 1, IP.active + 1); ipMark(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); IP.active = Math.max(0, IP.active - 1); ipMark(); }
        else if (ev.key === 'Enter') { ev.preventDefault(); ipPick(IP.active); }
        else if (ev.key === 'Escape') { ev.preventDefault(); ipClose(); }
    });
    p.querySelector('.ad-new').addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const nm = IP.query, cb = IP.onPick;
        ipClose();
        openNewItemModal(nm, cb, ev.currentTarget);
    });
    document.addEventListener('mousedown', (ev) => {
        if (IP.open && !p.contains(ev.target) && !(IP.anchor && IP.anchor.contains(ev.target))) ipClose();
    });
    document.addEventListener('scroll', (ev) => { if (IP.open && !p.contains(ev.target)) ipPlace(); }, true);
    window.addEventListener('resize', () => { if (IP.open) ipPlace(); });
}

function ipPlace() {
    const a = IP.anchor.getBoundingClientRect(), p = IP.panel;
    const w = Math.min(460, window.innerWidth - 16);
    p.style.width = w + 'px';
    p.style.left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8)) + 'px';
    const below = window.innerHeight - a.bottom - 12;
    if (below >= 260 || below >= a.top) {
        p.style.top = (a.bottom + 4) + 'px'; p.style.bottom = 'auto';
        p.style.maxHeight = Math.max(200, Math.min(440, below)) + 'px';
    } else {
        p.style.bottom = (window.innerHeight - a.top + 4) + 'px'; p.style.top = 'auto';
        p.style.maxHeight = Math.max(200, Math.min(440, a.top - 12)) + 'px';
    }
}


function ipTail(list, text, retry) {
    const d = document.createElement('div');
    d.className = 'ad-msg';
    d.textContent = text;
    if (retry) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-secondary'; b.textContent = 'Retry';
        b.addEventListener('mousedown', (ev) => { ev.preventDefault(); IP.error = ''; ipFetchMore(); });
        d.appendChild(document.createElement('br'));
        d.appendChild(b);
    }
    list.appendChild(d);
}

const ipQ = () => (IP.query.length >= 2 ? IP.query : '');


function normItem(i) {
    const name = i.name || i.item_name || '';
    const sohRaw = (i.stock_on_hand === undefined || i.stock_on_hand === null || i.stock_on_hand === '')
        ? null : parseFloat(i.stock_on_hand);

    return {
        id: String(i.item_id || ''),
        name: name,
        sku: i.sku || '',
        itemCode: i.item_code || '',
        upc: i.upc || '',
        ean: i.ean || '',
        isbn: i.isbn || '',
        partNumber: i.part_number || '',
        unit: i.unit || '',
        brand: i.brand || '',
        manufacturer: i.manufacturer || '',
        categoryId: String(i.category_id || ''),
        categoryName: i.category_name || '',
        type: String(i.product_type || '').toLowerCase(),
        itemType: String(i.item_type || '').toLowerCase(),
        hsn: i.hsn_or_sac || '',
        purchaseRate: i.purchase_rate,
        stockOnHand: (sohRaw !== null && isFinite(sohRaw)) ? sohRaw : null,
        status: String(i.status || 'active').toLowerCase(),

        _k: [
            name,
            i.sku || '',
            i.item_code || '',
            i.upc || '',
            i.ean || '',
            i.isbn || '',
            i.part_number || '',
            i.hsn_or_sac || '',
            i.brand || '',
            i.manufacturer || '',
            i.unit || ''
        ].join(' ').toLowerCase()
    };
}


function ipPaint() {
    if (!IP.open) return;
    const list = IP.panel.querySelector('.ad-list');
    const all = itemSrc.view(IP.query);
    IP.items = all;
    const top = list.scrollTop;
    list.innerHTML = '';

    if (!all.length) {
        if (IP.loading) ipTail(list, 'Loading items…');
        else if (IP.error) ipTail(list, 'Could not load items: ' + IP.error, true);
        else if (itemSrc.canMore(ipQ())) {
            ipTail(list, 'Searching Zoho Books…');
            if (!IP.query) setTimeout(ipFetchMore, 0);
        } else ipTail(list, 'No items found. Use "New Item" below to create one.');
        return;
    }

    const shown = Math.min(all.length, IP.limit);
    if (IP.active >= shown) IP.active = 0;
    all.slice(0, shown).forEach((it, i) => {
        const d = document.createElement('div');
        d.className = 'vp-item' + (i === IP.active ? ' active' : '');
        d.dataset.i = String(i);

        const av = document.createElement('span');
        av.className = 'vp-av';
        av.textContent = (it.name.trim().charAt(0) || '?').toUpperCase();

        const tx = document.createElement('div');
        tx.className = 'vp-tx';
        tx.style.flex = '1';

        const head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0';
        const nm = document.createElement('span');
        nm.className = 'vp-nm';
        nm.textContent = it.name;
        head.appendChild(nm);
        if (it.type) {
            const pill = document.createElement('span');
            pill.className = it.type === 'service' ? 'zb-pill-service' : 'zb-pill-goods';
            pill.textContent = it.type === 'service' ? 'SERVICE' : 'GOODS';
            head.appendChild(pill);
        }
        if (it.status && it.status !== 'active') {
            const st = document.createElement('span');
            st.className = 'zi-status inactive';
            st.textContent = it.status.toUpperCase();
            head.appendChild(st);
        }
        tx.appendChild(head);

        const hasRate = it.purchaseRate !== undefined && it.purchaseRate !== null && it.purchaseRate !== '';
        const sub = [
            it.sku ? 'SKU: ' + it.sku : '',
            it.unit ? 'Unit: ' + it.unit : '',
            it.hsn ? (it.type === 'service' ? 'SAC: ' : 'HSN: ') + it.hsn : '',
            hasRate ? 'Purchase rate: ' + it.purchaseRate : ''
        ].filter(Boolean).join(' · ');
        if (sub) {
            const s = document.createElement('span');
            s.className = 'vp-sub';
            s.textContent = sub;
            tx.appendChild(s);
        }

        d.appendChild(av);
        d.appendChild(tx);
        d.addEventListener('mousedown', (ev) => { ev.preventDefault(); ipPick(i); });
        d.addEventListener('mouseenter', () => { IP.active = i; ipMark(); });
        list.appendChild(d);
    });
    if (IP.loading) ipTail(list, 'Loading more…');
    else if (IP.error) ipTail(list, 'Could not load more items.', true);
    list.scrollTop = top;

    const more = IP.limit < all.length || (itemSrc.canMore(ipQ()) && (!IP.query || IP.sq === IP.query));
    if (!IP.loading && !IP.error && more && list.scrollHeight <= list.clientHeight + 40) setTimeout(ipNear, 0);
}

const NI_UNVERIFIED = ['brand', 'manufacturer', 'upc', 'ean', 'isbn', 'part_number', 'mrp', 'category_id',
    'is_returnable', 'package_details', 'inventory_valuation_method', 'track_bin_location'];

function niEchoCheck(sent, rec) {
    const used = NI_UNVERIFIED.filter((k) => sent[k] !== undefined);
    if (!used.length) return;
    const missing = used.filter((k) => rec[k] === undefined || rec[k] === null || rec[k] === '');
    log('NEW_ITEM', 'Undocumented fields sent: ' + used.join(', '));
    if (missing.length) logError('NEW_ITEM', 'Not echoed by Zoho (possibly ignored): ' + missing.join(', '));
}

async function niSkuTaken(sku, ignoreId) {
    const key = String(sku || '').trim().toLowerCase();
    if (!key) return null;
    const same = (i) => i.sku && String(i.sku).trim().toLowerCase() === key && i.id !== String(ignoreId || '');
    const hit = (state.itemList || []).find(same);
    if (hit) return hit;
    try { return (await fetchItemList(sku)).find(same) || null; }
    catch (e) { logError('NEW_ITEM', 'SKU check failed, Zoho will validate on save', e); return null; }
}

async function niEnsureComplete(rec, body) {
    const thin = rec.purchase_rate === undefined || (body.unit && !rec.unit) || (body.sku && !rec.sku);
    if (!thin) return rec;
    log('NEW_ITEM', 'Create response incomplete, fetching item detail', rec.item_id);
    try {
        const full = await fetchItemById(String(rec.item_id), true);
        return full ? Object.assign({}, rec, full) : rec;
    } catch (e) { logError('NEW_ITEM', 'Detail fetch failed, using create response', e); return rec; }
}
function ipNear() {
    if (IP.limit < IP.items.length) { IP.limit += 60; ipPaint(); return; }
    if (!IP.error) ipFetchMore();
}

function ipFetchMore() {
    if (IP.loading) { IP.pending = true; return; }
    const q = ipQ();
    if (!itemSrc.canMore(q)) return;
    IP.loading = true; IP.error = '';
    ipPaint();
    itemSrc.loadMore(q)
        .catch((e) => { IP.error = e.message || 'Request failed'; logError('ITEM', 'Item list failed', e); })
        .then(() => {
            IP.loading = false;
            ipPaint();
            const again = IP.pending && !IP.error;
            IP.pending = false;
            if (again) ipFetchMore();
        });
}

function ipSearchServer() { IP.sq = IP.query; if (ipQ()) ipFetchMore(); }

async function ipLoad() {
    IP.loading = true; IP.error = '';
    ipPaint();
    try { await itemSrc.init(); }
    catch (e) { IP.error = e.message || 'Request failed'; logError('ITEM', 'Item list failed', e); }
    IP.loading = false;
    ipPaint();
}

function ipOpen(anchor, onPick) {
    ipBuild();
    IP.open = true; IP.anchor = anchor; IP.onPick = onPick;
    IP.query = ''; IP.active = 0; IP.limit = 60; IP.error = ''; IP.sq = '';
    const inp = IP.panel.querySelector('input');
    inp.value = '';
    IP.panel.hidden = false;
    ipPlace();
    ipPaint();                 // cached items show instantly
    ipLoad();
    itemSrc.staleCheck();
    setTimeout(() => inp.focus(), 0);
}

function ipMark() {
    IP.panel.querySelectorAll('.vp-item').forEach((n, i) => {
        n.classList.toggle('active', i === IP.active);
        if (i === IP.active && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
    });
}






function ipClose() {
    if (!IP.panel) return;
    IP.open = false;
    IP.panel.hidden = true;
    clearTimeout(IP.timer);
}

function ipPick(i) {
    const it = IP.items[i], cb = IP.onPick;
    if (!it || !cb) return;
    ipClose();
    cb(it);
}
// ============================================================
// NEW ITEM (full form) + EDIT ITEM
// ============================================================
const NI = { lists: {}, exempt: null, cf: null, vendors: null };
const NI_LISTS = {
    category: { label: 'Category', api: { path: '/categories', key: 'categories', id: 'category_id', name: 'name' } },
    brand: { label: 'Brand' }, manufacturer: { label: 'Manufacturer' }, unit: { label: 'Unit' }
};
const NI_ACC = { sales: ['income', 'other_income'], purchase: ['expense', 'cost_of_goods_sold', 'other_expense'], inventory: ['stock'] };
const RE_OOS = /out[\s-]*of[\s-]*scope/i, RE_NONGST = /non[\s-]*gst/i;

function niCss() {
    if ($('ni-styles')) return;
    const s = document.createElement('style');
    s.id = 'ni-styles';
    s.textContent = '.ni-h{margin:18px 0 12px;padding-top:14px;border-top:1px solid #e5e5e5;font-size:14px;font-weight:600}' +
        '.ni-h:first-child{border-top:0;margin-top:0;padding-top:0}.ni-dim{display:flex;gap:6px;align-items:center}' +
        '.ni-dim input{width:64px}.ni-hint{font-size:12px;color:#888;margin-top:4px}';
    document.head.appendChild(s);
}

// ---------- generic modal ----------
function niModal(id, title, body, w, z, saveText) {
    const old = $(id); if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = id; ov.className = 'nv-overlay'; ov.style.zIndex = String(z || 22000);
    ov.innerHTML = '<div class="nv-box" role="dialog" aria-modal="true" style="max-width:' + w + 'px">' +
        '<div class="nv-head"><h3></h3><button type="button" class="nv-x" data-x aria-label="Close">&times;</button></div>' +
        '<div class="nv-body">' + body + '</div><div class="nv-foot">' +
        (saveText ? '<button type="button" class="btn btn-primary" data-save></button>' : '') +
        '<button type="button" class="btn btn-secondary" data-cancel>' + (saveText ? 'Cancel' : 'Close') + '</button>' +
        '<span class="nv-status"></span></div></div>';
    ov.querySelector('h3').textContent = title;
    const sv = ov.querySelector('[data-save]'); if (sv) sv.textContent = saveText;
    document.body.appendChild(ov);
    const h = { ov, q: (s) => ov.querySelector(s), status: ov.querySelector('.nv-status'), save: sv, busy: false };
    h.close = () => { if (!h.busy) ov.remove(); };
    ov.querySelector('[data-x]').onclick = h.close;
    ov.querySelector('[data-cancel]').onclick = h.close;
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) h.close(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); h.close(); } });
    return h;
}

// ---------- managed lists: category / brand / manufacturer / unit ----------
// Category uses the API when it responds. Brand, manufacturer and unit are plain text on the item,
// so their lists are kept per organization in localStorage (seeded from items already loaded).
const niKey = (k) => 'ni_list_' + state.organizationId + '_' + k;
function niStored(k) { try { const v = localStorage.getItem(niKey(k)); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function niStore(k, names) { try { localStorage.setItem(niKey(k), JSON.stringify(names)); } catch (e) { /* storage blocked */ } }


function niUniqueList(rows, key) {
    const seen = new Map();

    (rows || []).forEach((row) => {
        const value = String(row[key] || '').trim();
        if (!value) return;

        const normalized = value.toLowerCase();
        if (!seen.has(normalized)) {
            seen.set(normalized, value);
        }
    });

    return Array.from(seen.values())
        .sort((a, b) => a.localeCompare(b));
}

function niFlattenCategories(categories, output) {
    (categories || []).forEach((category) => {
        if (!category) return;

        const id = String(category.category_id || '');
        const name = String(category.name || '').trim();

        if (id && name) {
            output.push({
                id: id,
                name: name,
                api: true
            });
        }

        if (Array.isArray(category.children)) {
            niFlattenCategories(category.children, output);
        }
    });
}

async function niFetchCategories() {
    const output = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 50) {
        const data = await zbApi('GET', '/categories', {
            page: page,
            per_page: 200
        });

        niFlattenCategories(data.categories || [], output);

        hasMore =
            data.page_context &&
            data.page_context.has_more_page === true;

        page++;
    }

    return output;
}

async function niFetchItemAttributes() {
    const values = {
        brand: [],
        manufacturer: [],
        unit: []
    };

    let page = 1;
    let hasMore = true;

    // Read existing item records using the official Items API.
    while (hasMore && page <= 50) {
        const data = await zbApi('GET', '/items', {
            filter_by: 'Status.Active',
            page: page,
            per_page: 200
        });

        (data.items || []).forEach((item) => {
            ['brand', 'manufacturer', 'unit'].forEach((key) => {
                const value = String(item[key] || '').trim();
                if (value) values[key].push(value);
            });
        });

        hasMore =
            data.page_context &&
            data.page_context.has_more_page === true;

        page++;
    }

    return values;
}

async function niListLoadRaw(k, force) {
    if (NI.lists[k] && !force) {
        return NI.lists[k];
    }

    const def = NI_LISTS[k];

    if (!def) {
        throw new Error('Unknown New Item dropdown: ' + k);
    }

    try {
        let output = [];

        if (k === 'category') {
            output = await niFetchCategories();
        } else {
            // Brand, Manufacturer and Unit are item string fields.
            // const attributes = await niFetchItemAttributes();
            let attributes = {};
            if (NI.attrDone) {
                attributes = await niAttrsOnce();
            } else if (!NI.attrKick) {
                NI.attrKick = true;   // full item scan runs once, in the background
                niAttrsOnce()
                    .then(() => ['brand', 'manufacturer', 'unit'].forEach((x) => NI.refresh[x] && NI.refresh[x]()))
                    .catch(() => { });
            }
            const cachedNames = niStored(k) || [];
            const masterNames = Object.values(state.itemMaster || {})
                .map((item) => item && item[k])
                .filter(Boolean);

            const itemNames = attributes[k] || [];

            // Include already loaded item-picker data.
            if (k === 'unit') {
                itemNames.push(
                    ...(state.itemList || []).map((item) => item.unit)
                );
            }

            const names = niUniqueList(
                cachedNames.concat(masterNames, itemNames)
                    .map((name) => ({ name })),
                'name'
            );

            output = names.map((name) => ({
                id: name,
                name: name,
                api: false
            }));

            niStore(k, names);
        }

        NI.lists[k] = output;

        log('NEW_ITEM', k + ' dropdown loaded', {
            count: output.length,
            values: output
        });

        return output;

    } catch (error) {
        logError('NEW_ITEM', 'Failed to load ' + k + ' dropdown', error);

        // Preserve locally available values if the API is unavailable.
        const stored = niStored(k) || [];

        if (k === 'category') {
            const localCategories = Object.values(state.itemMaster || {})
                .filter((item) => item && item.category_id && item.category_name)
                .map((item) => ({
                    id: String(item.category_id),
                    name: item.category_name,
                    api: false
                }));

            NI.lists[k] = localCategories;
        } else {
            NI.lists[k] = niUniqueList(
                stored.concat(
                    Object.values(state.itemMaster || {})
                        .map((item) => item && item[k])
                        .filter(Boolean)
                ).map((name) => ({ name })),
                'name'
            ).map((name) => ({
                id: name,
                name: name,
                api: false
            }));
        }

        return NI.lists[k];
    }
}


async function niListMutate(k, op, rec, name) {
    const def = NI_LISTS[k];
    await niListLoad(k);
    if (def.api && def.api.on !== false) {
        if (op === 'create') await zbApi('POST', def.api.path, {}, { name });
        else if (op === 'edit') await zbApi('PUT', def.api.path + '/' + rec.id, {}, { name });
        else await zbApi('DELETE', def.api.path + '/' + rec.id);
        return niListLoad(k, true);
    }
    let names = NI.lists[k].map((r) => r.name);
    if (op === 'create') names.push(name);
    else if (op === 'edit') names = names.map((n) => (n === rec.name ? name : n));
    else names = names.filter((n) => n !== rec.name);
    niStore(k, names);
    return niListLoad(k, true);
}


let niAttrP = null;
function niAttrsOnce() {
    if (!niAttrP) {
        niAttrP = niFetchItemAttributes()
            .then((a) => { NI.attrDone = true; return a; })
            .catch((e) => { niAttrP = null; throw e; });
    }
    return niAttrP;
}
NI.pend = {};
NI.refresh = {};
function niListLoad(k, force) {
    if (!force && NI.pend[k]) return NI.pend[k];
    const p = niListLoadRaw(k, force).finally(() => { delete NI.pend[k]; });
    NI.pend[k] = p;
    return p;
}

function niNameEditor(k, rec, done) {
    const L = NI_LISTS[k].label;
    const h = niModal('ni-name', (rec ? 'Edit ' : 'New ') + L,
        '<div class="nv-row"><label class="nv-l req">' + L + ' Name*</label><div class="nv-c"><input type="text" id="nn_name" class="nv-main" maxlength="100" autocomplete="off"></div></div>', 440, 23000, 'Save');
    const inp = h.q('#nn_name');
    inp.value = rec ? rec.name : '';
    const go = async () => {
        if (h.busy) return;
        const n = inp.value.trim();
        nvMark(inp, '');
        if (!n) { nvMark(inp, 'Name is required'); return; }
        const list = await niListLoad(k);
        if (list.some((r) => r.name.toLowerCase() === n.toLowerCase() && (!rec || r.id !== rec.id))) { nvMark(inp, 'Already exists'); return; }
        h.busy = true; h.save.disabled = true; h.status.textContent = 'Saving…';
        try { await niListMutate(k, rec ? 'edit' : 'create', rec, n); h.busy = false; h.ov.remove(); done(n); }
        catch (e) { h.busy = false; h.save.disabled = false; h.status.textContent = 'Save failed: ' + (e.message || 'Request failed'); }
    };
    h.save.onclick = go;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    setTimeout(() => inp.focus(), 30);
}

function niManage(k, after) {
    const L = NI_LISTS[k].label;
    const h = niModal('ni-manage', 'Manage ' + L + 's', '<button type="button" class="btn btn-primary ni-new">+ New ' + L + '</button><div class="ptm-rows" style="margin-top:12px"></div>', 520, 22500);
    const rows = h.q('.ptm-rows');
    async function paint() {
        const list = await niListLoad(k);
        rows.innerHTML = '';
        if (!list.length) { rows.innerHTML = '<div class="ptm-msg">None found</div>'; return; }
        list.forEach((r) => {
            const row = document.createElement('div');
            row.className = 'ptm-row'; row.style.gridTemplateColumns = 'minmax(0,1fr) 140px';
            const nm = document.createElement('span'); nm.textContent = r.name; row.appendChild(nm);
            const act = document.createElement('span'); act.className = 'ptm-acts';
            const b = (t, f) => { const x = document.createElement('button'); x.type = 'button'; x.textContent = t; x.onclick = f; act.appendChild(x); };
            b('\u270e Edit', () => niNameEditor(k, r, () => { paint(); after(); }));
            b('\ud83d\uddd1 Delete', async () => {
                if (!(await adConfirm('Delete ' + L, 'Delete "' + r.name + '"?'))) return;
                try { await niListMutate(k, 'delete', r); paint(); after(); }
                catch (e) { h.status.textContent = 'Could not delete: ' + (e.message || 'Request failed'); }
            });
            row.appendChild(act); rows.appendChild(row);
        });
    }
    h.q('.ni-new').onclick = () => niNameEditor(k, null, () => { paint(); after(); });
    paint();
}

/** Fills a <select> from a managed list and makes it a searchable dropdown with New / Manage. */

async function niBindList(k, sel, selected) {
    if (!sel) {
        logError('NEW_ITEM', 'Missing dropdown element: ' + k);
        return;
    }

    const L = NI_LISTS[k].label;
    const isCat = k === 'category';
    const val = (r) => isCat ? String(r.id) : r.name;

    async function refill(selectedValue, force) {
        const list = await niListLoad(k, force);
        if (!sel.isConnected) return;

        const current = selectedValue !== undefined
            ? String(selectedValue)
            : String(sel.value || '');
        const o = sel.options[sel.selectedIndex];
        const keepText = (o && o.value === current) ? o.text : current;

        nvFill(sel, list.map((r) => [val(r), r.name]), '');

        if (current && !Array.from(sel.options).some((x) => x.value === current)) {
            sel.appendChild(new Option(keepText, current));
        }
        sel.value = current;
        if (sel._sync) sel._sync();
    }

    // Show the searchable dropdown at once; values load in the background.
    nvFill(sel, [], '');
    if (selected && !isCat) {
        sel.appendChild(new Option(selected, selected));
        sel.value = selected;
    }

    lkEnhance(sel, {
        clearable: true,
        placeholder: 'Select or Add ' + L,
        emptyText: 'No ' + L.toLowerCase() + ' found',
        footer: [
            {
                icon: '+',
                label: 'New ' + L,
                onClick: () => niNameEditor(k, null, (name) => refill(isCat ? '' : name))
            },
            {
                icon: '\u2699',
                label: 'Manage ' + L + 's',
                onClick: () => niManage(k, () => refill())
            }
        ]
    });

    NI.refresh[k] = () => refill(undefined, true).catch(() => { });
    refill(undefined).catch((e) => logError('NEW_ITEM', L + ' dropdown load failed', e));
}


// ============================================================
// HSN / SAC SEARCH (confirmed Zoho Books endpoint)
//   GET /meta/hsncodes?search_text=&country=&is_service_item=&organization_id=
//   Response: { code, message, result:[{ weightage, description, hsn_code }] }
// ============================================================

const HSN = {
    query: '',
    items: [],
    active: 0,
    loading: false,
    error: '',
    timer: null,
    token: 0,
    isService: false,
    panel: null,
    anchor: null,
    onPick: null,
    open: false,
    minChars: 3
};

function hsnCountry() {
    const o = state.org || {};
    const c = String(o.country || '').trim();
    if (c) return c;
    const code = String(o.country_code || '').toUpperCase();
    if (code === 'IN') return 'India';
    return code || 'India';
}

async function hsnSearch(searchText, isService, token) {
    const text = String(searchText || '').trim();
    if (text.length < HSN.minChars) return { results: [] };

    const q = {
        search_text: text,
        country: hsnCountry(),
        is_service_item: isService ? 'true' : 'false'
    };

    const data = await zbApi('GET', '/meta/hsncodes', q);

    if (token !== HSN.token) return null;   // stale response: a newer query is in flight

    if (Number(data.code) !== 0) {
        throw new Error(data.message || ('HSN search failed (code ' + data.code + ')'));
    }

    const raw = Array.isArray(data.result) ? data.result : [];
    const results = raw
        .map((r) => ({
            hsnCode: r && r.hsn_code != null ? String(r.hsn_code) : '',
            description: r && r.description != null ? String(r.description) : '',
            weightage: r && r.weightage != null ? r.weightage : 0
        }))
        .filter((r) => r.hsnCode !== '');

    return { results };
}
function hsnBuildPanel() {
    if (HSN.panel) return;
    const p = document.createElement('div');
    p.className = 'hsn-panel';
    p.hidden = true;
    p.innerHTML = '<div class="hsn-list" role="listbox"></div>';
    document.body.appendChild(p);
    HSN.panel = p;

    document.addEventListener('mousedown', (ev) => {
        if (!HSN.open) return;
        if (HSN.panel.contains(ev.target)) return;
        if (HSN.anchor && HSN.anchor.contains(ev.target)) return;
        hsnClose();
    });
    document.addEventListener('scroll', (ev) => {
        if (HSN.open && !HSN.panel.contains(ev.target)) hsnPlace();
    }, true);
    window.addEventListener('resize', () => { if (HSN.open) hsnPlace(); });
}

function hsnPlace() {
    if (!HSN.anchor || !HSN.panel) return;
    const r = HSN.anchor.getBoundingClientRect();
    const p = HSN.panel;
    const w = Math.max(r.width, 320);
    p.style.width = w + 'px';
    p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    const below = window.innerHeight - r.bottom - 12;
    if (below >= 200 || below >= r.top) {
        p.style.top = (r.bottom + 4) + 'px';
        p.style.bottom = 'auto';
        p.style.maxHeight = Math.max(140, Math.min(340, below)) + 'px';
    } else {
        p.style.bottom = (window.innerHeight - r.top + 4) + 'px';
        p.style.top = 'auto';
        p.style.maxHeight = Math.max(140, Math.min(340, r.top - 12)) + 'px';
    }
}

function hsnMark() {
    if (!HSN.panel) return;
    HSN.panel.querySelectorAll('.hsn-item').forEach((n, i) => {
        n.classList.toggle('active', i === HSN.active);
        if (i === HSN.active && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
    });
}

function hsnPaint() {
    if (!HSN.open || !HSN.panel) return;
    const list = HSN.panel.querySelector('.hsn-list');
    list.innerHTML = '';

    if (HSN.loading) {
        const d = document.createElement('div');
        d.className = 'hsn-msg';
        d.textContent = 'Searching…';
        list.appendChild(d);
        return;
    }
    if (HSN.error) {
        const d = document.createElement('div');
        d.className = 'hsn-msg hsn-err';
        d.textContent = HSN.error;
        list.appendChild(d);
        return;
    }
    if (!HSN.items.length) {
        const d = document.createElement('div');
        d.className = 'hsn-msg';
        d.textContent = HSN.query.length < HSN.minChars
            ? ('Type at least ' + HSN.minChars + ' characters to search')
            : 'No HSN/SAC codes found';
        list.appendChild(d);
        return;
    }
    if (HSN.active >= HSN.items.length) HSN.active = 0;

    HSN.items.forEach((it, i) => {
        const d = document.createElement('div');
        d.className = 'hsn-item' + (i === HSN.active ? ' active' : '');
        d.setAttribute('role', 'option');

        const code = document.createElement('div');
        code.className = 'hsn-code';
        code.textContent = it.hsnCode;

        const desc = document.createElement('div');
        desc.className = 'hsn-desc';
        desc.textContent = it.description || '';

        d.appendChild(code);
        d.appendChild(desc);
        d.addEventListener('mousedown', (ev) => { ev.preventDefault(); hsnPick(i); });
        d.addEventListener('mouseenter', () => { HSN.active = i; hsnMark(); });
        list.appendChild(d);
    });
}

function hsnOpen(anchor, onPick, isService, initialText) {
    hsnBuildPanel();
    HSN.open = true;
    HSN.anchor = anchor;
    HSN.onPick = onPick;
    HSN.isService = !!isService;
    HSN.query = String(initialText || '');
    HSN.items = [];
    HSN.active = 0;
    HSN.error = '';
    HSN.loading = false;
    HSN.token++;
    HSN.panel.hidden = false;
    hsnPlace();
    hsnPaint();
    if (HSN.query.length >= HSN.minChars) hsnTrigger();
}

function hsnClose() {
    if (!HSN.panel) return;
    HSN.open = false;
    HSN.panel.hidden = true;
    clearTimeout(HSN.timer);
}

function hsnTrigger() {
    clearTimeout(HSN.timer);
    const token = ++HSN.token;
    const text = HSN.query;
    const isService = HSN.isService;

    if (text.length < HSN.minChars) {
        HSN.loading = false;
        HSN.error = '';
        HSN.items = [];
        HSN.active = 0;
        hsnPaint();
        return;
    }

    HSN.loading = true;
    HSN.error = '';
    hsnPaint();

    HSN.timer = setTimeout(async () => {
        if (token !== HSN.token) return;
        try {
            const res = await hsnSearch(text, isService, token);
            if (!res || token !== HSN.token) return;
            HSN.items = res.results;
            HSN.active = 0;
            HSN.loading = false;
            hsnPaint();
        } catch (e) {
            if (token !== HSN.token) return;
            HSN.loading = false;
            HSN.error = 'Could not search HSN codes. Please try again.';
            HSN.items = [];
            logError('HSN', 'HSN search failed', e);
            hsnPaint();
        }
    }, 300);
}

function hsnPick(i) {
    const it = HSN.items[i];
    if (!it) return;
    const cb = HSN.onPick;
    hsnClose();
    if (cb) cb(it);
}

function hsnAttach(input, isService, onPick) {
    if (!input || input.dataset.hsnWired === '1') return;
    input.dataset.hsnWired = '1';
    input.setAttribute('autocomplete', 'off');

    input.addEventListener('focus', () => {
        hsnOpen(input, onPick, isService, input.value);
    });
    input.addEventListener('input', () => {
        if (!HSN.open) {
            hsnOpen(input, onPick, isService, input.value);
        } else {
            HSN.query = input.value;
            HSN.active = 0;
            hsnTrigger();
        }
    });
    input.addEventListener('keydown', (ev) => {
        if (!HSN.open && (ev.key === 'ArrowDown' || ev.key === 'Enter')) {
            ev.preventDefault();
            hsnOpen(input, onPick, isService, input.value);
            return;
        }
        if (!HSN.open) return;
        if (ev.key === 'ArrowDown') { ev.preventDefault(); HSN.active = Math.min(HSN.items.length - 1, HSN.active + 1); hsnMark(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); HSN.active = Math.max(0, HSN.active - 1); hsnMark(); }
        else if (ev.key === 'Enter') { ev.preventDefault(); if (HSN.items.length) hsnPick(HSN.active); }
        else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); hsnClose(); }
        else if (ev.key === 'Tab') { hsnClose(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (HSN.open && HSN.anchor === input) hsnClose(); }, 150));
}
// ---------- tax exemptions (GET / POST /settings/taxexemptions) ----------
async function niLoadExempt(force) {
    if (NI.exempt && !force) return NI.exempt;
    try {
        const d = await zbApi('GET', '/settings/taxexemptions');
        NI.exempt = (d.tax_exemptions || []).filter((e) => e.tax_exemption_id)
            .map((e) => ({ id: String(e.tax_exemption_id), code: e.tax_exemption_code || '', desc: e.description || '', type: e.type || 'item' }))
            .filter((e) => e.type === 'item');
    } catch (e) { NI.exempt = []; log('NEW_ITEM', 'Tax exemptions unavailable', e); }
    return NI.exempt;
}
const niExText = (e) => e.code + ' ' + e.desc;

function niExemptEditor(done) {
    const h = niModal('ni-ex', 'New Exemption',
        '<div class="nv-row"><label class="nv-l req">Exemption Reason*</label><div class="nv-c"><input type="text" id="ne_code" class="nv-main" maxlength="100" autocomplete="off"></div></div>' +
        '<div class="nv-row"><label class="nv-l">Description</label><div class="nv-c"><textarea id="ne_desc" rows="2" class="nv-main" maxlength="500"></textarea></div></div>', 460, 23000, 'Save');
    const code = h.q('#ne_code');
    h.save.onclick = async () => {
        if (h.busy) return;
        const c = code.value.trim();
        nvMark(code, '');
        if (!c) { nvMark(code, 'Exemption reason is required'); return; }
        if ((NI.exempt || []).some((e) => e.code.toLowerCase() === c.toLowerCase())) { nvMark(code, 'This exemption already exists'); return; }
        h.busy = true; h.save.disabled = true; h.status.textContent = 'Saving…';
        try {
            const d = await zbApi('POST', '/settings/taxexemptions', {}, { tax_exemption_code: c, description: h.q('#ne_desc').value.trim(), type: 'item' });
            await niLoadExempt(true);
            const rec = d.tax_exemption;
            h.busy = false; h.ov.remove();
            done(rec && rec.tax_exemption_id ? String(rec.tax_exemption_id) : ((NI.exempt.find((e) => e.code.toLowerCase() === c.toLowerCase()) || {}).id || ''));
        } catch (e) { h.busy = false; h.save.disabled = false; h.status.textContent = 'Save failed: ' + (e.message || 'Request failed'); }
    };
    setTimeout(() => code.focus(), 30);
}

// ---------- vendors / custom fields ----------
async function niLoadVendors() {
    try {
        await vendorSrc.init();
        while (vendorSrc.canMore('') && vendorSrc.size() < 500) await vendorSrc.loadMore('');
    } catch (e) { logError('NEW_ITEM', 'Vendors failed', e); }
    return (NI.vendors = vendorSrc.all().map((v) => [v.id, v.name]));
}

/** Zoho has no documented custom-field-definition endpoint for items, so they are read from an existing item record. */
async function niLoadCustomFields() {
    if (NI.cf) return NI.cf;
    NI.cf = [];
    try {
        const d = await zbApi('GET', '/items', { page: 1, per_page: 1 });
        const id = d.items && d.items[0] && d.items[0].item_id;
        if (id) {
            const it = await fetchItemById(String(id));
            NI.cf = ((it && it.custom_fields) || []).map((c) => ({
                id: String(c.customfield_id || ''), label: c.label || c.placeholder || 'Custom field',
                type: c.data_type || 'string', mand: !!c.is_mandatory
            })).filter((c) => c.id);
        }
    } catch (e) { /* no custom fields available */ }
    return NI.cf;
}

// ---------- account select filtered by account type ----------
function niAccSelect(sel, types, selId, selName, defRe) {
    const list = state.accounts.filter((a) => types.indexOf(a.type) > -1);
    nvFill(sel, list.map((a) => [a.id, '\u00A0\u00A0'.repeat(a.depth || 0) + a.name]), '');
    if (selId && !list.some((a) => a.id === String(selId))) sel.appendChild(new Option(selName || 'Account', String(selId)));
    let v = selId ? String(selId) : '';
    if (!v && defRe) { const d = list.find((a) => defRe.test(a.name)); if (d) v = d.id; }
    sel.value = v;
    lkEnhance(sel, { clearable: true, placeholder: 'Select an account', emptyText: 'No accounts found' });
}
// const niTaxList = (spec) => { const t = state.taxes || []; const f = t.filter((x) => x.specificType === spec); return f.length ? f : t; };


const niIsInter = (t) => /igst|inter/i.test((t.specificType || '') + ' ' + t.name);
const niTaxList = (spec) => {
    const all = state.taxes || [];
    const exact = all.filter((t) => t.specificType === spec);
    if (exact.length) return exact;
    if (spec === 'inter') { const i = all.filter(niIsInter); return i.length ? i : all; }
    const groups = all.filter((t) => !niIsInter(t) && t.type === 'tax_group');
    if (groups.length) return groups;
    const gst = all.filter((t) => !niIsInter(t) && /gst/i.test((t.specificType || '') + ' ' + t.name));
    return gst.length ? gst : all.filter((t) => !niIsInter(t));
};



function orgHasGst() {
    const o = state.org || {};
    const cc = String(o.country_code || o.country || '').toLowerCase();
    if (cc === 'in' || /india/.test(cc)) return true;
    if (String(o.currency_code || '').toUpperCase() === 'INR') return true;
    if ((state.taxes || []).some((t) => /gst|igst|cgst|sgst/i.test(t.name) || t.specificType === 'intra' || t.specificType === 'inter')) return true;
    return Object.values(state.itemMaster || {}).some((m) => m && m.hsn_or_sac);
}



NI.opening = false;

/** Same look as the widget's error overlay, but with its own Retry / Close (the shared one is wired to PO creation). */
function niLoadError(msg, onRetry) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.style.zIndex = '40000';
    ov.innerHTML =
        '<div class="overlay-message error"></div>' +
        '<div class="overlay-actions">' +
        '<button type="button" class="btn btn-secondary" data-retry>Retry</button>' +
        '<button type="button" class="btn btn-primary" data-close>Close</button></div>';
    ov.querySelector('.overlay-message').textContent = msg;
    ov.querySelector('[data-close]').addEventListener('click', () => ov.remove());
    ov.querySelector('[data-retry]').addEventListener('click', () => { ov.remove(); onRetry(); });
    document.body.appendChild(ov);
}

async function openItemModal(opt) {
    if (NI.opening) return;                 // blocks duplicate clicks / double initialisation
    NI.opening = true;
    opt = opt || {};
    const btn = opt.button || null;
    if (btn) btn.disabled = true;
    showLoading(opt.item ? 'Preparing Edit Item Form...' : 'Preparing New Item Form...');

    const finish = () => {
        hideLoading();
        NI.opening = false;
        if (btn) btn.disabled = false;
    };

    try {
        await niOpenItemForm(opt);
        finish();
    } catch (err) {
        logError('NEW_ITEM', 'Item form failed to load', err);
        finish();
        if (!opt._shown) {
            niLoadError('Could not load the item form: ' + ((err && err.message) || 'Request failed'),
                () => openItemModal(opt));
        }
    }
}
// ============================================================
// THE FORM   opt = { prefill, item (edit), onSaved(normalizedItem, rawItem) }
// ============================================================
async function niOpenItemForm(opt) {
    opt = opt || {};
    niCss();
    const edit = opt.item || null;
    if (!state.accounts.length && typeof loadAccounts === 'function') await loadAccounts();
    if (!state.accounts.length) await loadAccountsFresh();
    if (!state.accounts.length) throw new Error('Chart of accounts could not be loaded.');
    if (!state.taxes.length && typeof loadTaxes === 'function') await loadTaxes();
    // await Promise.all([niLoadExempt(), niLoadVendors(), niLoadCustomFields(), niListLoad('category')]);

    NI.vendors = vendorSrc.all().map((v) => [v.id, v.name]);
    await Promise.all([niLoadExempt(), niLoadCustomFields(), niListLoad('category')]);

    const gst = orgHasGst();
    log('NEW_ITEM', 'GST detection', { gst, country_code: (state.org || {}).country_code, currency: (state.org || {}).currency_code }); const cur = (state.org || {}).currency_code || '';
    // const catApi = (NI.lists.category || []).some((r) => r.api);
    const catApi = true;
    const cfs = NI.cf;

    const r = (l, f, o) => '<div class="nv-row" ' + (o && o.d ? 'data-ni="' + o.d + '"' : '') + '><label class="nv-l' + (o && o.req ? ' req' : '') + '">' + l + '</label><div class="nv-c">' + f + '</div></div>';
    const sec = (t, d, extra) => '<h4 class="ni-h" ' + (d ? 'data-ni="' + d + '"' : '') + '>' + t + (extra || '') + '</h4>';
    const txt = (id) => '<input type="text" id="' + id + '" class="nv-main" autocomplete="off">';
    const num = (id) => '<input type="text" id="' + id + '" class="nv-sm" inputmode="decimal" autocomplete="off">';
    const money = (id) => '<div class="nv-addon"><span class="nv-addon-t">' + escapeHtml(cur) + '</span><input type="text" id="' + id + '" inputmode="decimal" autocomplete="off"></div>';
    const radio = (n, v, t, chk) => '<label class="nv-radio"><input type="radio" name="' + n + '" value="' + v + '"' + (chk ? ' checked' : '') + '> ' + t + '</label> ';
    const area = (id) => '<textarea id="' + id + '" rows="2" class="nv-main"></textarea>';

    const cfHtml = cfs.map((c) => r(escapeHtml(c.label), c.type === 'check_box'
        ? '<input type="checkbox" id="ni_cf_' + c.id + '">'
        : '<input type="' + (c.type === 'date' ? 'date' : 'text') + '" id="ni_cf_' + c.id + '" class="nv-main" autocomplete="off">', { req: c.mand })).join('');

    const body =
        r('Name*', txt('ni_name'), { req: true }) +
        r('Type', radio('ni_type', 'goods', 'Goods', true) + radio('ni_type', 'service', 'Service')) +
        r('Item Type', '<label class="nv-radio"><input type="radio" name="ni_kind" value="single" checked> Single Item</label> <label class="nv-radio" title="Variants use /itemmasters and /itemvariants, not wired yet"><input type="radio" name="ni_kind" value="variants" disabled> Contains Variants</label>') +
        (catApi ? r('Category', '<select id="ni_cat"></select>') : '') +
        r('Brand', '<select id="ni_brand"></select>') +
        r('Manufacturer', '<select id="ni_mfr"></select>') +
        (gst ? r('<span id="ni_hsn_lbl">HSN Code</span>', '<input type="text" id="ni_hsn" class="nv-main" placeholder="Type to search or add" maxlength="8" autocomplete="off">') : '') +
        r('Tax Preference*', '<select id="ni_pref"></select>', { req: true }) +
        r('Exemption Reason*', '<select id="ni_exr"></select>', { req: true, d: 'exr' }) +
        sec('Item Details') +
        r('Unit<span id="ni_u_req">*</span>', '<select id="ni_unit"></select>', { req: true }) +
        r('SKU<span id="ni_s_req">*</span>', txt('ni_sku'), { req: true }) +
        '<div class="nv-row"><label class="nv-l"></label><div class="nv-c"><button type="button" class="nv-link" id="ni_idlink">+ Add identifier</button></div></div>' +
        '<div id="ni_ids" hidden>' + r('UPC', txt('ni_upc')) + r('MPN', txt('ni_mpn')) + r('EAN', txt('ni_ean')) + r('ISBN', txt('ni_isbn')) + '</div>' +

        sec('Item Description') + r('Description', area('ni_desc')) +

        sec('<label class="nv-radio"><input type="checkbox" id="ni_sales" checked> Sales Information</label>') +
        r('Selling Price*', money('ni_rate'), { req: true, d: 'sales' }) +
        r('MRP', num('ni_mrp'), { d: 'sales' }) +
        r('Account*', '<select id="ni_sacc"></select>', { req: true, d: 'sales' }) +
        r('Description', area('ni_sdesc'), { d: 'sales' }) +

        sec('<label class="nv-radio"><input type="checkbox" id="ni_purch" checked> Purchase Information</label>') +
        r('Cost Price*', money('ni_prate'), { req: true, d: 'purch' }) +
        r('Account*', '<select id="ni_pacc"></select>', { req: true, d: 'purch' }) +
        r('Description', area('ni_pdesc'), { d: 'purch' }) +
        r('Preferred Vendor', '<select id="ni_vendor"></select>', { d: 'purch' }) +

        (gst ? sec('Default Tax Rates', 'tax') +
            r('Intra State Tax Rate', '<select id="ni_intra"></select>', { d: 'tax' }) +
            r('Inter State Tax Rate', '<select id="ni_inter"></select>', { d: 'tax' }) : '') +

        '<div data-ni="goods"><h4 class="ni-h"><label class="nv-radio"><input type="checkbox" id="ni_track"> Track Inventory for this item</label></h4>' +
        '<div class="ni-hint" id="ni_track_hint" hidden>Inventory tracking cannot be enabled or disabled once the item is created.</div></div>' +
        r('Bin Location Tracking', radio('ni_bin', 'yes', 'Yes') + radio('ni_bin', 'no', 'No', true), { d: 'inv' }) +
        r('Inventory Account*', '<select id="ni_iacc"></select>', { req: true, d: 'inv' }) +
        r('Inventory Valuation Method*', '<select id="ni_val"></select>', { req: true, d: 'inv' }) +
        r('Reorder Point', num('ni_reorder'), { d: 'inv' }) +

        sec('Cancellation and Returns', 'goods') +
        r('Returnable Item', radio('ni_ret', 'yes', 'Yes', true) + radio('ni_ret', 'no', 'No'), { d: 'goods' }) +

        sec('Fulfilment Details', 'goods') +
        r('Dimensions (L x W x H)', '<div class="ni-dim"><input type="text" id="ni_len" placeholder="L" inputmode="decimal"><input type="text" id="ni_wid" placeholder="W" inputmode="decimal"><input type="text" id="ni_hei" placeholder="H" inputmode="decimal"><select id="ni_dunit"><option>cm</option><option>in</option><option>ft</option></select></div>', { d: 'goods' }) +
        r('Weight', '<div class="ni-dim"><input type="text" id="ni_wt" inputmode="decimal" style="width:100px"><select id="ni_wunit"><option>kg</option><option>g</option><option>lb</option><option>oz</option></select></div>', { d: 'goods' }) +
        sec('Additional Information') +
        r('Legacy Part No', '<input type="text" class="nv-main" disabled title="No documented Zoho Books API field">') +
        r('Package MOQ', '<input type="text" class="nv-sm" disabled title="No documented Zoho Books API field">') +
        cfHtml;
    hideLoading();
    opt._shown = true;
    const h = niModal('ni-modal', edit ? 'Edit Item' : 'New Item', body, 860, 22000, 'Save');
    const q = h.q, v = (id) => { const e = q('#' + id); return e ? String(e.value).trim() : ''; };
    const isG = () => q('[name=ni_type]:checked').value === 'goods';


    if (gst) {
        const hsnEl = q('#ni_hsn');
        if (hsnEl) {
            const applyService = () => {
                if (hsnEl.dataset.hsnWired === '1') {
                    HSN.isService = !isG();
                }
                const lbl = q('#ni_hsn_lbl');
                if (lbl) lbl.textContent = isG() ? 'HSN Code' : 'SAC Code';
            };
            const svc = () => !isG();
            hsnAttach(hsnEl, svc(), (it) => {
                hsnEl.value = it.hsnCode;
                hsnEl.dispatchEvent(new Event('input', { bubbles: true }));
            });
            // Re-evaluate service flag whenever the item type toggles.
            h.ov.addEventListener('change', (ev) => {
                if (ev.target && ev.target.name === 'ni_type') {
                    HSN.isService = !isG();
                    applyService();
                }
            });
            applyService();
        }
    }
    // ----- fill dropdowns -----
    const pref = q('#ni_pref');
    nvFill(pref, [['taxable', 'Taxable'], ['nontaxable', 'Non-Taxable']].concat(gst ? [['outofscope', 'Out of Scope'], ['nongst', 'Non-GST Supply']] : []), null);
    const exList = () => NI.exempt.filter((e) => !RE_OOS.test(niExText(e)) && !RE_NONGST.test(niExText(e)));
    const exr = q('#ni_exr');
    const fillEx = (sel) => { nvFill(exr, exList().map((e) => [e.id, e.code + (e.desc ? ' - ' + e.desc : '')]), ''); exr.value = sel || ''; if (exr._sync) exr._sync(); };
    fillEx('');
    lkEnhance(pref, {});
    lkEnhance(exr, { clearable: true, placeholder: 'Select or Add Reason', footer: [{ icon: '+', label: 'New Exemption', onClick: () => niExemptEditor((id) => fillEx(id)) }] });

    await Promise.all([niBindList('brand', q('#ni_brand'), edit && edit.brand), niBindList('manufacturer', q('#ni_mfr'), edit && edit.manufacturer), niBindList('unit', q('#ni_unit'), edit && edit.unit)]);
    if (catApi) await niBindList('category', q('#ni_cat'), edit && edit.category_id ? String(edit.category_id) : '');
    if (edit && edit.category_id) {
        const cs = q('#ni_cat'), cid = String(edit.category_id);
        if (!Array.from(cs.options).some((o) => o.value === cid)) cs.appendChild(new Option(edit.category_name || 'Category', cid));
        cs.value = cid;
        if (cs._sync) cs._sync();
    }

    niAccSelect(q('#ni_sacc'), NI_ACC.sales, edit && edit.account_id, edit && edit.account_name, /^sales$/i);
    niAccSelect(q('#ni_pacc'), NI_ACC.purchase, edit && edit.purchase_account_id, edit && edit.purchase_account_name, /cost of goods sold/i);
    niAccSelect(q('#ni_iacc'), NI_ACC.inventory, edit && edit.inventory_account_id, edit && edit.inventory_account_name, /inventory asset/i);

    const vs = q('#ni_vendor');
    nvFill(vs, NI.vendors, '');
    if (edit && edit.vendor_id && !NI.vendors.some((x) => x[0] === String(edit.vendor_id))) vs.appendChild(new Option(edit.vendor_name || 'Vendor', String(edit.vendor_id)));
    vs.value = edit && edit.vendor_id ? String(edit.vendor_id) : '';
    lkEnhance(vs, { clearable: true, placeholder: 'Select a vendor', emptyText: 'No vendors found' });

    niLoadVendors().then((list) => {
        const cur = vs.value;
        nvFill(vs, list, '');
        if (edit && edit.vendor_id && !list.some((x) => x[0] === String(edit.vendor_id))) vs.appendChild(new Option(edit.vendor_name || 'Vendor', String(edit.vendor_id)));
        vs.value = cur;
        if (vs._sync) vs._sync();
    });

    nvFill(q('#ni_val'), [['fifo', 'FIFO (First In, First Out)'], ['wac', 'Weighted Average']], null);
    lkEnhance(q('#ni_val'), {});
    if (gst) {
        const mk = (id, spec) => { const s = q('#' + id); nvFill(s, niTaxList(spec).map((t) => [t.id, t.name + ' (' + t.pct + ' %)']), ''); lkEnhance(s, { clearable: true, placeholder: 'Select a tax' }); };
        mk('ni_intra', 'intra'); mk('ni_inter', 'inter');
    }

    // ----- visibility rules -----
    function sync() {
        const g = isG(), p = v('ni_pref'), trk = g && q('#ni_track').checked;
        if (trk) { ['ni_sales', 'ni_purch'].forEach((id) => { q('#' + id).checked = true; q('#' + id).disabled = true; }); }
        else['ni_sales', 'ni_purch'].forEach((id) => { q('#' + id).disabled = false; });
        const on = { goods: g, exr: p === 'nontaxable', tax: gst && p === 'taxable', sales: q('#ni_sales').checked, purch: q('#ni_purch').checked, inv: trk };
        h.ov.querySelectorAll('[data-ni]').forEach((el) => {
            el.hidden = !el.getAttribute('data-ni').split(' ').every((t) => on[t]);
        });
        q('#ni_u_req').style.display = q('#ni_s_req').style.display = g ? '' : 'none';
        const lbl = q('#ni_hsn_lbl');
        if (lbl) lbl.textContent = g ? 'HSN Code' : 'SAC Code';
    }
    h.ov.addEventListener('change', sync);
    q('#ni_idlink').onclick = () => { const b = q('#ni_ids'); b.hidden = !b.hidden; q('#ni_idlink').textContent = b.hidden ? '+ Add identifier' : '- Hide identifiers'; };

    // ----- populate (edit) -----
    if (edit) {
        const set = (id, val) => { const e = q('#' + id); if (e && val !== undefined && val !== null) e.value = val; };
        set('ni_name', edit.name);
        q('[name=ni_type][value=' + (edit.product_type === 'service' ? 'service' : 'goods') + ']').checked = true;
        set('ni_hsn', edit.hsn_or_sac); set('ni_sku', edit.sku); set('ni_upc', edit.upc); set('ni_mpn', edit.part_number);
        set('ni_ean', edit.ean); set('ni_isbn', edit.isbn); set('ni_sdesc', edit.description); set('ni_desc', '');
        set('ni_rate', edit.rate); set('ni_mrp', edit.mrp); set('ni_prate', edit.purchase_rate); set('ni_pdesc', edit.purchase_description);
        const it = String(edit.item_type || '');
        q('#ni_sales').checked = it !== 'purchases'; q('#ni_purch').checked = it !== 'sales';
        q('#ni_track').checked = it === 'inventory' || edit.track_inventory === true;
        q('#ni_track').disabled = true; q('#ni_track_hint').hidden = false;      // cannot change after creation
        set('ni_val', edit.inventory_valuation_method); if (q('#ni_val')._sync) q('#ni_val')._sync();
        set('ni_reorder', edit.reorder_level);
        q('[name=ni_ret][value=' + (edit.is_returnable === false ? 'no' : 'yes') + ']').checked = true;
        const pk = edit.package_details || {};
        set('ni_len', pk.length); set('ni_wid', pk.width); set('ni_hei', pk.height); set('ni_wt', pk.weight);
        if (pk.dimension_unit) set('ni_dunit', pk.dimension_unit); if (pk.weight_unit) set('ni_wunit', pk.weight_unit);
        let p = 'taxable';
        if (edit.is_taxable === false) {
            const ex = NI.exempt.find((e) => e.id === String(edit.tax_exemption_id));
            const t = ex ? niExText(ex) : '';
            p = RE_OOS.test(t) ? 'outofscope' : (RE_NONGST.test(t) ? 'nongst' : 'nontaxable');
            if (p === 'nontaxable') fillEx(String(edit.tax_exemption_id || ''));
        }
        pref.value = p; if (pref._sync) pref._sync();
        (edit.item_tax_preferences || []).forEach((tp) => {
            const s = q(tp.tax_specification === 'inter' ? '#ni_inter' : '#ni_intra');
            // if (s) { s.value = String(tp.tax_id); if (s._sync) s._sync(); }
            if (s) {
                const id = String(tp.tax_id);
                if (!Array.from(s.options).some((o) => o.value === id)) s.appendChild(new Option(tp.tax_name || 'Tax', id));
                s.value = id;
                if (s._sync) s._sync();
            }
        });
        (edit.custom_fields || []).forEach((c) => { const e = q('#ni_cf_' + c.customfield_id); if (e) { if (e.type === 'checkbox') e.checked = c.value === true || c.value === 'true'; else e.value = c.value || ''; } });
        ['ni_sacc', 'ni_pacc', 'ni_iacc'].forEach((id) => q('#' + id)._sync && q('#' + id)._sync());
    } else {
        q('#ni_name').value = opt.prefill || '';
    }
    sync();

    // ----- validation -----
    function validate() {
        h.ov.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
        h.ov.querySelectorAll('.nv-fe').forEach((e) => e.remove());
        const errs = [], bad = (id, m) => { nvMark(q('#' + id), m); errs.push(m); };
        const g = isG(), p = v('ni_pref'), sOn = q('#ni_sales').checked, pOn = q('#ni_purch').checked, trk = g && q('#ni_track').checked;
        const money2 = /^\d{1,12}(\.\d{1,2})?$/, dec = /^\d+(\.\d{1,2})?$/;

        if (!v('ni_name')) bad('ni_name', 'Name is required'); else if (v('ni_name').length > 255) bad('ni_name', 'Name is too long (max 255)');
        if (g && !v('ni_unit')) bad('ni_unit', 'Unit is required for goods');
        if (g && !v('ni_sku')) bad('ni_sku', 'SKU is required for goods');
        if (gst && v('ni_hsn') && !(g ? /^(\d{4}|\d{6}|\d{8})$/ : /^\d{6}$/).test(v('ni_hsn'))) bad('ni_hsn', g ? 'HSN must be 4, 6 or 8 digits' : 'SAC must be 6 digits');
        if (p === 'nontaxable' && !v('ni_exr')) bad('ni_exr', 'Select an exemption reason');
        if (p === 'outofscope' && !NI.exempt.some((e) => RE_OOS.test(niExText(e)))) bad('ni_pref', 'No "Out of Scope" exemption exists in Zoho Books');
        if (p === 'nongst' && !NI.exempt.some((e) => RE_NONGST.test(niExText(e)))) bad('ni_pref', 'No "Non-GST Supply" exemption exists in Zoho Books');
        if (!sOn && !pOn) bad('ni_sales', 'Enable Sales or Purchase information');
        if (sOn) {
            if (!v('ni_rate')) bad('ni_rate', 'Selling price is required'); else if (!money2.test(v('ni_rate'))) bad('ni_rate', 'Enter a valid amount (max 2 decimals)');
            if (v('ni_mrp') && !money2.test(v('ni_mrp'))) bad('ni_mrp', 'Enter a valid amount (max 2 decimals)');
            if (!v('ni_sacc')) bad('ni_sacc', 'Select a sales account');
        }
        if (pOn) {
            if (!v('ni_prate')) bad('ni_prate', 'Cost price is required'); else if (!money2.test(v('ni_prate'))) bad('ni_prate', 'Enter a valid amount (max 2 decimals)');
            if (!v('ni_pacc')) bad('ni_pacc', 'Select a purchase account');
        }
        if (trk) {
            if (!v('ni_iacc')) bad('ni_iacc', 'Select an inventory account');
            if (!v('ni_val')) bad('ni_val', 'Select a valuation method');
            if (v('ni_reorder') && !dec.test(v('ni_reorder'))) bad('ni_reorder', 'Enter a valid reorder point');
        }
        if (g) {
            const dims = ['ni_len', 'ni_wid', 'ni_hei'], filled = dims.filter((id) => v(id));
            if (filled.length && filled.length < 3) bad(dims.find((id) => !v(id)), 'Enter length, width and height');
            dims.concat('ni_wt').forEach((id) => { if (v(id) && !dec.test(v(id))) bad(id, 'Enter a valid number'); });
        }
        cfs.forEach((c) => { const e = q('#ni_cf_' + c.id); if (c.mand && e && e.type !== 'checkbox' && !e.value.trim()) bad('ni_cf_' + c.id, c.label + ' is required'); });
        return errs.length ? errs.length + ' field(s) need attention: ' + errs[0] : '';
    }

    // ----- payload -----
    function payload() {
        const g = isG(), p = v('ni_pref'), sOn = q('#ni_sales').checked, pOn = q('#ni_purch').checked, trk = g && q('#ni_track').checked;
        const b = {
            name: v('ni_name'), product_type: g ? 'goods' : 'service',
            item_type: trk ? 'inventory' : (sOn && pOn ? 'sales_and_purchases' : (sOn ? 'sales' : 'purchases')),
            rate: parseFloat((sOn ? v('ni_rate') : v('ni_prate')) || '0'),
            is_taxable: p === 'taxable'
        };
        const put = (k, val) => { if (val !== '' && val !== undefined) b[k] = val; };
        put('brand', v('ni_brand')); put('manufacturer', v('ni_mfr'));
        if (catApi) put('category_id', v('ni_cat'));
        if (gst) put('hsn_or_sac', v('ni_hsn'));
        put('unit', v('ni_unit')); put('sku', v('ni_sku'));
        put('upc', v('ni_upc')); put('part_number', v('ni_mpn')); put('ean', v('ni_ean')); put('isbn', v('ni_isbn'));
        put('description', (sOn && v('ni_sdesc')) || v('ni_desc'));
        if (p === 'nontaxable') b.tax_exemption_id = v('ni_exr');
        if (p === 'outofscope') b.tax_exemption_id = NI.exempt.find((e) => RE_OOS.test(niExText(e))).id;
        if (p === 'nongst') b.tax_exemption_id = NI.exempt.find((e) => RE_NONGST.test(niExText(e))).id;
        if (gst && p === 'taxable') {
            const prefs = [];
            if (v('ni_intra')) prefs.push({ tax_id: v('ni_intra'), tax_specification: 'intra' });
            if (v('ni_inter')) prefs.push({ tax_id: v('ni_inter'), tax_specification: 'inter' });
            if (prefs.length) b.item_tax_preferences = prefs;
        }
        if (sOn) { put('mrp', v('ni_mrp')); put('account_id', v('ni_sacc')); }
        if (pOn) { put('purchase_rate', v('ni_prate') ? parseFloat(v('ni_prate')) : ''); put('purchase_account_id', v('ni_pacc')); put('purchase_description', v('ni_pdesc')); put('vendor_id', v('ni_vendor')); }
        if (trk) {
            put('inventory_account_id', v('ni_iacc')); put('inventory_valuation_method', v('ni_val'));
            if (v('ni_reorder')) b.reorder_level = parseFloat(v('ni_reorder'));
            if (q('[name=ni_bin]:checked').value === 'yes') b.track_bin_location = true;
        }
        if (g) {
            b.is_returnable = q('[name=ni_ret]:checked').value === 'yes';
            if (v('ni_len') || v('ni_wt')) {
                const pk = {};
                if (v('ni_len')) { pk.length = parseFloat(v('ni_len')); pk.width = parseFloat(v('ni_wid')); pk.height = parseFloat(v('ni_hei')); pk.dimension_unit = v('ni_dunit'); }
                if (v('ni_wt')) { pk.weight = parseFloat(v('ni_wt')); pk.weight_unit = v('ni_wunit'); }
                b.package_details = pk;
            }
        }
        const cf = [];
        cfs.forEach((c) => { const e = q('#ni_cf_' + c.id); if (!e) return; const val = e.type === 'checkbox' ? e.checked : e.value.trim(); if (val !== '' && (val !== false || edit)) cf.push({ customfield_id: c.id, value: val }); });
        if (cf.length) b.custom_fields = cf;
        return b;
    }

    // ----- save: POST (new) / PUT (edit), never creates a duplicate -----
    h.save.onclick = async () => {
        if (h.busy) return;
        const err = validate();
        h.status.textContent = err;
        if (err) { const f = h.ov.querySelector('.invalid'); if (f && f.scrollIntoView) f.scrollIntoView({ block: 'center' }); return; }

        h.busy = true; h.save.disabled = true;
        const body = payload();
        const same = (i) => i.name.trim().toLowerCase() === body.name.toLowerCase();
        log('NEW_ITEM', edit ? 'PUT payload' : 'POST payload', body);
        try {
            if (!edit) {
                h.status.textContent = 'Checking for an existing item…';
                let found = state.itemList.find(same);
                if (!found) { try { found = (await fetchItemList(body.name)).find(same); } catch (e) { /* continue */ } }
                if (found) { itemMerge([found]); h.busy = false; h.ov.remove(); if (opt.onSaved) opt.onSaved(found, state.itemMaster[found.id] || null); return; }
            }
            if (isG() && body.sku) {
                h.status.textContent = 'Checking SKU…';
                const clash = await niSkuTaken(body.sku, edit ? edit.item_id : '');
                if (clash) {
                    nvMark(q('#ni_sku'), 'SKU already used by "' + clash.name + '"');
                    h.busy = false; h.save.disabled = false; h.status.textContent = 'SKU already exists';
                    return;
                }
            }
            h.status.textContent = edit ? 'Updating item…' : 'Creating item…'; let rec;
            try {
                const d = edit ? await zbApi('PUT', '/items/' + edit.item_id, {}, body) : await zbApi('POST', '/items', {}, body);
                rec = d.item;
                if (!rec || !rec.item_id) throw new Error('Zoho Books did not return the item.');
            } catch (e) {
                if (edit) throw e;
                // uncertain response: re-read before reporting failure, so a request that landed is not repeated
                let landed = null;
                try { landed = (await fetchItemList(body.name)).find(same); } catch (x) { /* ignore */ }
                if (!landed) throw e;
                rec = (await fetchItemById(landed.id)) || { item_id: landed.id, name: landed.name };
            }

            rec = await niEnsureComplete(rec, body);
            niEchoCheck(body, rec);
            state.itemMaster[String(rec.item_id)] = rec;
            zcPut('itemdetail', [{ id: String(rec.item_id), at: Date.now(), item: rec }], (r) => r.id);
            const it = normItem(rec);
            itemMerge([it]);
            h.busy = false; h.ov.remove();
            if (opt.onSaved) opt.onSaved(it, rec);
        } catch (e) {
            logError('NEW_ITEM', 'Save failed', e);
            h.busy = false; h.save.disabled = false;
            h.status.textContent = 'Save failed: ' + (e.message || 'Request failed');
        }
    };
    setTimeout(() => q('#ni_name').focus(), 30);
}

/** Same signature as before: the item picker's "+ Add New Item" and the row's auto-select keep working. */
function openNewItemModal(prefill, onCreated, btn) { return openItemModal({ prefill, onSaved: onCreated, button: btn }); }

/** Row ⋯ menu: Edit Item / View Item Details. onSaved(item, raw) should refresh the row. */
const IDP_ICON = {
    edit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    view: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/></svg>',
    ext: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>',
    img: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#b5bcc8" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    ship: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="14" height="11" rx="1"/><path d="M15 10h4l3 3v4h-7"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
    recv: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8"/><path d="m13 9 3 3-3 3"/></svg>'
};

/** Three-dot menu for an item row: Edit Item / View Item Details. */
function niRowMenu(anchor, itemId, tr) {
    const old = $('ni-rowmenu');
    if (old) {
        const same = old._anchor === anchor;
        old._close();
        if (same) return;
    }
    if (!itemId) return;

    const m = document.createElement('div');
    const w = 210;
    m.id = 'ni-rowmenu';
    m.className = 'ni-menu';
    m._anchor = anchor;
    m.style.width = w + 'px';
    const rc = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(rc.right - w, window.innerWidth - w - 8)) + 'px';
    if (window.innerHeight - rc.bottom >= 120) m.style.top = (rc.bottom + 6) + 'px';
    else m.style.bottom = (window.innerHeight - rc.top + 6) + 'px';

    const off = (e) => { if (!m.contains(e.target) && !anchor.contains(e.target)) m._close(); };
    const key = (e) => { if (e.key === 'Escape') m._close(); };
    m._close = () => {
        m.remove();
        document.removeEventListener('mousedown', off, true);
        document.removeEventListener('scroll', m._close, true);
        document.removeEventListener('keydown', key, true);
    };

    const add = (icon, text, fn, on) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = on ? 'on' : '';
        b.innerHTML = icon + '<span>' + text + '</span>';
        b.addEventListener('mouseenter', () => m.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)));
        b.addEventListener('click', () => { m._close(); fn(); });
        m.appendChild(b);
    };
    add(IDP_ICON.edit, 'Edit Item', () => niEditItem(itemId, tr), true);
    add(IDP_ICON.view, 'View Item Details', () => idpOpen(itemId, tr));

    document.body.appendChild(m);
    document.addEventListener('mousedown', off, true);
    document.addEventListener('scroll', m._close, true);
    document.addEventListener('keydown', key, true);
}

/** Loads the latest item (GET /items/{id}), opens the existing Edit Item form, then refreshes the row. */
async function niEditItem(itemId, tr) {
    showLoading('Loading item details...');
    try {
        const it = await fetchItemById(itemId, true);
        if (!it) throw new Error('Item not found.');
        openItemModal({ item: it, onSaved: (n, raw) => niRowRefresh(tr, raw || it) });
    } catch (e) {
        hideLoading();
        logError('NEW_ITEM', 'Could not load item for edit', e);
        niLoadError('Could not load the item: ' + (e.message || 'Request failed'), () => niEditItem(itemId, tr));
    }
}

/** After an item edit: updates item-owned info only. Qty, rate, discount, tax and description the user typed stay as they are. */
function niRowRefresh(tr, raw) {
    if (!tr || !tr.isConnected || !raw) return;
    const id = tr.dataset.lineItemId;
    const x = state.extra[id], a = state.lineItems[id];
    const so = (state.salesOrder.lineItems || []).find((li) => li.lineItemId === id);
    const name = raw.name || '', sku = raw.sku || '', unit = raw.unit || '', hsn = raw.hsn_or_sac || '';
    const svc = String(raw.product_type || '').toLowerCase() === 'service';

    if (x) { x.name = name; x.sku = sku; x.unit = unit; }
    if (a) a.name = name;
    if (so) { so.name = name; so.sku = sku; so.hsn = hsn; so.unit = unit || so.unit; }

    const nm = tr.querySelector('.zb-item-name'); if (nm) nm.textContent = name;
    const pick = tr.querySelector('.item-pick'); if (pick) pick.textContent = name;

    let skuEl = tr.querySelector('.zb-sku-text');
    if (!skuEl && (sku || unit)) {
        skuEl = document.createElement('div');
        skuEl.className = 'zb-sku-text';
        const box = tr.querySelector('.zb-desc-box');
        if (box) box.before(skuEl);
    }
    if (skuEl) skuEl.textContent = [sku ? 'SKU: ' + sku : '', unit ? 'Unit: ' + unit : ''].filter(Boolean).join(' · ');

    const pill = tr.querySelector('.zb-pill-goods, .zb-pill-service');
    if (pill) {
        pill.className = svc ? 'zb-pill-service' : 'zb-pill-goods';
        pill.textContent = svc ? 'SERVICE' : 'GOODS';
    }
    const hsnObj = x || so;
    if (hsnObj) { hsnObj.hsn = hsn; hsnRowTag(tr, hsnObj, raw); }

    const rate = tr.querySelector('.rate-input');
    if (rate && raw.purchase_rate != null) {
        rate.dataset.defaultRate = String(raw.purchase_rate);
        rate.dispatchEvent(new Event('input', { bubbles: true }));   // refreshes the "modified" marker and totals; the value is unchanged
    }
    refreshStockInfo();
    markDirty();
}


// ============================================================
// HSN / SAC TAG + EDIT POPOVER (Item Details column)
//   Suggestions : existing hsnOpen / hsnSearch  (GET /meta/hsncodes)
//   Saved value : stored on the row object (soItem.hsn / extra.hsn) and sent as hsn_or_sac on that PO line.
//                 The item master record is not changed.
// ============================================================

const HP = { el: null, tr: null, obj: null, svc: false, anchor: null };

const HP_PENCIL = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

/** (Re)builds the "HSN Code: xxxx ✎" tag after the GOODS / SERVICE pill. obj = SO line or extra row object. */
function hsnRowTag(tr, obj, master) {
    if (!tr || !obj) return;
    const old = tr.querySelector('.zb-hsn-tag');
    if (old) old.remove();

    if (obj.hsn === undefined || obj.hsn === null) obj.hsn = (master && master.hsn_or_sac) || '';
    const hsn = String(obj.hsn || '');
    const pill = tr.querySelector('.zb-pill-goods, .zb-pill-service');
    if (!pill) return;
    if (tr.dataset.extra === '1' && !obj.itemId) return;          // manual row with no item yet
    if (!hsn && !orgHasGst()) return;

    const svc = pill.classList.contains('zb-pill-service');
    const t = document.createElement('span');
    t.className = 'zb-hsn-tag';
    t.appendChild(document.createTextNode((svc ? 'SAC Code:' : 'HSN Code:') + ' '));
    const code = document.createElement('span');
    code.className = 'zb-hsn-code';
    code.textContent = hsn || '—';
    t.appendChild(code);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'zb-edit-icon';
    b.title = 'Edit ' + (svc ? 'SAC' : 'HSN') + ' code';
    b.innerHTML = HP_PENCIL;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); hpOpen(b, tr, obj, svc); });
    t.appendChild(b);
    pill.after(t);
}

function hpClose() {
    if (!HP.el || HP.el.hidden) return;
    HP.el.hidden = true;
    if (typeof hsnClose === 'function') hsnClose();
}

function hpPlace() {
    if (!HP.anchor || !HP.el || HP.el.hidden) return;
    const r = HP.anchor.getBoundingClientRect(), p = HP.el;
    p.style.left = Math.max(8, Math.min(r.left - 8, window.innerWidth - p.offsetWidth - 8)) + 'px';
    const h = p.offsetHeight || 190;
    if (window.innerHeight - r.bottom - 12 >= h || r.top < h) {
        p.style.top = (r.bottom + 8) + 'px'; p.style.bottom = 'auto';
    } else {
        p.style.bottom = (window.innerHeight - r.top + 8) + 'px'; p.style.top = 'auto';
    }
}

function hpBuild() {
    if (HP.el) return;
    const p = document.createElement('div');
    p.className = 'hsn-pop';
    p.hidden = true;
    p.innerHTML =
        '<h5 class="hp-title">HSN Code</h5>' +
        '<div class="hsn-pop-wrap"><div class="hsn-pop-field"><input type="text" class="hp-input" maxlength="8" autocomplete="off" inputmode="numeric"><span class="sh-chev"></span></div>' +
        '<button type="button" class="hsn-pop-go" title="Search" aria-label="Search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg></button></div>' +
        '<div class="hsn-pop-err" hidden></div>' +
        '<div class="hsn-pop-foot"><button type="button" class="btn btn-primary hp-save">Save</button><button type="button" class="btn btn-secondary hp-close">Close</button></div>';
    document.body.appendChild(p);
    HP.el = p;

    const inp = p.querySelector('.hp-input');
    p.querySelector('.hp-close').addEventListener('click', hpClose);
    p.querySelector('.hp-save').addEventListener('click', hpSave);
    p.querySelector('.hsn-pop-go').addEventListener('click', () => { inp.focus(); hsnOpen(inp, hpPicked, HP.svc, inp.value); });
    inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, ''); p.querySelector('.hsn-pop-err').hidden = true; });
    p.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.stopPropagation(); hpClose(); }
        else if (ev.key === 'Enter' && ev.target === inp && !HSN.open) { ev.preventDefault(); hpSave(); }
    });

    document.addEventListener('mousedown', (ev) => {
        if (p.hidden) return;
        if (p.contains(ev.target)) return;
        if (HSN.panel && HSN.panel.contains(ev.target)) return;
        if (HP.anchor && HP.anchor.contains(ev.target)) return;
        hpClose();
    });
    document.addEventListener('scroll', (ev) => {
        if (p.hidden || p.contains(ev.target) || (HSN.panel && HSN.panel.contains(ev.target))) return;
        hpPlace();
    }, true);
    window.addEventListener('resize', hpPlace);
}

function hpPicked(it) {
    const inp = HP.el.querySelector('.hp-input');
    inp.value = it.hsnCode;
    HP.el.querySelector('.hsn-pop-err').hidden = true;
}

function hpOpen(anchor, tr, obj, svc) {
    hpBuild();
    if (!HP.el.hidden && HP.anchor === anchor) { hpClose(); return; }
    Object.assign(HP, { anchor, tr, obj, svc });

    const p = HP.el, inp = p.querySelector('.hp-input');
    p.querySelector('.hp-title').textContent = svc ? 'SAC Code' : 'HSN Code';
    inp.value = String(obj.hsn || '');
    p.querySelector('.hsn-pop-err').hidden = true;
    p.hidden = false;
    hpPlace();

    // HSN.query is the current code, so the current value shows first; typing 3+ digits searches for more
    hsnAttach(inp, svc, hpPicked);                       // wired once per input
    HSN.isService = svc;
    setTimeout(() => { inp.focus(); inp.select(); hsnOpen(inp, hpPicked, svc, inp.value); }, 0);
}

function hpSave() {
    const p = HP.el, inp = p.querySelector('.hp-input'), err = p.querySelector('.hsn-pop-err');
    const v = inp.value.trim();
    const ok = v === '' || (HP.svc ? /^\d{6}$/ : /^(\d{4}|\d{6}|\d{8})$/).test(v);
    if (!ok) {
        err.textContent = HP.svc ? 'SAC must be 6 digits' : 'HSN must be 4, 6 or 8 digits';
        err.hidden = false;
        return;
    }
    const changed = String(HP.obj.hsn || '') !== v;
    HP.obj.hsn = v;
    const tr = HP.tr, obj = HP.obj;
    const master = obj.itemId ? state.itemMaster[obj.itemId] : null;
    hpClose();
    hsnRowTag(tr, obj, master);
    if (changed) markDirty();
}




// ============================================================
// ITEM DETAILS SIDE PANEL (Item Details / Stock Locations / Transactions)
// ============================================================
const IDP_TX = {
    salesorders: { label: 'Sales Orders', list: 'salesorders', key: 'salesorders', id: 'salesorder_id', num: 'salesorder_number', det: 'salesorder' },
    invoices: { label: 'Invoices', list: 'invoices', key: 'invoices', id: 'invoice_id', num: 'invoice_number', det: 'invoice' }
};
const IDP_STATUS = [['all', 'All'], ['draft', 'Draft'], ['open', 'Open'], ['closed', 'Closed'], ['void', 'Void'], ['sent', 'Sent'], ['paid', 'Paid'], ['overdue', 'Overdue']];
const IDP = { el: null, id: '', tr: null, m: null, tab: 'details', stock: 'acc', other: false, error: '', note: '', token: 0, cache: {}, tx: null };

const idpNum = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const idpQty = (v) => (idpNum(v) === null ? '\u2014' : idpNum(v).toFixed(2));
const idpMoney = (v) => (idpNum(v) === null ? '' : curSym() + idpNum(v).toFixed(2));
function idpTxInit() { return { type: 'salesorders', status: 'all', rows: [], page: 1, more: false, loading: false, error: '', token: 0, started: false }; }

function idpUrl() {
    return 'https://books.zoho' + (state.organizationDataCenterExtension || '.com') + '/app/' + encodeURIComponent(state.organizationId) +
        '#/inventory/items/' + encodeURIComponent(IDP.id);
}

function idpBuild() {
    if (IDP.el) return;
    const ov = document.createElement('div');
    ov.className = 'idp-overlay';
    ov.hidden = true;
    ov.innerHTML =
        '<aside class="idp" role="dialog" aria-label="Item Details">' +
        '<div class="idp-head"><span>Item Details</span><button type="button" class="idp-x" aria-label="Close">&times;</button></div>' +
        '<div class="idp-hero"></div>' +
        '<div class="idp-tabs"><button type="button" data-t="details">ITEM DETAILS</button><button type="button" data-t="stock">STOCK LOCATIONS</button><button type="button" data-t="tx">TRANSACTIONS</button></div>' +
        '<div class="idp-body"></div></aside>';
    document.body.appendChild(ov);
    IDP.el = ov;

    ov.addEventListener('mousedown', (e) => { if (e.target === ov) idpClose(); });
    ov.querySelector('.idp-x').addEventListener('click', idpClose);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ov.hidden) idpClose(); });

    ov.querySelectorAll('.idp-tabs button').forEach((b) => b.addEventListener('click', () => {
        IDP.tab = b.dataset.t;
        if (IDP.tab === 'tx' && !IDP.tx.started) { IDP.tx.started = true; idpTxLoad(true); }
        idpPaint();
    }));

    const body = ov.querySelector('.idp-body');
    body.addEventListener('click', (e) => {
        const t = e.target.closest('[data-act]');
        if (!t) return;
        const a = t.dataset.act;
        if (a === 'other') IDP.other = !IDP.other;
        else if (a === 'stk-acc') IDP.stock = 'acc';
        else if (a === 'stk-phy') IDP.stock = 'phy';
        else if (a === 'tx-more' || a === 'tx-retry') { idpTxLoad(false); return; }
        else if (a === 'reload') { idpOpen(IDP.id, IDP.tr); return; }
        else if (a === 'tx-rate') { idpApplyRate(t.dataset.rate); return; }
        idpPaint();
    });
    body.addEventListener('change', (e) => {
        const s = e.target.dataset.sel;
        if (s === 'txtype') { IDP.tx.type = e.target.value; IDP.tx.started = true; idpTxLoad(true); }
        else if (s === 'txstatus') { IDP.tx.status = e.target.value; idpPaint(); }
    });
}

function idpClose() {
    if (!IDP.el) return;
    IDP.el.hidden = true;
    IDP.token++;
}

async function idpOpen(itemId, tr) {
    idpBuild();
    const my = ++IDP.token;
    Object.assign(IDP, { id: String(itemId), tr, m: null, tab: 'details', stock: 'acc', other: false, error: '', note: '', tx: idpTxInit() });
    IDP.el.hidden = false;
    idpPaint('Loading item details...');
    try {
        const m = await fetchItemById(IDP.id, true);
        if (my !== IDP.token) return;
        if (!m) throw new Error('Item not found.');
        IDP.m = m;
        log('ITEM_PANEL', 'Item record (use this to confirm stock field names)', m);
    } catch (e) {
        if (my !== IDP.token) return;
        IDP.error = 'Could not load item details: ' + (e.message || 'Request failed');
        logError('ITEM_PANEL', 'Item load failed', e);
    }
    idpPaint();
}

/** Accounting / physical figures for the item (prefix '') or one of its locations (prefix 'location_'). */
function idpFigures(o, p, phys) {
    const soh = idpNum(pickNum(o, phys ? [p + 'actual_stock_on_hand', p + 'stock_on_hand'] : [p + 'stock_on_hand']));
    const av = idpNum(pickNum(o, phys ? [p + 'actual_available_for_sale_stock', p + 'actual_available_stock'] : [p + 'available_for_sale_stock', p + 'available_stock']));
    let cm = idpNum(pickNum(o, [p + (phys ? 'actual_committed_stock' : 'committed_stock')]));
    if (cm === null && soh !== null && av !== null) cm = soh - av;
    return { soh, cm, av };
}

function idpRow(l, v) {
    return (v === undefined || v === null || String(v).trim() === '')
        ? '' : '<div class="idp-r"><span>' + escapeHtml(l) + '</span><b>' + escapeHtml(String(v)) + '</b></div>';
}

function idpDetailsHtml(m) {
    let h = '';
    if (m.track_inventory) {
        const sh = pickNum(m, ['quantity_to_be_shipped', 'to_be_shipped']);
        const rc = pickNum(m, ['quantity_to_be_received', 'to_be_received']);
        h += '<div class="idp-sec"><div class="idp-sum">' +
            '<div><span class="idp-ico">' + IDP_ICON.ship + '</span><span>To Be Shipped<b>' + idpQty(sh === undefined ? 0 : sh) + '</b></span></div>' +
            '<div><span class="idp-ico">' + IDP_ICON.recv + '</span><span>To Be Received<b>' + idpQty(rc === undefined ? 0 : rc) + '</b></span></div></div>';
        const fig = (title, f) => '<div class="idp-sub-h">' + title + '</div>' +
            '<div class="idp-r"><span>Stock on Hand</span><b>' + idpQty(f.soh) + '</b></div>' +
            '<div class="idp-r"><span>Committed Stock</span><b>' + idpQty(f.cm) + '</b></div>' +
            '<div class="idp-r"><span>Available for Sale</span><b>' + idpQty(f.av) + '</b></div>';
        h += '<h4>Stock Details</h4>' + fig('Accounting Stock', idpFigures(m, '', false)) + fig('Physical Stock', idpFigures(m, '', true)) + '</div>';
    }

    h += '<div class="idp-sec"><h4>Sales Information</h4>' +
        idpRow('Price', idpMoney(m.rate)) + idpRow('Account', m.account_name) + idpRow('MRP', idpMoney(m.mrp)) + '</div>';
    h += '<div class="idp-sec"><h4>Purchase Information</h4>' +
        idpRow('Price', idpMoney(m.purchase_rate)) + idpRow('Account', m.purchase_account_name) + '</div>';

    const svc = String(m.product_type || '').toLowerCase() === 'service';
    let other = idpRow('Inventory Account', m.inventory_account_name) + idpRow('Category', m.category_name) +
        idpRow('Brand', m.brand) + idpRow('Manufacturer', m.manufacturer) + idpRow(svc ? 'SAC' : 'HSN', m.hsn_or_sac) +
        idpRow('MPN', m.part_number) + idpRow('UPC', m.upc) + idpRow('EAN', m.ean) + idpRow('ISBN', m.isbn) +
        idpRow('Reorder Point', m.reorder_level);
    (m.custom_fields || []).forEach((cf) => { other += idpRow(cf.label || cf.placeholder || 'Custom Field', cf.value_formatted || cf.value); });

    h += '<div class="idp-sec"><button type="button" class="idp-link" data-act="other">Other Details ' + (IDP.other ? '\u25BE' : '\u25B8') + '</button>' +
        (IDP.other ? '<div style="margin-top:10px">' + (other || '<div class="idp-msg">No additional details.</div>') + '</div>' : '') + '</div>';
    return h;
}

function idpStockHtml(m) {
    if (!m.track_inventory) return '<div class="idp-msg">Inventory is not tracked for this item.</div>';
    const phys = IDP.stock === 'phy';
    const locs = (m.locations || []).slice().sort((a, b) => {
        const pa = (a.is_primary_location || a.is_primary) ? 0 : 1, pb = (b.is_primary_location || b.is_primary) ? 0 : 1;
        return pa - pb || String(a.location_name || '').localeCompare(String(b.location_name || ''));
    });
    let h = '<div class="idp-switch"><button type="button" class="' + (phys ? '' : 'on') + '" data-act="stk-acc">Accounting Stock</button>' +
        '<button type="button" class="' + (phys ? 'on' : '') + '" data-act="stk-phy">Physical Stock</button></div>';
    if (!locs.length) return h + '<div class="idp-msg">No stock locations found for this item.</div>';

    h += '<div class="idp-tbl-h"><span>Location Name</span><span>Stock on Hand</span><span>Committed Stock</span><span>Available for Sale</span></div>';
    locs.forEach((l) => {
        const f = idpFigures(l, 'location_', phys);
        const inactive = String(l.status || '').toLowerCase() === 'inactive' || l.is_location_active === false;
        h += '<div class="idp-loc"><span class="n">' + escapeHtml(l.location_name || '') +
            ((l.is_primary_location || l.is_primary) ? '<em class="idp-tag p">Primary</em>' : '') +
            (inactive ? '<em class="idp-tag i">Inactive</em>' : '') + '</span>' +
            '<span>' + idpQty(f.soh) + '</span><span>' + idpQty(f.cm) + '</span><span>' + idpQty(f.av) + '</span></div>';
    });
    return h;
}

function idpTxHtml() {
    const T = IDP.tx;
    const opts = (arr, cur) => arr.map((a) => '<option value="' + a[0] + '"' + (a[0] === cur ? ' selected' : '') + '>' + a[1] + '</option>').join('');
    let h = '<div class="idp-tx-bar"><select data-sel="txtype">' + opts(Object.keys(IDP_TX).map((k) => [k, IDP_TX[k].label]), T.type) + '</select>' +
        '<select data-sel="txstatus">' + opts(IDP_STATUS, T.status) + '</select></div>';
    if (IDP.note) h += '<div class="idp-note">' + escapeHtml(IDP.note) + '</div>';

    const rows = T.rows.filter((r) => T.status === 'all' || r.status === T.status);
    rows.forEach((r) => {
        const ok = parseFloat(r.rate) > 0;
        h += '<div class="idp-tx' + (ok ? ' ok' : '') + '"' + (ok ? ' data-act="tx-rate" data-rate="' + escapeHtml(String(r.rate)) + '" title="Apply this rate to the item row"' : '') + '>' +
            '<div><b>' + escapeHtml(r.no || '') + '</b><br>' + escapeHtml(r.customer || '') + '<br>' + escapeHtml(r.date || '') + '</div>' +
            '<div class="r">Item Price: <strong>' + escapeHtml(idpMoney(r.rate) || '\u2014') + '</strong><br>Quantity Sold: <strong>' + idpQty(r.qty) + '</strong><br>' +
            '<span class="idp-st">' + escapeHtml(r.status || '') + '</span></div></div>';
    });

    if (T.loading) h += '<div class="idp-msg">Loading transactions\u2026</div>';
    else if (T.error) h += '<div class="idp-msg err">' + escapeHtml(T.error) + '<br><button type="button" class="btn btn-secondary" data-act="tx-retry">Retry</button></div>';
    else if (!rows.length) h += '<div class="idp-msg">No transactions found for this item.</div>';
    if (T.more && !T.loading && !T.error) h += '<div class="idp-msg"><button type="button" class="btn btn-secondary" data-act="tx-more">Load more</button></div>';
    return h;
}

function idpPaint(msg) {
    if (!IDP.el) return;
    const m = IDP.m, hero = IDP.el.querySelector('.idp-hero'), body = IDP.el.querySelector('.idp-body');
    IDP.el.querySelectorAll('.idp-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === IDP.tab));

    if (!m) {
        hero.innerHTML = '';
        body.innerHTML = '<div class="idp-msg' + (IDP.error ? ' err' : '') + '">' + escapeHtml(IDP.error || msg || 'Loading\u2026') +
            (IDP.error ? '<br><button type="button" class="btn btn-secondary" data-act="reload">Retry</button>' : '') + '</div>';
        return;
    }
    const svc = String(m.product_type || '').toLowerCase() === 'service';
    hero.innerHTML = '<div class="idp-img">' + IDP_ICON.img + '</div><div><div class="idp-kind">' +
        (m.track_inventory ? 'Inventory Items' : (svc ? 'Service' : 'Non-Inventory Items')) + '</div>' +
        '<div class="idp-name">' + escapeHtml(m.name || '') + ' <a href="' + escapeHtml(idpUrl()) + '" target="_blank" rel="noopener noreferrer" title="Open in Zoho Books">' + IDP_ICON.ext + '</a></div>' +
        '<div class="idp-sub">' + escapeHtml([m.sku, m.unit].filter(Boolean).join(' \u2022 ')) + '</div></div>';

    const top = body.scrollTop;
    body.innerHTML = IDP.tab === 'stock' ? idpStockHtml(m) : (IDP.tab === 'tx' ? idpTxHtml() : idpDetailsHtml(m));
    body.scrollTop = top;
}

// ---------- transactions (GET /salesorders | /invoices with item_id, then GET detail for price and quantity) ----------
function idpTxDetail(cfg, h) {
    const id = String(h[cfg.id]), ck = cfg.list + ':' + id + ':' + IDP.id;
    if (!IDP.cache[ck]) {
        const p = zbApi('GET', '/' + cfg.list + '/' + id).then((d) => {
            const doc = d[cfg.det] || {};
            const lines = (doc.line_items || []).filter((l) => String(l.item_id) === IDP.id);
            if (!lines.length) return null;
            return {
                id, no: h[cfg.num] || doc[cfg.num], customer: h.customer_name || doc.customer_name,
                date: h.date || doc.date, status: String(h.status || doc.status || '').toLowerCase(),
                rate: lines[0].rate, qty: lines.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0)
            };
        });
        p.catch(() => { delete IDP.cache[ck]; });
        IDP.cache[ck] = p;
    }
    return IDP.cache[ck];
}

async function idpTxLoad(reset) {
    const T = IDP.tx, cfg = IDP_TX[T.type];
    if (reset) { T.rows = []; T.page = 1; T.more = false; }
    T.error = '';
    const my = ++T.token;
    T.loading = true;
    idpPaint();
    try {
        const d = await zbApi('GET', '/' + cfg.list, { item_id: IDP.id, page: T.page, per_page: 25 });
        if (T !== IDP.tx || my !== T.token) return;
        const list = d[cfg.key] || [];
        const out = [];
        for (let i = 0; i < list.length; i += 5) {
            const chunk = await Promise.all(list.slice(i, i + 5).map((h) => idpTxDetail(cfg, h)));
            if (T !== IDP.tx || my !== T.token) return;
            chunk.forEach((r) => { if (r) out.push(r); });
        }
        T.rows = T.rows.concat(out);
        T.more = (d.page_context || {}).has_more_page === true;
        T.page++;
    } catch (e) {
        if (T !== IDP.tx || my !== T.token) return;
        T.error = 'Could not load transactions: ' + (e.message || 'Request failed');
        logError('ITEM_PANEL', 'Transactions failed', e);
    }
    T.loading = false;
    idpPaint();
}

/** Clicking a transaction with a valid rate puts that rate on the current row and recalculates it. */
function idpApplyRate(rate) {
    const tr = IDP.tr, inp = tr && tr.isConnected ? tr.querySelector('.rate-input') : null;
    if (!inp || !(parseFloat(rate) > 0)) return;
    inp.value = String(rate);
    inp.dispatchEvent(new Event('input', { bubbles: true }));   // existing handler: modified marker, validation, totals
    IDP.note = 'Rate ' + rate + ' applied to the item row.';
    idpPaint();
}

// ---------- manual rows ----------
function syncExtra(x, tr) {
    const q = (s) => tr.querySelector(s);
    if (!q('.desc-input')) return;
    x.description = q('.desc-input').value;
    x.accountId = q('.acc-select').value;
    x.qty = q('.qty-input').value;
    x.rate = q('.rate-input').value;
    x.discount = q('.discount-input').value;
    x.discountPct = q('.discount-input').dataset.pct === '1';
    x.taxId = q('.tax-input').value;
    const ls = q('.loc-select');
    if (ls) x.locationId = ls.value;
}

async function extraApplyItem(x, it) {
    let m = null;
    try { m = await fetchItemById(it.id); } catch (e) { logError('ITEM', 'Item detail fetch failed', e); }
    if (m) itemMerge([normItem(m)]);   // fills HSN/SAC and Goods/Service into the cached picker record
    x.itemId = it.id;
    x.name = (m && m.name) || it.name;
    x.sku = (m && m.sku) || it.sku || '';
    x.unit = (m && m.unit) || it.unit || '';
    x.description = (m && (m.purchase_description || m.description)) || '';
    const pr = m ? parseFloat(m.purchase_rate) : NaN;
    x.rate = String(isNaN(pr) ? 0 : pr);
    const supply = determineGstSupplyType();
    const ptid = m && m.purchase_tax_id ? String(m.purchase_tax_id) : '';
    x.taxId = findBestTaxForLineItem(x, m, supply.taxCategory, ptid);
    const ao = accountOptionsFor(m);
    x.accountId = ao.defId;
    paintExtraRow(x);
    markDirty();
}

function paintExtraRow(x, afterId) {
    const tbody = dom.itemsTbody;
    const master = x.itemId ? state.itemMaster[x.itemId] : null;
    const tr = document.createElement('tr');
    tr.dataset.lineItemId = x.lineItemId;
    tr.dataset.extra = '1';

    // ---- DRAG HANDLE ----
    const tdDrag = document.createElement('td');
    tdDrag.className = 'c-drag';
    tdDrag.innerHTML = '<span class="drag-dots" title="Drag to reorder">&#8942;&#8942;</span>';
    tr.appendChild(tdDrag);

    // ---- ITEM DETAILS ----
    const sku = x.sku || (master && master.sku) || '';
    const hsn = (master && master.hsn_or_sac) || '';
    const ptype = master && master.product_type ? String(master.product_type).toLowerCase() : '';
    const codeVal = (master && master.item_code) ? master.item_code : '';
    const statusVal = (master && master.status) ? master.status.toLowerCase() : 'active';

    const tdItem = document.createElement('td');
    tdItem.className = 'c-item';
    tdItem.innerHTML =
        '<div class="zb-item-wrap">' +
        '<div class="zb-thumb" title="Item Thumbnail">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
        '</div>' +
        '<div class="zb-item-content">' +
        '<div class="zb-name-row">' +
        '<div class="zi-pick" style="flex:1;"></div>' +
        '<span class="zb-inline-actions"></span>' +
        '</div>' +
        (sku || codeVal ? '<div class="zb-sku-text">' + (codeVal ? 'Code: ' + escapeHtml(codeVal) + ' · ' : '') + (sku ? 'SKU: ' + escapeHtml(sku) : '') + (x.unit ? ' · Unit: ' + escapeHtml(x.unit) : '') + '</div>' : '') +
        '<div class="zb-desc-box"></div>' +
        '<div class="zb-tag-row">' +
        '<span class="' + (ptype === 'service' ? 'zb-pill-service' : 'zb-pill-goods') + '">' + (ptype === 'service' ? 'SERVICE' : 'GOODS') + '</span>' +
        (hsn ? '<span class="zb-hsn-tag">' + (ptype === 'service' ? 'SAC Code:' : 'HSN Code:') + ' <span class="zb-hsn-code">' + escapeHtml(hsn) + '</span></span>' : '') +
        '<span class="zi-badge manual">MANUAL ROW</span>' +
        (statusVal ? '<span class="zi-status ' + statusVal + '">' + statusVal.toUpperCase() + '</span>' : '') +
        '</div>' +
        '</div>' +
        '</div>';

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'item-pick' + (x.itemId ? '' : ' empty');
    pick.textContent = x.itemId ? x.name : 'Select or type to add an item';
    pick.title = 'Click to choose or change the item';
    pick.addEventListener('click', () => ipOpen(pick, (it) => extraApplyItem(x, it)));
    tdItem.querySelector('.zi-pick').appendChild(pick);

    const desc = document.createElement('textarea');
    desc.className = 'desc-input';
    desc.rows = 2;
    desc.value = x.description || '';
    desc.placeholder = 'Add a description to your item';
    tdItem.querySelector('.zb-desc-box').appendChild(desc);

    const actions = tdItem.querySelector('.zb-inline-actions');
    const mkBtn = (txt, title, fn, dis, cls = '') => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = txt; b.title = title; b.disabled = !!dis;
        b.className = 'zb-btn-icon ' + cls;
        if (fn) b.addEventListener('click', fn);
        actions.appendChild(b);
        return b;
    };
    const infoBtn = mkBtn('···', 'Item details', null, !x.itemId, 'info-btn');
    mkBtn('\u21BA', 'Reset row to item defaults', () => extraApplyItem(x, { id: x.itemId, name: x.name, sku: x.sku, unit: x.unit }), !x.itemId);
    mkBtn('\u29C9', 'Duplicate row', () => {
        const y = Object.assign({}, x, { lineItemId: 'new_' + (++extraSeq) });
        state.extra[y.lineItemId] = y;
        paintExtraRow(y, x.lineItemId);
        markDirty();
    });
    mkBtn('\u2715', 'Remove row', async () => {
        if (x.itemId && !(await adConfirm('Remove row', 'Remove "' + x.name + '" from this purchase order?'))) return;
        delete state.extra[x.lineItemId];
        tr.remove();
        const d = tbody.querySelector('tr[data-detail-for="' + x.lineItemId + '"]');
        if (d) d.remove();
        markDirty();
        recalculateAllAmounts();
    }, false, 'remove-btn');
    tr.appendChild(tdItem);
    hsnRowTag(tr, x, master);

    // ---- ACCOUNT ----
    const tdAcc = document.createElement('td');
    tdAcc.appendChild(buildAccountField(master, x.accountId));
    tr.appendChild(tdAcc);

    // ---- QUANTITY ----
    const tdQty = document.createElement('td');
    tdQty.className = 'qty-cell';
    const qtyWrap = document.createElement('div');
    qtyWrap.className = 'qty-control-wrap';
    const decBtn = document.createElement('button');
    decBtn.type = 'button';
    decBtn.className = 'qty-btn qty-dec';
    decBtn.textContent = '−';
    decBtn.title = 'Decrease quantity';
    const qty = document.createElement('input');
    qty.type = 'number';
    qty.className = 'cell-input qty-input';
    qty.min = '0';
    qty.step = 'any';
    qty.value = x.qty;
    const incBtn = document.createElement('button');
    incBtn.type = 'button';
    incBtn.className = 'qty-btn qty-inc';
    incBtn.textContent = '+';
    incBtn.title = 'Increase quantity';

    decBtn.addEventListener('click', () => {
        const cur = parseFloat(qty.value) || 0;
        qty.value = String(Math.max(0, cur - 1));
        qty.dispatchEvent(new Event('input', { bubbles: true }));
    });
    incBtn.addEventListener('click', () => {
        const cur = parseFloat(qty.value) || 0;
        qty.value = String(cur + 1);
        qty.dispatchEvent(new Event('input', { bubbles: true }));
    });
    qty.addEventListener('input', onQuantityChange);

    qtyWrap.appendChild(decBtn);
    qtyWrap.appendChild(qty);
    qtyWrap.appendChild(incBtn);
    tdQty.appendChild(qtyWrap);
    tr.appendChild(tdQty);

    // ---- RATE + DISCOUNT ----
    const tdRate = document.createElement('td');
    tdRate.className = 'rate-cell';
    const rateWrap = document.createElement('div');
    rateWrap.className = 'rate-control-wrap';
    const rate = document.createElement('input');
    rate.type = 'number';
    rate.className = 'cell-input rate-input';
    rate.min = '0';
    rate.step = '0.01';
    rate.value = x.rate;
    rate.dataset.defaultRate = master && master.purchase_rate != null ? String(master.purchase_rate) : x.rate;

    const rateReset = document.createElement('button');
    rateReset.type = 'button';
    rateReset.className = 'rate-reset-btn';
    rateReset.innerHTML = '&#8635;';
    rateReset.title = 'Reset rate to item master default';
    rateReset.style.display = 'none';

    const rateModDot = document.createElement('span');
    rateModDot.className = 'rate-mod-dot';
    rateModDot.title = 'Rate has been modified';
    rateModDot.style.display = 'none';

    const checkRateMod = () => {
        const defR = parseFloat(rate.dataset.defaultRate) || 0;
        const curR = parseFloat(rate.value) || 0;
        const isMod = Math.abs(curR - defR) > 0.0001;
        rateReset.style.display = isMod ? 'inline-flex' : 'none';
        rateModDot.style.display = isMod ? 'inline-block' : 'none';
    };

    rateReset.addEventListener('click', () => {
        rate.value = rate.dataset.defaultRate || '0';
        checkRateMod();
        rate.dispatchEvent(new Event('input', { bubbles: true }));
    });
    rate.addEventListener('input', (e) => {
        checkRateMod();
        onAmountChange(e);
    });

    rateWrap.appendChild(rate);
    rateWrap.appendChild(rateReset);
    rateWrap.appendChild(rateModDot);
    tdRate.appendChild(rateWrap);

    tr.appendChild(tdRate);
    tr.appendChild(buildDiscountCell({ value: x.discount, pct: x.discountPct }));

    // ---- TAX ----
    const tdTax = document.createElement('td');
    tdTax.className = 'tax-cell';
    const taxSel = document.createElement('select');

    taxSel.className = 'cell-input tax-input tax-select';

    buildTaxSelect(
        taxSel,
        x,
        x.taxId || '',
        false,
        master
    );

    taxSel.addEventListener('change', onAmountChange);

    tdTax.appendChild(taxSel);
    tr.appendChild(tdTax);

    // antigravity update with searchable tax dropdown
    lkEnhance(taxSel, {
        placeholder: 'Select a Tax',
        emptyText: 'No taxes found',
        footer: [{
            icon: '+',
            label: 'New Tax',
            onClick: () => {
                const dcExt = state.organizationDataCenterExtension || '.com';
                window.open(`https://books.zoho${dcExt}/app#/settings/taxes/new`, '_blank', 'noopener,noreferrer');
            }
        }]
    });

    // ---- AMOUNT ----
    const tdAmt = document.createElement('td');
    tdAmt.className = 'amount-cell';
    tdAmt.style.textAlign = 'right';
    tdAmt.textContent = '0.00';
    tr.appendChild(tdAmt);

    tr.addEventListener('input', () => syncExtra(x, tr));
    tr.addEventListener('change', () => syncExtra(x, tr));

    // ---- Item Details collapsible row ----
    const trD = document.createElement('tr');
    trD.className = 'item-detail-row';
    trD.hidden = true;
    trD.dataset.detailFor = x.lineItemId;
    const tdD = document.createElement('td');
    tdD.colSpan = 7;
    tdD.appendChild(buildItemDetailPanel(x, master, tr));
    trD.appendChild(tdD);
    infoBtn.addEventListener('click', () => niRowMenu(infoBtn, x.itemId, tr));

    const old = tbody.querySelector('tr[data-line-item-id="' + x.lineItemId + '"]');
    if (old) {
        const oldD = tbody.querySelector('tr[data-detail-for="' + x.lineItemId + '"]');
        tbody.insertBefore(tr, old);
        tbody.insertBefore(trD, old);
        old.remove();
        if (oldD) oldD.remove();
    } else if (afterId) {
        const ref = tbody.querySelector('tr[data-detail-for="' + afterId + '"]');
        const next = ref ? ref.nextSibling : null;
        tbody.insertBefore(tr, next);
        tbody.insertBefore(trD, next);
    } else {
        tbody.appendChild(tr);
        tbody.appendChild(trD);
    }

    checkRateMod();
    applyItemModes();
    return tr;
}

function addExtraRow() {
    const id = 'new_' + (++extraSeq);
    const x = {
        lineItemId: id, itemId: '', name: '', sku: '', unit: '', description: '', qty: '1', rate: '0',
        discount: '0', discountPct: false, taxId: '', taxName: '', taxPercentage: 0, accountId: '', locationId: ''
    };
    state.extra[id] = x;
    const tr = paintExtraRow(x);
    markDirty();
    const b = tr.querySelector('.item-pick');
    if (b) { b.scrollIntoView({ block: 'nearest' }); b.click(); }
}

function wireAddRow() {
    injectExtraCss();
    const add = $('btn-add-item');
    if (!add) return;
    add.disabled = false;
    add.title = 'Add an item from the Item Master';
    if (add.dataset.wired !== '1') {
        add.dataset.wired = '1';
        add.addEventListener('click', addExtraRow);
    }
}



// ============================================================
// ADD ITEMS IN BULK
//   Data   : itemSrc (GET /items, cached in IndexedDB + memory), fetchItemById (GET /items/{id})
//   Filter : GET /categories (children / parent_category_id) + client-side category match
//   Output : state.extra rows via extraApplyItem() -> paintExtraRow()  (SO lines are never touched)
// ============================================================

const BK = {
    built: false, open: false, el: null,
    query: '', sq: '', timer: null,
    limit: 60, items: [],
    loading: false, error: '', allBusy: false, adding: false,
    sel: new Map(),
    cats: [], catsLoaded: false, catId: '', subs: false
};

const bkQ = () => (BK.query.length >= 2 ? BK.query : '');
const bkNum = (v) => { const n = parseFloat(v); return isFinite(n) ? n : NaN; };

// ---------- categories ----------
async function bkLoadCategories() {
    if (BK.catsLoaded) return;
    try {
        const raw = [];
        let page = 1, more = true;
        while (more && page <= 20) {
            const d = await zbApi('GET', '/categories', { page, per_page: 200 });
            raw.push(...(d.categories || []));
            more = (d.page_context || {}).has_more_page === true;
            page++;
        }
        const map = new Map();
        const add = (c, parentId) => {
            if (!c) return;
            const id = String(c.category_id || '');
            if (!id) return;
            const pid = parentId || (c.parent_category_id ? String(c.parent_category_id) : '');
            if (!map.has(id)) map.set(id, { id, name: String(c.name || c.category_name || '').trim(), parentId: pid, depth: 0 });
            (c.children || []).forEach((ch) => add(ch, id));
        };
        raw.forEach((c) => add(c, ''));

        const kids = {};
        map.forEach((c) => {
            const p = map.has(c.parentId) ? c.parentId : '';
            (kids[p] = kids[p] || []).push(c);
        });
        const out = [];
        const walk = (pid, depth) => (kids[pid] || []).slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach((c) => {
                if (depth > 8) return;
                c.depth = depth;
                out.push(c);
                walk(c.id, depth + 1);
            });
        walk('', 0);
        BK.cats = out;
        BK.catsLoaded = true;
    } catch (e) {
        logError('BULK', 'Could not load categories', e);
    }
}

function bkFillCats() {
    if (!BK.el) return;
    const sel = BK.el.querySelector('.bk-cat');
    const cur = BK.catId;
    nvFill(sel, BK.cats.map((c) => [c.id, '\u00A0\u00A0'.repeat(c.depth || 0) + c.name]), '');
    sel.value = cur;
    if (sel._sync) sel._sync();
}

function bkCatSet() {
    if (!BK.catId) return null;
    const set = new Set([BK.catId]);
    if (BK.subs) {
        let grew = true;
        while (grew) {
            grew = false;
            BK.cats.forEach((c) => {
                if (!set.has(c.id) && set.has(c.parentId)) { set.add(c.id); grew = true; }
            });
        }
    }
    return set;
}

function bkView() {
    const set = bkCatSet();
    const all = itemSrc.view(BK.query);
    return set ? all.filter((it) => set.has(it.categoryId)) : all;
}

// ---------- left list ----------
function bkTail(list, text, retry) {
    const d = document.createElement('div');
    d.className = 'bk-msg';
    d.textContent = text;
    if (retry) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-secondary';
        b.setAttribute('data-retry', '1');
        b.textContent = 'Retry';
        d.appendChild(document.createElement('br'));
        d.appendChild(b);
    }
    list.appendChild(d);
}

function bkSyncAll() {
    const cb = BK.el.querySelector('.bk-all');
    cb.checked = BK.items.length > 0 && BK.items.every((it) => BK.sel.has(it.id));
    cb.disabled = BK.allBusy;
}

function bkPaint() {
    if (!BK.open) return;
    const list = BK.el.querySelector('.bk-list');
    const all = bkView();
    BK.items = all;
    bkSyncAll();

    const q = bkQ();
    const canFetch = itemSrc.canMore(q) && (!BK.query || BK.sq === BK.query);

    if (!all.length) {
        list.innerHTML = '';
        if (BK.loading || BK.allBusy) bkTail(list, 'Loading items…');
        else if (BK.error) bkTail(list, 'Could not load items: ' + BK.error, true);
        else if (canFetch) { bkTail(list, 'Searching Zoho Books…'); setTimeout(bkFetchMore, 0); }
        else if (itemSrc.canMore(q)) bkTail(list, 'Searching Zoho Books…');
        else bkTail(list, 'No items found');
        return;
    }

    const top = list.scrollTop;
    const shown = Math.min(all.length, BK.limit);
    list.innerHTML = '';

    all.slice(0, shown).forEach((it) => {
        const d = document.createElement('div');
        d.className = 'bk-item' + (BK.sel.has(it.id) ? ' on' : '');
        d.dataset.id = it.id;

        const info = document.createElement('div');
        info.className = 'bk-info';
        const nm = document.createElement('div');
        nm.className = 'bk-name';
        nm.textContent = it.name;
        info.appendChild(nm);

        const sub = document.createElement('div');
        sub.className = 'bk-sub';
        const code = it.sku || it.itemCode;
        if (code) {
            const s = document.createElement('span');
            s.textContent = (it.sku ? 'SKU: ' : 'Code: ') + code;
            sub.appendChild(s);
        }
        const pr = parseFloat(it.purchaseRate);
        if (isFinite(pr)) {
            const s = document.createElement('span');
            s.textContent = 'Purchase Rate: ' + curSym() + pr.toFixed(2);
            sub.appendChild(s);
        }
        if (sub.childNodes.length) info.appendChild(sub);
        d.appendChild(info);

        const hasStock = it.stockOnHand !== null && it.stockOnHand !== undefined &&
            (it.itemType === 'inventory' || it.itemType === '');
        if (hasStock) {
            const st = document.createElement('div');
            st.className = 'bk-stock';
            st.appendChild(document.createTextNode('Stock on Hand'));
            const b = document.createElement('b');
            b.className = it.stockOnHand > 0 ? 'pos' : '';
            b.textContent = it.stockOnHand.toFixed(2) + (it.unit ? ' ' + it.unit : '');
            st.appendChild(b);
            d.appendChild(st);
        }

        const chk = document.createElement('span');
        chk.className = 'bk-chk';
        chk.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        d.appendChild(chk);

        list.appendChild(d);
    });

    if (BK.loading || BK.allBusy) bkTail(list, 'Loading more…');
    else if (BK.error) bkTail(list, 'Could not load more items.', true);
    list.scrollTop = top;

    const more = BK.limit < all.length || (itemSrc.canMore(q) && (!BK.query || BK.sq === BK.query));
    if (!BK.loading && !BK.allBusy && !BK.error && more && list.scrollHeight <= list.clientHeight + 40) {
        setTimeout(bkNear, 0);
    }
}

function bkNear() {
    if (!BK.open) return;
    if (BK.limit < BK.items.length) { BK.limit += 60; bkPaint(); return; }
    if (!BK.error) bkFetchMore();
}

function bkFetchMore() {
    if (!BK.open || BK.loading || BK.allBusy) return;
    const q = bkQ();
    if (!itemSrc.canMore(q)) return;
    BK.loading = true;
    BK.error = '';
    bkPaint();
    itemSrc.loadMore(q)
        .catch((e) => { BK.error = e.message || 'Request failed'; logError('BULK', 'Item fetch failed', e); })
        .then(() => { BK.loading = false; bkPaint(); });
}

function bkSearchServer() {
    BK.sq = BK.query;
    if (!bkQ()) { bkPaint(); return; }
    if (BK.loading) { BK.timer = setTimeout(bkSearchServer, 250); return; }
    bkFetchMore();
}

// ---------- selection ----------
function bkToggle(it) {
    if (BK.sel.has(it.id)) BK.sel.delete(it.id);
    else BK.sel.set(it.id, { item: it, qty: '1' });
    bkRefresh();
}

function bkRefresh() {
    bkPaint();
    bkPaintSel();
}

async function bkSelectAll(on) {
    if (BK.allBusy) return;
    if (!on) {
        bkView().forEach((it) => BK.sel.delete(it.id));
        bkRefresh();
        return;
    }
    BK.allBusy = true;
    const st = BK.el.querySelector('.bk-status');
    st.textContent = 'Loading all matching items…';
    bkSyncAll();
    try {
        const q = bkQ();
        let guard = 0;
        while (itemSrc.canMore(q) && guard++ < 200) {
            if (!(await itemSrc.loadMore(q))) break;
        }
    } catch (e) {
        logError('BULK', 'Select all: load failed', e);
        BK.error = e.message || 'Request failed';
    }
    BK.allBusy = false;
    st.textContent = '';
    bkView().forEach((it) => {
        if (!BK.sel.has(it.id)) BK.sel.set(it.id, { item: it, qty: '1' });
    });
    bkRefresh();
}

// ---------- right panel ----------
function bkTotals() {
    let total = 0;
    BK.sel.forEach((r) => { const n = bkNum(r.qty); if (n > 0) total += n; });
    BK.el.querySelector('.bk-count').textContent = String(BK.sel.size);
    BK.el.querySelector('.bk-total').textContent = String(parseFloat(total.toFixed(4)));
}

function bkPaintSel() {
    if (!BK.open) return;
    const box = BK.el.querySelector('.bk-sel');
    box.innerHTML = '';

    if (!BK.sel.size) {
        box.innerHTML = '<div class="bk-empty"><span>Click the item names from the left pane to select them</span></div>';
        bkTotals();
        return;
    }

    BK.sel.forEach((rec, id) => {
        const it = rec.item;
        const code = it.sku || it.itemCode;

        const row = document.createElement('div');
        row.className = 'bk-row';
        row.dataset.id = id;

        const lbl = document.createElement('div');
        lbl.className = 'bk-lbl';
        lbl.textContent = (code ? '[' + code + '] ' : '') + it.name;
        row.appendChild(lbl);

        const qc = document.createElement('div');
        qc.className = 'bk-qc';
        qc.innerHTML = '<button type="button" class="bk-qb" data-act="dec" title="Decrease">&minus;</button>' +
            '<input type="number" class="bk-q" min="0" step="any">' +
            '<button type="button" class="bk-qb" data-act="inc" title="Increase">+</button>';
        const inp = qc.querySelector('.bk-q');
        inp.value = rec.qty;
        if (!(bkNum(rec.qty) > 0)) inp.classList.add('error');
        row.appendChild(qc);

        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'bk-rm';
        rm.setAttribute('data-act', 'rm');
        rm.title = 'Remove';
        rm.innerHTML = '&times;';
        row.appendChild(rm);

        box.appendChild(row);
    });
    bkTotals();
}

// ---------- add to item table ----------
async function bkAddItems() {
    if (BK.adding) return;
    const st = BK.el.querySelector('.bk-status');
    const btn = BK.el.querySelector('.bk-add');

    if (!BK.sel.size) { st.textContent = 'Select at least one item.'; return; }

    let firstBad = null;
    BK.el.querySelectorAll('.bk-row').forEach((row) => {
        const rec = BK.sel.get(row.dataset.id);
        const bad = !rec || !(bkNum(rec.qty) > 0);
        const inp = row.querySelector('.bk-q');
        inp.classList.toggle('error', bad);
        if (bad && !firstBad) firstBad = inp;
    });
    if (firstBad) {
        st.textContent = 'Enter a quantity greater than zero for every selected item.';
        firstBad.focus();
        return;
    }

    BK.adding = true;
    btn.disabled = true;
    st.textContent = 'Adding items…';

    try {
        const picks = Array.from(BK.sel.values());

        // prefetch item masters (4 at a time); results land in state.itemMaster + IndexedDB
        let n = 0;
        const worker = async () => {
            while (n < picks.length) {
                const p = picks[n++];
                try { await fetchItemById(p.item.id); }
                catch (e) { logError('BULK', 'Item detail failed: ' + p.item.id, e); }
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);

        for (const p of picks) {
            const id = 'new_' + (++extraSeq);
            const x = {
                lineItemId: id, itemId: '', name: p.item.name, sku: p.item.sku || '', unit: p.item.unit || '',
                description: '', qty: String(bkNum(p.qty)), rate: '0',
                discount: '0', discountPct: false, taxId: '', taxName: '', taxPercentage: 0,
                accountId: '', locationId: ''
            };
            state.extra[id] = x;                 // separate from state.salesOrder.lineItems / state.lineItems
            await extraApplyItem(x, p.item);     // account, rate, tax, description from item master + paints row
        }

        recalculateAllAmounts();
        refreshStockInfo();
        markDirty();
        BK.adding = false;
        btn.disabled = false;
        bkClose();
    } catch (e) {
        logError('BULK', 'Add items failed', e);
        BK.adding = false;
        btn.disabled = false;
        st.textContent = 'Could not add items: ' + (e.message || 'Request failed');
    }
}

// ---------- open / close / build ----------
function bkClose() {
    if (!BK.el || BK.adding) return;
    BK.open = false;
    BK.el.hidden = true;
    clearTimeout(BK.timer);
}

function bkOpen() {
    bkBuild();
    BK.open = true;
    BK.sel.clear();
    BK.query = ''; BK.sq = ''; BK.catId = ''; BK.subs = false;
    BK.limit = 60; BK.error = ''; BK.loading = false; BK.allBusy = false; BK.adding = false;

    const el = BK.el;
    el.querySelector('.bk-search').value = '';
    el.querySelector('.bk-subchk').checked = false;
    el.querySelector('.bk-status').textContent = '';
    el.querySelector('.bk-add').disabled = false;
    const cat = el.querySelector('.bk-cat');
    cat.value = '';
    if (cat._sync) cat._sync();
    el.querySelector('.bk-list').scrollTop = 0;

    el.hidden = false;
    bkPaintSel();
    bkPaint();               // cached items show immediately

    (async () => {
        BK.loading = true;
        bkPaint();
        try { await itemSrc.init(); }
        catch (e) { BK.error = e.message || 'Request failed'; logError('BULK', 'Item init failed', e); }
        BK.loading = false;
        bkPaint();
    })();
    itemSrc.staleCheck();
    bkLoadCategories().then(bkFillCats);

    setTimeout(() => el.querySelector('.bk-search').focus(), 30);
}

function bkBuild() {
    if (BK.built) return;
    BK.built = true;

    const ov = document.createElement('div');
    ov.className = 'bk-overlay';
    ov.hidden = true;
    ov.innerHTML =
        '<div class="bk-box" role="dialog" aria-modal="true" aria-label="Add Items in Bulk">' +
        '<div class="bk-head"><h3>Add Items in Bulk</h3><button type="button" class="bk-x" aria-label="Close">&times;</button></div>' +
        '<div class="bk-main">' +
        '<div class="bk-left">' +
        '<div class="bk-filters">' +
        '<div class="bk-frow">' +
        '<svg class="bk-fi" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round"><path d="M3 4h18l-7 8.5V20l-4-2v-5.5z"/></svg>' +
        '<div class="bk-cat-wrap"><select class="bk-cat"></select></div>' +
        '<span class="bk-fsep"></span>' +
        '<label class="bk-subs"><input type="checkbox" class="bk-subchk"> Include sub-categories</label>' +
        '</div>' +
        '<input type="text" class="bk-search" placeholder="Type to search or scan the barcode of the item" autocomplete="off">' +
        '</div>' +
        '<div class="bk-lhead"><span>All Items</span><label class="bk-selall"><input type="checkbox" class="bk-all"> Select All</label></div>' +
        '<div class="bk-list"></div>' +
        '</div>' +
        '<div class="bk-right">' +
        '<div class="bk-rhead"><div class="bk-rt">Selected Items <span class="bk-count">0</span></div>' +
        '<div class="bk-tq">Total Quantity: <b class="bk-total">0</b></div></div>' +
        '<div class="bk-sel"></div>' +
        '<div class="bk-foot"><button type="button" class="btn btn-primary bk-add">Add Items</button>' +
        '<button type="button" class="btn btn-secondary bk-cancel">Cancel</button><span class="bk-status"></span></div>' +
        '</div>' +
        '</div>' +
        '</div>';
    document.body.appendChild(ov);
    BK.el = ov;

    const q = (s) => ov.querySelector(s);
    const list = q('.bk-list'), search = q('.bk-search'), cat = q('.bk-cat'), sel = q('.bk-sel');

    // category dropdown (existing searchable lookup)
    nvFill(cat, [], '');
    lkEnhance(cat, { clearable: true, placeholder: 'Category', emptyText: 'No categories found' });
    cat.addEventListener('change', () => {
        BK.catId = cat.value;
        BK.limit = 60;
        list.scrollTop = 0;
        bkPaint();
    });
    q('.bk-subchk').addEventListener('change', (ev) => {
        BK.subs = ev.target.checked;
        BK.limit = 60;
        bkPaint();
    });

    // search (name / SKU / item code / barcode)
    search.addEventListener('input', () => {
        BK.query = search.value.trim();
        BK.limit = 60;
        BK.error = '';
        list.scrollTop = 0;
        bkPaint();
        clearTimeout(BK.timer);
        BK.timer = setTimeout(bkSearchServer, 350);
    });
    search.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        const code = BK.query.toLowerCase();
        if (!code) return;
        const hit = itemSrc.all().find((it) =>
            [it.sku, it.itemCode, it.upc, it.ean, it.isbn, it.partNumber].some((v) => v && String(v).toLowerCase() === code));
        if (hit) {                                   // scanner: exact code match selects (or +1 if already selected)
            const rec = BK.sel.get(hit.id);
            if (rec) rec.qty = String((bkNum(rec.qty) > 0 ? bkNum(rec.qty) : 0) + 1);
            else BK.sel.set(hit.id, { item: hit, qty: '1' });
            search.value = '';
            BK.query = ''; BK.sq = '';
            bkRefresh();
            return;
        }
        clearTimeout(BK.timer);
        bkSearchServer();
    });

    // left list
    list.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-retry]')) { BK.error = ''; bkFetchMore(); return; }
        const n = ev.target.closest('.bk-item');
        if (!n) return;
        const it = BK.items.find((x) => x.id === n.dataset.id);
        if (it) bkToggle(it);
    });
    attachInfiniteScroll(list, bkNear);
    q('.bk-all').addEventListener('change', (ev) => bkSelectAll(ev.target.checked));

    // right list (delegated)
    sel.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-act]');
        if (!b) return;
        const row = b.closest('.bk-row');
        const rec = row ? BK.sel.get(row.dataset.id) : null;
        if (!rec) return;
        if (b.dataset.act === 'rm') { BK.sel.delete(row.dataset.id); bkRefresh(); return; }
        const inp = row.querySelector('.bk-q');
        const cur = bkNum(inp.value);
        const base = cur > 0 ? cur : 0;
        const next = b.dataset.act === 'inc' ? base + 1 : Math.max(1, base - 1);
        const val = String(parseFloat(next.toFixed(6)));
        inp.value = val;
        rec.qty = val;
        inp.classList.remove('error');
        bkTotals();
    });
    sel.addEventListener('input', (ev) => {
        const inp = ev.target;
        if (!inp.classList.contains('bk-q')) return;
        const rec = BK.sel.get(inp.closest('.bk-row').dataset.id);
        if (!rec) return;
        if (inp.value.indexOf('-') > -1) inp.value = inp.value.replace(/-/g, '');
        rec.qty = inp.value;
        inp.classList.toggle('error', !(bkNum(inp.value) > 0));
        bkTotals();
    });
    sel.addEventListener('keydown', (ev) => {
        if (ev.target.classList.contains('bk-q') && ['-', '+', 'e', 'E'].indexOf(ev.key) > -1) ev.preventDefault();
    });

    // footer / close
    q('.bk-add').addEventListener('click', bkAddItems);
    q('.bk-cancel').addEventListener('click', bkClose);
    q('.bk-x').addEventListener('click', bkClose);
    ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) bkClose(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && BK.open) bkClose(); });
}

// ============================================================
// UI RENDERING
// ============================================================

function renderHeader(salesOrder) {
    setText(dom.headerSoNumber, salesOrder.number);
    if (dom.soNumberDisplay) dom.soNumberDisplay.value = salesOrder.number;
    if (dom.referenceNumber) dom.referenceNumber.value = salesOrder.number;
}

function renderItems(allocations) {
    ensureItemUi();

    const tbody = dom.itemsTbody;
    tbody.innerHTML = '';

    Object.values(allocations).forEach((a) => {
        const soItem = state.salesOrder.lineItems.find((li) => li.lineItemId === a.lineItemId);
        if (!soItem) return;
        const master = soItem.itemId ? state.itemMaster[soItem.itemId] : null;

        const isFullyPurchased = a.remainingQuantity <= 0 && !a.overAllocated;
        const isOverAllocated = a.overAllocated;
        const isBlocked = isFullyPurchased || isOverAllocated;

        const tr = document.createElement('tr');
        if (isOverAllocated) tr.className = 'over-allocated';
        else if (isFullyPurchased) tr.className = 'fully-purchased';
        tr.dataset.lineItemId = a.lineItemId;

        // ---- DRAG HANDLE ----
        const tdDrag = document.createElement('td');
        tdDrag.className = 'c-drag';
        tdDrag.innerHTML = '<span class="drag-dots" title="Drag to reorder">&#8942;&#8942;</span>';
        tr.appendChild(tdDrag);

        // ---- ITEM DETAILS ----
        const sku = (master && master.sku) || soItem.sku || '';
        const hsn = (master && master.hsn_or_sac) || soItem.hsn || '';
        const ptype = master && master.product_type ? String(master.product_type).toLowerCase() : '';
        const codeVal = (master && master.item_code) ? master.item_code : '';
        const statusVal = (master && master.status) ? master.status.toLowerCase() : 'active';

        const tdItem = document.createElement('td');
        tdItem.className = 'c-item';
        tdItem.innerHTML =
            '<div class="zb-item-wrap">' +
            '<div class="zb-thumb" title="Item Thumbnail">' +
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
            '</div>' +
            '<div class="zb-item-content">' +
            '<div class="zb-name-row">' +
            '<span class="zb-item-name">' + escapeHtml(soItem.name) + '</span>' +
            '<span class="zb-inline-actions"></span>' +
            '</div>' +
            (sku || codeVal ? '<div class="zb-sku-text">SKU: ' + escapeHtml(sku || codeVal) + '</div>' : '') +
            '<div class="zb-desc-box"></div>' +
            '<div class="zb-tag-row">' +
            '<span class="' + (ptype === 'service' ? 'zb-pill-service' : 'zb-pill-goods') + '">' + (ptype === 'service' ? 'SERVICE' : 'GOODS') + '</span>' +
            (hsn ? '<span class="zb-hsn-tag">' + (ptype === 'service' ? 'SAC Code:' : 'HSN Code:') + ' <span class="zb-hsn-code">' + escapeHtml(hsn) + '</span></span>' : '') +
            '<span class="zi-badge so-item">SO ITEM</span>' +
            (statusVal ? '<span class="zi-status ' + statusVal + '">' + statusVal.toUpperCase() + '</span>' : '') +
            (isFullyPurchased ? '<span class="status-badge fully-purchased">Fully Purchased</span>' : '') +
            (isOverAllocated ? '<span class="status-badge over-allocated">OVER-ALLOCATED</span>' : '') +
            '</div>' +
            '</div>' +
            '</div>';

        const descInput = document.createElement('textarea');
        descInput.className = 'desc-input';
        descInput.rows = 2;
        descInput.value = soItem.description || '';
        descInput.placeholder = 'Add a description to your item';
        descInput.addEventListener('input', markDirty);
        tdItem.querySelector('.zb-desc-box').appendChild(descInput);

        const actions = tdItem.querySelector('.zb-inline-actions');
        const infoBtn = document.createElement('button');
        infoBtn.type = 'button';
        infoBtn.className = 'zb-btn-icon info-btn';
        infoBtn.textContent = '···';
        infoBtn.title = soItem.itemId ? 'Item details' : 'No item master record for this line';
        infoBtn.disabled = !soItem.itemId;
        const rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 'zb-btn-icon remove-btn';
        rmBtn.textContent = '✕';
        rmBtn.disabled = true;
        rmBtn.title = 'SO lines cannot be removed in conversion mode (set quantity to 0 to exclude)';
        actions.appendChild(infoBtn);
        actions.appendChild(rmBtn);
        tr.appendChild(tdItem);

        hsnRowTag(tr, soItem, master);

        // ---- ACCOUNT ----
        const tdAcc = document.createElement('td');
        tdAcc.appendChild(buildAccountField(master, ''));
        tr.appendChild(tdAcc);

        // ---- QUANTITY ----
        const tdQty = document.createElement('td');
        tdQty.className = 'qty-cell';
        const qtyWrap = document.createElement('div');
        qtyWrap.className = 'qty-control-wrap';
        const decBtn = document.createElement('button');
        decBtn.type = 'button';
        decBtn.className = 'qty-btn qty-dec';
        decBtn.textContent = '−';
        decBtn.title = 'Decrease quantity';
        decBtn.disabled = isBlocked;

        const qtyInput = document.createElement('input');
        qtyInput.type = 'number';
        qtyInput.className = 'cell-input qty-input';
        qtyInput.min = '0';
        qtyInput.step = 'any';
        qtyInput.value = isBlocked ? '0' : String(Math.max(0, a.remainingQuantity));
        qtyInput.dataset.lineItemId = a.lineItemId;
        qtyInput.dataset.maxQty = String(Math.max(0, a.remainingQuantity));
        qtyInput.disabled = isBlocked;
        if (isBlocked) qtyInput.title = isOverAllocated ? 'Over-allocated: nothing left to purchase.' : 'Fully purchased.';

        const incBtn = document.createElement('button');
        incBtn.type = 'button';
        incBtn.className = 'qty-btn qty-inc';
        incBtn.textContent = '+';
        incBtn.title = 'Increase quantity';
        incBtn.disabled = isBlocked;

        decBtn.addEventListener('click', () => {
            const cur = parseFloat(qtyInput.value) || 0;
            qtyInput.value = String(Math.max(0, cur - 1));
            qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        incBtn.addEventListener('click', () => {
            const cur = parseFloat(qtyInput.value) || 0;
            const maxQ = parseFloat(qtyInput.dataset.maxQty) || 0;
            qtyInput.value = String(Math.min(maxQ, cur + 1));
            qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        qtyInput.addEventListener('input', onQuantityChange);

        qtyWrap.appendChild(decBtn);
        qtyWrap.appendChild(qtyInput);
        qtyWrap.appendChild(incBtn);
        tdQty.appendChild(qtyWrap);

        const remClass = isOverAllocated ? 'remaining-negative' : (isFullyPurchased ? 'remaining-zero' : '');
        const info = document.createElement('div');
        info.className = 'qty-info';
        info.innerHTML =
            '<span><span class="label">SO Qty:</span> <span class="value">' + a.salesOrderQuantity + '</span></span>' +
            '<span><span class="label">Allocated:</span> <span class="value">' + a.allocatedQuantity + '</span></span>' +
            '<span><span class="label">Remaining:</span> <span class="value ' + remClass + '">' + a.remainingQuantity + '</span></span>';
        tdQty.appendChild(info);
        tr.appendChild(tdQty);

        // ---- RATE + DISCOUNT ----
        const tdRate = document.createElement('td');
        tdRate.className = 'rate-cell';
        const rateWrap = document.createElement('div');
        rateWrap.className = 'rate-control-wrap';
        const rateInput = document.createElement('input');
        rateInput.type = 'number';
        rateInput.className = 'cell-input rate-input';
        rateInput.min = '0';
        rateInput.step = '0.01';
        // PO rate always comes from the item's purchase_rate (never the sales rate)
        const mPurchaseRate = master ? parseFloat(master.purchase_rate) : NaN;
        const poRate = master
            ? (isNaN(mPurchaseRate) ? 0 : mPurchaseRate)      // item loaded: use purchase_rate (0 if not set)
            : (parseFloat(soItem.rate) || 0);                 // no item record on this SO line: keep SO rate as fallback
        rateInput.value = String(poRate);
        rateInput.dataset.defaultRate = String(poRate);

        const rateReset = document.createElement('button');
        rateReset.type = 'button';
        rateReset.className = 'rate-reset-btn';
        rateReset.innerHTML = '&#8635;';
        rateReset.title = 'Reset rate to default';
        rateReset.style.display = 'none';

        const rateModDot = document.createElement('span');
        rateModDot.className = 'rate-mod-dot';
        rateModDot.title = 'Rate has been modified';
        rateModDot.style.display = 'none';

        const checkRateMod = () => {
            const defR = parseFloat(rateInput.dataset.defaultRate) || 0;
            const curR = parseFloat(rateInput.value) || 0;
            const isMod = Math.abs(curR - defR) > 0.0001;
            rateReset.style.display = isMod ? 'inline-flex' : 'none';
            rateModDot.style.display = isMod ? 'inline-block' : 'none';
        };

        rateReset.addEventListener('click', () => {
            rateInput.value = rateInput.dataset.defaultRate || '0';
            checkRateMod();
            rateInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        rateInput.addEventListener('input', (e) => {
            checkRateMod();
            onAmountChange(e);
        });

        rateWrap.appendChild(rateInput);
        rateWrap.appendChild(rateReset);
        rateWrap.appendChild(rateModDot);
        tdRate.appendChild(rateWrap);

        tr.appendChild(tdRate);
        tr.appendChild(buildDiscountCell({ value: soItem.discount, pct: soItem.discountPct }));

        // ---- TAX ----
        const tdTax = document.createElement('td');
        tdTax.className = 'tax-cell';
        const taxSel = document.createElement('select');

        taxSel.className = 'cell-input tax-input tax-select';

        // antigravity update with master tax preferences
        buildTaxSelect(
            taxSel,
            soItem,
            soItem.taxId || '',
            false,
            master
        );

        taxSel.addEventListener('change', onAmountChange);

        tdTax.appendChild(taxSel);
        tr.appendChild(tdTax);

        // antigravity update with searchable tax dropdown
        lkEnhance(taxSel, {
            placeholder: 'Select a Tax',
            emptyText: 'No taxes found',
            footer: [{
                icon: '+',
                label: 'New Tax',
                onClick: () => {
                    const dcExt = state.organizationDataCenterExtension || '.com';
                    window.open(`https://books.zoho${dcExt}/app#/settings/taxes/new`, '_blank', 'noopener,noreferrer');
                }
            }]
        });

        // ---- AMOUNT ----
        const tdAmount = document.createElement('td');
        tdAmount.className = 'amount-cell';
        tdAmount.style.textAlign = 'right';
        tdAmount.textContent = '0.00';
        tr.appendChild(tdAmount);

        tbody.appendChild(tr);

        // ---- Collapsible Item Master details row ----
        const trD = document.createElement('tr');
        trD.className = 'item-detail-row';
        trD.hidden = true;
        const tdD = document.createElement('td');
        tdD.colSpan = 7;
        tdD.appendChild(buildItemDetailPanel(soItem, master, tr));
        trD.appendChild(tdD);
        tbody.appendChild(trD);
        infoBtn.addEventListener('click', () => niRowMenu(infoBtn, soItem.itemId, tr));

        checkRateMod();
    });

    Object.values(state.extra).forEach((x) => paintExtraRow(x));
    wireAddRow();
    recalculateAllAmounts();
    applyItemModes();
}

// ============================================================
// PAYMENT TERMS
// ============================================================

const PT = { terms: [], local: [], loaded: false, touched: false, error: '' };
const PT_FALLBACK = [[0, 'Due on Receipt'], [15, 'Net 15'], [30, 'Net 30'], [45, 'Net 45'], [60, 'Net 60']];

function ptNorm(t) {
    const n = Number(t.payment_terms);
    const days = isFinite(n) ? n : 0;
    return {
        id: String(t.payment_terms_id || ('x_' + t.payment_terms_label)),
        days,
        label: t.payment_terms_label || (days === 0 ? 'Due on Receipt' : 'Net ' + days),
        isDefault: !!t.is_default
    };
}

async function ptLoad(force) {
    if (PT.loaded && !force) return;
    try {
        const j = await zbApi('GET', '/settings/paymentterms');
        const list = (j.data && j.data.payment_terms) || j.payment_terms || [];
        PT.terms = list.map(ptNorm);
        PT.error = '';
    } catch (err) {
        PT.terms = [];
        PT.error = err.message || 'Request failed';
        logError('PAYMENT_TERMS', 'Could not load payment terms, using built-in list', err);
    }
    PT.loaded = true;
}

function ptList() {
    const base = PT.terms.length
        ? PT.terms
        : PT_FALLBACK.map((t) => ({ id: 'local_' + t[0], days: t[0], label: t[1], isDefault: t[0] === 0 }));
    return base.concat(PT.local);
}

function ptById(id) {
    return ptList().find((t) => t.id === String(id)) || null;
}

function ptFill(selectedId) {
    const sel = $('pay-terms');
    if (!sel) return;
    const cur = String(selectedId !== undefined ? selectedId : sel.value);
    const list = ptList();
    nvFill(sel, list.map((t) => [t.id, t.label]), 'Select payment terms');
    sel.value = list.some((t) => t.id === cur) ? cur : '';
    if (sel._sync) sel._sync();
}

async function ptRefresh(selectedId) {
    await ptLoad(true);
    ptFill(selectedId);
}

function ptPayload(id) {
    const t = ptById(id);
    return t ? { payment_terms: t.days, payment_terms_label: t.label } : {};
}

function ptMatchVendor(v) {
    const list = ptList();
    const lab = String(v.paymentTermsLabel || '').toLowerCase();
    let t = lab ? list.find((x) => x.label.toLowerCase() === lab) : null;
    if (!t && v.paymentTerms !== '' && v.paymentTerms != null) {
        const d = Number(v.paymentTerms);
        t = list.find((x) => x.days === d) || null;
    }
    return t;
}

async function ptApplyVendor(vendor) {
    if (PT.touched || !$('pay-terms')) return;
    let v = vendor;
    if (v.paymentTermsLabel === undefined) {
        try { const full = await fetchVendorById(v.id); if (full) v = full; } catch (e) { /* keep list data */ }
    }
    if (PT.touched || dom.vendorId.value !== v.id) return;
    const t = ptMatchVendor(v);
    if (t) ptFill(t.id);
}

async function initPaymentTerms() {
    const sel = $('pay-terms');
    if (!sel) return;
    await ptLoad(false);
    const def = ptList().find((t) => t.isDefault);
    ptFill(def ? def.id : '');

    lkEnhance(sel, {
        placeholder: 'Select payment terms',
        emptyText: 'No payment terms found',
        footer: [
            { icon: '+', label: 'New Payment Term', onClick: () => ptOpenEditor(null, { select: true }) },
            { icon: '\u2699', label: 'Configure Terms', onClick: ptOpenManager }
        ]
    });
    sel.addEventListener('change', () => { PT.touched = true; markDirty(); });
}

function ptOpenEditor(term, opts) {
    opts = opts || {};
    const old = $('pte-modal');
    if (old) old.remove();

    const ov = document.createElement('div');
    ov.id = 'pte-modal';
    ov.className = 'nv-overlay';
    ov.style.zIndex = '21000';
    ov.innerHTML =
        '<div class="nv-box" role="dialog" aria-modal="true" style="max-width:460px">' +
        '<div class="nv-head"><h3>' + (term ? 'Edit Payment Term' : 'New Payment Term') + '</h3>' +
        '<button type="button" class="nv-x" data-x aria-label="Close">&times;</button></div>' +
        '<div class="nv-body">' +
        '<div class="nv-row"><label class="nv-l req" for="pte_name">Term Name*</label>' +
        '<div class="nv-c"><input type="text" id="pte_name" class="nv-main" maxlength="100" autocomplete="off"></div></div>' +
        '<div class="nv-row"><label class="nv-l req" for="pte_days">Due after (days)*</label>' +
        '<div class="nv-c"><input type="text" id="pte_days" class="nv-sm" inputmode="numeric" maxlength="3" autocomplete="off"></div></div>' +
        '</div>' +
        '<div class="nv-foot"><button type="button" class="btn btn-primary" data-save>Save</button>' +
        '<button type="button" class="btn btn-secondary" data-cancel>Cancel</button>' +
        '<span class="nv-status"></span></div></div>';
    document.body.appendChild(ov);

    const name = ov.querySelector('#pte_name');
    const days = ov.querySelector('#pte_days');
    const save = ov.querySelector('[data-save]');
    const status = ov.querySelector('.nv-status');
    name.value = term ? term.label : '';
    days.value = term ? String(term.days) : '';

    let saving = false;
    const close = () => { if (!saving) ov.remove(); };

    async function go() {
        if (saving) return;
        const n = name.value.trim(), raw = days.value.trim();
        nvMark(name, ''); nvMark(days, '');
        let ok = true;

        if (!n) { nvMark(name, 'Term name is required'); ok = false; }
        else if (ptList().some((t) => (!term || t.id !== term.id) && t.label.toLowerCase() === n.toLowerCase())) {
            nvMark(name, 'A payment term with this name already exists'); ok = false;
        }

        const d = parseInt(raw, 10);
        if (!raw) { nvMark(days, 'Due after is required'); ok = false; }
        else if (!/^\d+$/.test(raw) || d < 1 || d > 999) { nvMark(days, 'Enter whole days between 1 and 999'); ok = false; }

        if (!ok) { (name.classList.contains('invalid') ? name : days).focus(); return; }

        saving = true;
        save.disabled = true;
        status.textContent = 'Saving…';
        const payload = { payment_terms: d, payment_terms_label: n };
        log('PAYMENT_TERMS', term ? 'Updating' : 'Creating', payload);

        try {
            await zbApi(term ? 'PUT' : 'POST', '/settings/paymentterms' + (term ? '/' + term.id : ''), {}, payload);
        } catch (err) {
            await ptLoad(true);
            const landed = ptList().some((t) => t.label.toLowerCase() === n.toLowerCase() && (!term || t.id === term.id));
            if (!landed) {
                logError('PAYMENT_TERMS', 'Save failed', err);
                saving = false;
                save.disabled = false;
                status.textContent = 'Save failed: ' + (err.message || 'Request failed');
                return;
            }
        }

        await ptLoad(true);
        let hit = PT.terms.find((t) => t.label.toLowerCase() === n.toLowerCase());
        if (!hit && !term) {
            hit = { id: 'local_' + Date.now(), days: d, label: n, isDefault: false };
            PT.local.push(hit);
        }

        const keep = $('pay-terms') ? $('pay-terms').value : '';
        if (opts.select && hit) { PT.touched = true; ptFill(hit.id); markDirty(); }
        else ptFill(keep);

        saving = false;
        ov.remove();
        if (opts.after) opts.after();
    }

    ov.querySelector('[data-x]').addEventListener('click', close);
    ov.querySelector('[data-cancel]').addEventListener('click', close);
    save.addEventListener('click', go);
    ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) close(); });
    ov.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
        else if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); go(); }
    });
    setTimeout(() => name.focus(), 30);
}

function ptOpenManager() {
    const old = $('ptm-modal');
    if (old) old.remove();

    const ov = document.createElement('div');
    ov.id = 'ptm-modal';
    ov.className = 'nv-overlay';
    ov.style.zIndex = '20500';
    ov.innerHTML =
        '<div class="nv-box ptm-box" role="dialog" aria-modal="true">' +
        '<div class="nv-head"><h3>Configure Payment Terms</h3>' +
        '<button type="button" class="nv-x" data-x aria-label="Close">&times;</button></div>' +
        '<div class="nv-body">' +
        '<button type="button" class="btn btn-primary ptm-new">+ New Payment Term</button>' +
        '<div class="ptm-err" hidden></div><div class="ptm-note" hidden></div>' +
        '<div class="ptm-th"><span>TERM NAME</span><span>DAYS</span><span></span></div>' +
        '<div class="ptm-rows"></div></div>' +
        '<div class="nv-foot"><button type="button" class="btn btn-secondary" data-close>Close</button></div></div>';
    document.body.appendChild(ov);

    const rows = ov.querySelector('.ptm-rows');
    const err = ov.querySelector('.ptm-err');
    const note = ov.querySelector('.ptm-note');
    let busy = false;

    const close = () => ov.remove();
    const showErr = (m) => { err.textContent = m || ''; err.hidden = !m; };

    function paint() {
        rows.innerHTML = '';
        const synced = {};
        PT.terms.forEach((t) => { synced[t.id] = 1; });
        note.hidden = PT.terms.length > 0;
        note.textContent = PT.terms.length ? '' : 'Payment terms could not be loaded from Zoho Books, so the built-in list is shown. Editing is disabled.';

        const list = ptList();
        if (!list.length) { rows.innerHTML = '<div class="ptm-msg">No payment terms found</div>'; return; }

        list.forEach((t) => {
            const r = document.createElement('div');
            r.className = 'ptm-row';

            const nm = document.createElement('span');
            nm.textContent = t.label;
            const tag = (txt) => { const e = document.createElement('em'); e.className = 'ptm-tag'; e.textContent = txt; nm.appendChild(e); };
            if (t.isDefault) tag('Default');
            if (t.days < 0) tag('System');
            else if (!synced[t.id] && PT.local.indexOf(t) > -1) tag('Not synced');
            r.appendChild(nm);

            const dy = document.createElement('span');
            dy.textContent = t.days < 0 ? '\u2014' : String(t.days);
            r.appendChild(dy);

            const act = document.createElement('span');
            act.className = 'ptm-acts';
            const btn = (txt, fn) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = txt;
                b.addEventListener('click', fn);
                act.appendChild(b);
            };
            if (synced[t.id] && t.days >= 0) {
                btn('\u270e Edit', () => ptOpenEditor(t, { after: paint }));
                btn('\ud83d\uddd1 Delete', () => del(t));
            } else if (PT.local.indexOf(t) > -1) {
                btn('\ud83d\uddd1 Remove', () => {
                    const cur = $('pay-terms').value;
                    PT.local = PT.local.filter((x) => x !== t);
                    ptFill(cur === t.id ? '' : cur);
                    paint();
                });
            }
            r.appendChild(act);
            rows.appendChild(r);
        });
    }

    async function del(t) {
        if (busy) return;
        const cur = $('pay-terms') ? $('pay-terms').value : '';
        if (cur === String(t.id)) {
            const inUseConfirm = await adConfirm(
                'Payment Term In Use',
                `"${t.label}" is currently selected for this Purchase Order. Deleting it will clear the payment term for this order. Continue?`
            );
            if (!inUseConfirm) return;
        } else {
            if (!(await adConfirm('Delete payment term', 'Delete "' + t.label + '"?'))) return;
        }
        busy = true;
        showErr('');
        try {
            await zbApi('DELETE', '/settings/paymentterms/' + t.id);
            await ptRefresh(cur === t.id ? '' : cur);
        } catch (e) {
            logError('PAYMENT_TERMS', 'Delete failed', e);
            showErr('Could not delete "' + t.label + '": ' + (e.message || 'Request failed'));
        }
        busy = false;
        paint();
    }

    ov.querySelector('.ptm-new').addEventListener('click', () => ptOpenEditor(null, { after: paint }));
    ov.querySelector('[data-x]').addEventListener('click', close);
    ov.querySelector('[data-close]').addEventListener('click', close);
    ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) close(); });
    ov.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } });

    paint();
    ptRefresh().then(paint);
}

// ============================================================
// CALCULATION
// ============================================================

function getRowInputs(lineItemId) {
    const tr = dom.itemsTbody.querySelector(`tr[data-line-item-id="${lineItemId}"]`);
    if (!tr) return null;
    return {
        tr,
        desc: tr.querySelector('.desc-input'),
        account: tr.querySelector('.acc-select'),
        qty: tr.querySelector('.qty-input'),
        rate: tr.querySelector('.rate-input'),
        discount: tr.querySelector('.discount-input'),
        tax: tr.querySelector('.tax-input'),
        amount: tr.querySelector('.amount-cell')
    };
}

// antigravity update with line-item tax decomposition for Zoho Books breakdown
function getTaxComponents(tax, lineTaxAmount, fallbackPct = 0) {
    if (lineTaxAmount <= 0) return [];

    // 1) If tax object is found and has explicit sub taxes in raw
    if (tax && tax.raw) {
        const subList = tax.raw.tax_components || tax.raw.taxes || tax.raw.sub_taxes || tax.raw.sub_tax_details;
        if (Array.isArray(subList) && subList.length > 0) {
            const totalPct = subList.reduce((s, c) => s + (parseFloat(c.tax_percentage || c.percentage || c.pct) || 0), 0) || tax.pct;
            let sumSoFar = 0;
            return subList.map((c, idx) => {
                const cPct = parseFloat(c.tax_percentage || c.percentage || c.pct) || 0;
                const cName = c.tax_name || c.name || '';
                const label = cName.includes('[') ? cName : `${cName} [${cPct}%]`;
                let cAmt = 0;
                if (idx === subList.length - 1) {
                    cAmt = r2(lineTaxAmount - sumSoFar);
                } else {
                    cAmt = totalPct > 0 ? r2((lineTaxAmount * cPct) / totalPct) : 0;
                    sumSoFar = r2(sumSoFar + cAmt);
                }
                return { name: label, amount: cAmt, pct: cPct };
            });
        }
    }

    const tName = tax ? tax.name : '';
    const tPct = tax ? tax.pct : fallbackPct;
    const isIntra = tax ? isIntraStateTax(tax) : !/igst|inter/i.test(tName);

    // 2) Intra-state tax group (e.g. GST18, GST5, GST12, GST28, or tax_group)
    // Indian GST splits equally into CGST and SGST
    if (isIntra || (tax && tax.type === 'tax_group') || /^(gst|cgst|sgst)/i.test(tName)) {
        const halfPct = tPct / 2;
        const rateStr = (Math.round(halfPct * 100) / 100).toString();
        const halfAmt = r2(lineTaxAmount / 2);
        const otherAmt = r2(lineTaxAmount - halfAmt);
        return [
            { name: `CGST${rateStr} [${rateStr}%]`, amount: halfAmt, pct: halfPct },
            { name: `SGST${rateStr} [${rateStr}%]`, amount: otherAmt, pct: halfPct }
        ];
    }

    // 3) Inter-state tax (e.g. IGST18 [18%], IGST5 [5%]) or single tax
    const label = tName.includes('[') ? tName : `${tName || 'Tax'} [${tPct}%]`;
    return [
        { name: label, amount: lineTaxAmount, pct: tPct }
    ];
}
function recalculateAllAmounts() {
    const m = state.mode;
    const incl = !!m.taxInclusive;
    const lineOn = m.discountType !== 'entity_level';
    const txOn = m.discountType !== 'item_level';
    const rows = [];

    // 1) line amounts (line discount applies only in line-level modes)
    allRows().forEach((a) => {
        const inputs = getRowInputs(a.lineItemId);
        if (!inputs) return;
        const qty = parseFloat(inputs.qty.value) || 0;
        const rate = parseFloat(inputs.rate.value) || 0;
        // const gross = r2(qty * rate);
        // const lineDisc = lineOn
        //     ? r2(Math.min(Math.max(0, rowDiscountAmount(inputs, gross)), gross))
        //     : 0;
        // rows.push({ inputs, pct: rowTaxPct(inputs.tax), gross, lineDisc, net: r2(gross - lineDisc) });
        const gross = r2(qty * rate);
        const pct = rowTaxPct(inputs.tax);
        let lineDisc;
        let net;
        if (incl && lineOn && m.discountBeforeTax && pct > 0) {
            // Tax Inclusive + discount BEFORE tax: discount comes off the tax-exclusive amount,
            // GST is recalculated on the discounted taxable amount, then added back.
            // rowDiscountAmount(inputs, ex) handles % (of the tax-exclusive amount) and fixed amounts.
            const ex = r2(gross / (1 + pct / 100));
            lineDisc = r2(Math.min(Math.max(0, rowDiscountAmount(inputs, ex)), ex));
            const taxable = r2(ex - lineDisc);
            net = r2(taxable + r2((taxable * pct) / 100));
        } else {
            // Tax Exclusive, or Tax Inclusive with discount AFTER tax: unchanged behaviour
            lineDisc = lineOn
                ? r2(Math.min(Math.max(0, rowDiscountAmount(inputs, gross)), gross))
                : 0;
            net = r2(gross - lineDisc);
        }
        rows.push({ inputs, pct, gross, lineDisc, net });
    });

    // 2) Sub Total = sum of line amounts (tax-inclusive amounts when Tax Inclusive)
    const base = r2(rows.reduce((s, r) => s + r.net, 0));

    const tx = readTxDiscount();
    const txIn = $('tx-disc');
    if (txIn) {
        const bad = tx.value < 0 || (tx.pct && tx.value > 100) || (!tx.pct && tx.value > base);
        txIn.classList.toggle('error', txOn && bad);
    }

    let entDisc = 0;
    let taxTotal = 0;
    let appliedOn = null;                 // base the % discount is applied on (shown as "Applied On")
    let preWh = 0;                        // amount after discount, including tax, before TDS/TCS and adjustment
    let whtBase = 0;                      // tax-exclusive amount after discount (TDS base)
    const componentMap = new Map();
    const addComponent = (name, amount) => {
        if (!componentMap.has(name)) componentMap.set(name, { name, amount: 0 });
        componentMap.get(name).amount = r2(componentMap.get(name).amount + amount);
    };
    const taxFor = (r) => {
        let t = state.taxes.find((x) => String(x.id) === String(r.inputs.tax.value));
        if (!t && r.pct > 0) t = state.taxes.find((x) => x.pct === r.pct);
        return t;
    };

    // spreads an amount across lines in proportion to a weight (last line absorbs rounding)
    const spread = (total, weight) => {
        const sum = rows.reduce((s, r) => s + weight(r), 0);
        let lastIdx = -1;
        rows.forEach((r, i) => { if (weight(r) > 0) lastIdx = i; });
        let left = total;
        rows.forEach((r, i) => {
            const w = weight(r);
            if (sum <= 0 || w <= 0) { r.share = 0; return; }
            r.share = (i === lastIdx) ? left : Math.min(left, r2((total * w) / sum));
            left = r2(left - r.share);
        });
    };

    if (!incl) {
        // ===== TAX EXCLUSIVE (unchanged behaviour) =====
        entDisc = txOn
            ? (tx.pct ? (base * Math.min(Math.max(tx.value, 0), 100)) / 100 : tx.value)
            : 0;
        entDisc = r2(Math.min(Math.max(0, entDisc), base));
        spread(entDisc, (r) => r.net);

        rows.forEach((r) => {
            const taxable = m.discountBeforeTax ? r2(r.net - r.share) : r.net;
            r.tax = r2((taxable * r.pct) / 100);
            r.inputs.amount.textContent = r.net.toFixed(2);
            taxTotal += r.tax;
            if (r.tax > 0) {
                getTaxComponents(taxFor(r), r.tax, r.pct).forEach((c) => addComponent(c.name, c.amount));
            }
        });
        taxTotal = r2(taxTotal);
        whtBase = r2(base - entDisc);
        preWh = r2(base - entDisc + taxTotal);
    } else {
        // ===== TAX INCLUSIVE (matches Zoho Books) =====
        const before = !!m.discountBeforeTax;

        // taxable (tax-exclusive) amount of every line, from its inclusive amount and its own rate
        rows.forEach((r) => { r.ex = r.pct > 0 ? r.net / (1 + r.pct / 100) : r.net; });
        const exBase = rows.reduce((s, r) => s + r.ex, 0);
        const p = tx.pct ? Math.min(Math.max(tx.value, 0), 100) : 0;
        const hasDisc = txOn && tx.value > 0;

        if (before) {
            // BEFORE TAX: % discount is on the tax-exclusive base; it reduces every line's taxable amount,
            // so the tax is recalculated on what is left.
            appliedOn = exBase;
            if (hasDisc) {
                entDisc = tx.pct ? (exBase * p) / 100 : Math.max(0, tx.value);
                entDisc = r2(Math.min(entDisc, exBase));
            }
            spread(entDisc, (r) => r.ex);
            rows.forEach((r) => { r.taxableAfter = r.ex - r.share; });
        } else {
            // AFTER TAX: % discount is on the tax-inclusive Sub Total; the tax stays on the full taxable base.
            if (hasDisc) {
                entDisc = tx.pct ? (base * p) / 100 : Math.max(0, tx.value);
                entDisc = r2(Math.min(entDisc, base));
            }
            rows.forEach((r) => { r.taxableAfter = r.ex; });
        }

        // tax per tax-rate group; each component (CGST / SGST / IGST ...) is rounded separately, like Zoho
        const groups = new Map();
        rows.forEach((r) => {
            r.inputs.amount.textContent = r.net.toFixed(2);
            if (!(r.pct > 0)) return;
            const key = String(r.inputs.tax.value || ('pct_' + r.pct));
            if (!groups.has(key)) groups.set(key, { taxObj: taxFor(r), pct: r.pct, taxable: 0 });
            groups.get(key).taxable += r.taxableAfter;
        });
        groups.forEach((g) => {
            // getTaxComponents is used only for the component names and rates (amount 1 is a placeholder)
            getTaxComponents(g.taxObj, 1, g.pct).forEach((c) => {
                const amt = r2((g.taxable * c.pct) / 100);
                addComponent(c.name, amt);
                taxTotal += amt;
            });
        });
        taxTotal = r2(taxTotal);           // total tax = sum of the rounded components

        // amount payable after discount, tax already included
        preWh = before
            ? r2(r2(rows.reduce((s, r) => s + r.taxableAfter, 0)) + taxTotal)   // taxable + tax
            : r2(base - entDisc);                                                // inclusive total - discount
        // TDS base (Tax Inclusive):
        //  - discount applied AFTER tax (link shows "Apply before tax", m.discountBeforeTax === false):
        //    Zoho takes TDS on the full tax-exclusive amount (sum of line inclusive / (1 + own GST rate)),
        //    kept unrounded; the discount is NOT deducted from the TDS base.
        //  - discount applied BEFORE tax: unchanged (tax-exclusive amount after discount).
        whtBase = before ? r2(preWh - taxTotal) : exBase;
        // No transaction discount (discount-before-tax mode): payable = inclusive Sub Total exactly.
        // Avoids the +0.01 drift from rebuilding it as round(taxable) + round(tax).
        // (placed after whtBase so the TDS base is not affected)
        // if (before && !(entDisc > 0)) preWh = base;
    }

    // "Applied On" label under Discount (Before Tax percentage discounts only, as in Zoho)
    const timingLink = $('tx-disc-timing');
    if (timingLink && timingLink.parentElement) {
        let ap = $('tx-disc-applied');
        if (!ap) {
            ap = document.createElement('span');
            ap.id = 'tx-disc-applied';
            ap.className = 'tot-sub';
            timingLink.parentElement.insertBefore(ap, timingLink);
        }
        const show = incl && txOn && tx.pct && appliedOn !== null;
        ap.style.display = show ? 'block' : 'none';
        if (show) ap.textContent = '(Applied On ' + (Math.floor(appliedOn * 100 + 1e-6) / 100).toFixed(2) + ')';
    }

    // tax breakdown rows
    const breakdownContainer = $('tot-tax-breakdown-container');
    const totalTaxRow = $('tot-tax-total-row');
    const totalTaxInput = $('tot-tax-amount-val');

    if (breakdownContainer) {
        breakdownContainer.innerHTML = '';
        componentMap.forEach((comp) => {
            const rowEl = document.createElement('div');
            rowEl.className = 'tot-row tot-tax-comp-row';
            rowEl.innerHTML =
                '<div class="tot-lbl"><span class="tot-main tot-tax-comp-lbl">' + escapeHtml(comp.name) + '</span></div>' +
                '<div class="tot-val tot-tax-comp-val">' + comp.amount.toFixed(2) + '</div>';
            breakdownContainer.appendChild(rowEl);
        });
    }

    if (totalTaxRow) {
        if (taxTotal > 0 || componentMap.size > 0) {
            totalTaxRow.style.display = 'flex';
            if (totalTaxInput) totalTaxInput.value = taxTotal.toFixed(2);
        } else {
            totalTaxRow.style.display = 'none';
            if (totalTaxInput) totalTaxInput.value = '0.00';
        }
    }

    // labels
    const totalQty = rows.reduce((s, r) => s + (parseFloat(r.inputs.qty.value) || 0), 0);
    const qtyLbl = $('tot-qty-label');
    if (qtyLbl) {
        qtyLbl.textContent = 'Total Quantity : ' + (Math.round(totalQty * 100) / 100);
        qtyLbl.style.display = totalQty > 0 ? 'block' : 'none';
    }
    const taxIncLbl = $('tot-tax-inclusive-label');
    if (taxIncLbl) {
        taxIncLbl.textContent = '(Tax Inclusive)';
        taxIncLbl.style.display = incl ? 'block' : 'none';
    }

    // ---- TDS / TCS (withholding) ----
    // TDS : rate x tax-EXCLUSIVE amount after discount   (whtBase - unchanged, works in Zoho)
    // TCS : rate x TOTAL payable after discount INCLUDING tax (preWh) - Zoho collects TCS on the tax-inclusive amount
    // Rate always comes from the selected option / configured tax list. Nothing is hardcoded.
    // Rounding is half-up on the finished amount (same as Zoho), immune to float errors such as 1.005 -> 1.00.
    const whRound = (n) => {
        const sign = n < 0 ? -1 : 1;
        return (sign * Math.round(Number((Math.abs(n) * 100).toPrecision(12)))) / 100;
    };

    const isTcs = (typeof txMode === 'function' ? txMode() : 'tds') === 'tcs';
    const tdsSel = $('tot-tds-select');

    let whPct = 0;
    if (tdsSel && tdsSel.value) {
        const o = (tdsSel.selectedOptions && tdsSel.selectedOptions[0]) ||
            (tdsSel.options && tdsSel.selectedIndex >= 0 && tdsSel.options[tdsSel.selectedIndex]);
        whPct = o ? (parseFloat(o.dataset.pct) || 0) : 0;
        if (!whPct) {   // fallback: read the rate from the configured TDS/TCS list
            const cfg = (typeof txList === 'function' ? txList(isTcs ? 'tcs' : 'tds') : [])
                .find((t) => String(t.id) === String(tdsSel.value));
            whPct = cfg ? (parseFloat(cfg.pct) || 0) : 0;
        }
    }

    // Base per withholding type (never shared between TDS and TCS)
    const tdsBase = Math.max(0, whtBase);           // after discount, excluding tax
    // TCS base (Zoho Books): tax-inclusive amount after discount PLUS the Adjustment (+ or -).
    // TDS base is not affected by the adjustment.
    const tcsAdj = parseFloat(($('tot-adj-val') || {}).value) || 0;
    const tcsBase = Math.max(0, r2(preWh + tcsAdj));
        const withholdingBase = isTcs ? tcsBase : tdsBase;

    

    const tdsAmt = whPct > 0 ? whRound((withholdingBase * whPct) / 100) : 0;

    const tdsValEl = $('total-tds');
    if (tdsValEl) tdsValEl.textContent = (isTcs ? '+ ' : '- ') + tdsAmt.toFixed(2);

    const adjInput = $('tot-adj-val');
    const adjVal = adjInput ? (parseFloat(adjInput.value) || 0) : 0;
    const adjValEl = $('total-adjustment');
    if (adjValEl) adjValEl.textContent = adjVal.toFixed(2);

    // grand total: preWh already contains tax in both modes, so tax is never added twice
    // TDS reduces the payable amount, TCS increases it
    const grand = whRound(preWh + (isTcs ? tdsAmt : -tdsAmt) + adjVal);

    const curLbl = $('tot-currency-lbl');
    if (curLbl) curLbl.textContent = 'Total ( ' + curSym() + ' )';

    setText(dom.totalSubtotal, base.toFixed(2));
    setText(dom.totalDiscount, entDisc.toFixed(2));
    setText(dom.totalTax, taxTotal.toFixed(2));
    setText(dom.totalGrand, grand.toFixed(2));
}
function onQuantityChange(e) {
    const input = e.target;
    const hasMax = input.dataset.maxQty !== undefined;
    const maxQty = parseFloat(input.dataset.maxQty) || 0;
    const entered = parseFloat(input.value);

    let msg = '';
    if (input.value !== '' && isNaN(entered)) msg = 'Enter a valid quantity.';
    else if (entered < 0) msg = 'Quantity cannot be negative.';
    else if (hasMax && entered > maxQty) msg = `Only ${maxQty} quantity is available for this item.`;
    else if (!hasMax && !(entered > 0)) msg = 'Quantity must be greater than zero.';

    input.classList.toggle('error', !!msg);
    input.title = msg || ((hasMax && (entered === 0 || input.value === '')) ? 'Quantity is 0: this item will not be included in the PO.' : '');

    flagAmountInputs(input.closest('tr'));
    markDirty();
    recalculateAllAmounts();
}

function onAmountChange(e) {
    flagAmountInputs(e && e.target ? e.target.closest('tr') : null);
    markDirty();
    recalculateAllAmounts();
}

// ============================================================
// VALIDATION
// ============================================================

function collectFormData() {
    const m = state.mode;
    const multi = m.selection === 'multiple' && state.locations.length > 0;

    const lineItems = allRows().map((a) => {
        const inputs = getRowInputs(a.lineItemId);
        if (!inputs) return null;
        const soItem = state.salesOrder.lineItems.find((li) => li.lineItemId === a.lineItemId) || state.extra[a.lineItemId] || {};
        const locSel = inputs.tr.querySelector('.loc-select');
        const lineDiscOn = m.discountType !== 'entity_level';
        const accId = inputs.account ? inputs.account.value : '';

        return {
            lineItemId: a.lineItemId,
            extra: !!state.extra[a.lineItemId],
            itemId: a.itemId,
            name: a.name,
            description: inputs.desc.value,
            accountId: accId || undefined,
            locationId: multi
                ? (locSel ? locSel.value : '')
                : ($('tb-wh') ? $('tb-wh').value : ''), poQuantity: parseFloat(inputs.qty.value) || 0,
            rate: parseFloat(inputs.rate.value) || 0,
            discount: lineDiscOn ? (parseFloat(inputs.discount.value) || 0) : 0,
            discountPct: lineDiscOn && inputs.discount.dataset.pct === '1',
            taxId: inputs.tax.value || null,
            taxPercentage: rowTaxPct(inputs.tax),
            unit: soItem.unit || '',
            hsn: soItem.hsn || ''
        };
    }).filter(Boolean);

    const tx = readTxDiscount();
    return {
        vendorId: dom.vendorId.value,
        locationId: $('po-location') ? $('po-location').value : '',
        deliverTo: deliverMode(),
        deliveryTargetId: $('delivery-target') ? $('delivery-target').value : '',
        paymentTermId: $('pay-terms') ? $('pay-terms').value : '',
        shipVia: ($('delivery-method') ? $('delivery-method').value : '').trim(),
        reverseCharge: ($('reverse-charge') ? $('reverse-charge').checked : false) || vendorNeedsReverseCharge(),
        date: dom.orderDate.value,
        deliveryDate: dom.deliveryDate.value,
        taxInclusive: m.taxInclusive,
        discountType: m.discountType,
        multiLocation: multi,
        txDiscountValue: tx.value,
        txDiscountPct: tx.pct,
        txDiscount: tx.value > 0 ? (tx.pct ? tx.value + '%' : tx.value) : 0,
        discountBeforeTax: m.discountBeforeTax,
        currencySymbol: (state.salesOrder && state.salesOrder.currencySymbol) || (state.org && state.org.currency_symbol) || '₹',
        currencyCode: (state.salesOrder && state.salesOrder.currencyCode) || (state.org && state.org.currency_code) || 'INR',
        adjustment: $('tot-adj-val') ? (parseFloat($('tot-adj-val').value) || 0) : 0,
        adjustmentDescription: $('tot-adj-box') ? $('tot-adj-box').textContent.trim() : 'Adjustment',
        tdsTaxId: $('tot-tds-select') ? $('tot-tds-select').value : '',
        isTds: typeof txMode === 'function' ? txMode() === 'tds' : true,
        lineItems,
        notes: dom.notes.value,
        terms: dom.terms.value
    };
}

// antigravity update with GST validation before create
function validateGstBeforeCreate(formData) {
    const errors = [];
    if (!orgHasGst()) return errors;

    const vendor = getVendorGstInfo();
    const dest = getDeliveryLocationGstInfo();
    const supply = determineGstSupplyType();

    // 1. Verify Vendor GSTIN if registered
    if (vendor.isRegistered && vendor.gstin) {
        const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;
        if (!GSTIN_RE.test(vendor.gstin)) {
            errors.push({
                message: `Vendor "${vendor.contactName || 'Vendor'}" has an invalid GSTIN format (${vendor.gstin}). Must be 15 alphanumeric characters.`
            });
        }
    }

    // 2. Verify Delivery Location State Code
    if (!dest.stateCode) {
        errors.push({
            message: 'Unable to determine the Delivery Location state code. Please verify the delivery address or warehouse location.'
        });
    }
    if (!vendor.isOverseas && !vendor.stateCode) {
        errors.push({
            message: 'Unable to determine the vendor Source of Supply. Select it in the Source of Supply field.'
        });
    }

    // 3. Line Items GST compliance check
    const isRcm = formData.reverseCharge === true || supply.isRcm;

    formData.lineItems.forEach((li) => {
        if (li.poQuantity <= 0) return;

        const rawTaxId = li.taxId || '';
        const isExemption = typeof rawTaxId === 'string' && rawTaxId.startsWith('exemption:');

        if (/^__/.test(rawTaxId)) {
            errors.push({
                message: `${li.name || 'Item'}: ${rawTaxId === '__nontaxable__' ? 'Choose the exemption reason for the Non-Taxable item.' : 'The tax is still being applied. Please wait a moment and try again.'}`,
                rowId: li.lineItemId
            });
            return;
        }
        // Non-taxable or exemption line item
        if (!rawTaxId || isExemption) {
            return;
        }

        const tax = state.taxes.find((t) => String(t.id) === String(rawTaxId));
        if (!tax) return;

        // Check against supply.taxCategory
        if (supply.taxCategory === 'none') {
            if (!isRcm && tax.pct > 0) {
                errors.push({
                    message: `${li.name || 'Item'}: Purchases from unregistered vendors without Reverse Charge cannot charge GST (${tax.name}). Please select "No Tax (0%)" or enable Reverse Charge.`,
                    rowId: li.lineItemId
                });
            }
        } else if (supply.taxCategory === 'inter') {
            const hasInter = state.taxes.some(isInterStateTax);
            if (hasInter && isIntraStateTax(tax)) {
                errors.push({
                    message: `${li.name || 'Item'}: ${supply.description} requires IGST. Intra-state tax (${tax.name}) cannot be applied.`,
                    rowId: li.lineItemId
                });
            }
        } else if (supply.taxCategory === 'intra') {
            if (isInterStateTax(tax)) {
                errors.push({
                    message: `${li.name || 'Item'}: ${supply.description} requires CGST + SGST. Inter-state IGST (${tax.name}) cannot be applied.`,
                    rowId: li.lineItemId
                });
            }
        }
    });

    return errors;
}

function validateBeforeCreate(formData, freshAllocations) {
    const errors = [];

    if (!formData.vendorId) errors.push({ message: 'Please select a vendor.' });
    if (!formData.lineItems.some((li) => li.poQuantity > 0)) {
        errors.push({ message: 'At least one line item must have a quantity greater than zero.' });
    }
    if (state.locations.length && !formData.locationId && !formData.multiLocation) {
        errors.push({ message: 'Please select a location.' });
    }

    formData.lineItems.forEach((li) => {
        if (li.extra) {
            const add = (m) => errors.push({ message: `${li.name || 'New row'}: ${m}`, rowId: li.lineItemId });
            if (!li.itemId) {
                add('select an item from the Item Master.');
                return;
            }
            if (li.poQuantity < 0) add('quantity cannot be negative.');
            if (li.rate < 0) add('rate cannot be negative.');
            const maxD = li.discountPct ? 100 : li.poQuantity * li.rate;
            if (li.discount < 0 || li.discount > maxD) add('discount cannot be negative or exceed the line amount.');
            return;
        }

        const alloc = freshAllocations[li.lineItemId];
        if (!alloc) return;

        if (li.poQuantity < 0) {
            errors.push({ message: `${alloc.name}: quantity cannot be negative.`, rowId: li.lineItemId });
            return;
        }
        if (alloc.overAllocated && li.poQuantity > 0) {
            errors.push({ message: `${alloc.name} is OVER-ALLOCATED (${alloc.allocatedQuantity}/${alloc.salesOrderQuantity} ordered). No further quantity can be purchased.`, rowId: li.lineItemId });
            return;
        }
        if (li.poQuantity > alloc.remainingQuantity) {
            errors.push({ message: `${alloc.name}: Only ${alloc.remainingQuantity} quantity is available for this item.`, rowId: li.lineItemId });
            return;
        }

        if (li.poQuantity > 0) {
            if (li.rate < 0) errors.push({ message: `${alloc.name}: rate cannot be negative.`, rowId: li.lineItemId });
            const maxDisc = li.discountPct ? 100 : li.poQuantity * li.rate;
            if (li.discount < 0 || li.discount > maxDisc) {
                errors.push({ message: `${alloc.name}: discount cannot be negative or exceed the line amount.`, rowId: li.lineItemId });
            }
        }
    });

    if (formData.txDiscountValue < 0) errors.push({ message: 'Transaction discount cannot be negative.' });
    if (formData.txDiscountPct && formData.txDiscountValue > 100) {
        errors.push({ message: 'Transaction discount cannot exceed 100%.' });
    }
    if (formData.txDiscountValue > 0 && !formData.txDiscountPct) {
        const net = formData.lineItems.reduce((s, li) => {
            const g = li.poQuantity * li.rate;
            return s + g - (li.discountPct ? (g * li.discount) / 100 : li.discount);
        }, 0);
        if (formData.txDiscountValue > net) errors.push({ message: 'Transaction discount cannot exceed the line total.' });
    }

    if (formData.multiLocation) {
        const parentId = formData.locationId;

        formData.lineItems.forEach((li) => {
            if (li.poQuantity <= 0) return;

            if (!li.locationId) {
                errors.push({
                    message: `${li.name || 'Item'}: select a warehouse location.`,
                    rowId: li.lineItemId
                });
                return;
            }

            const allowed = getLocationBranch(parentId, true);

            const valid = allowed.some(
                (loc) => String(loc.id) === String(li.locationId)
            );

            if (!valid) {
                errors.push({
                    message: `${li.name || 'Item'}: selected warehouse does not belong to the selected parent location.`,
                    rowId: li.lineItemId
                });
            }
        });
    }

    // antigravity update with GST validation before create
    const gstErrors = validateGstBeforeCreate(formData);
    if (gstErrors && gstErrors.length > 0) {
        errors.push(...gstErrors);
    }

    return errors;
}

function showValidationErrors(errors) {
    document.querySelectorAll('.row-err-msg').forEach((e) => e.remove());
    document.querySelectorAll('tr.row-err').forEach((t) => t.classList.remove('row-err'));

    if (!errors || errors.length === 0) {
        dom.validationErrors.style.display = 'none';
        return;
    }
    errors.forEach((e) => {
        if (!e.rowId) return;
        const tr = dom.itemsTbody.querySelector('tr[data-line-item-id="' + e.rowId + '"]');
        if (!tr) return;
        tr.classList.add('row-err');
        const d = document.createElement('div');
        d.className = 'row-err-msg';
        d.textContent = e.message;
        (tr.querySelector('.zb-item-content') || tr.firstElementChild).appendChild(d);
    });

    dom.validationErrors.innerHTML =
        `<h4>Please fix the following:</h4><ul>` +
        errors.map((e) => `<li>${escapeHtml(e.message)}</li>`).join('') +
        `</ul>`;
    dom.validationErrors.style.display = 'block';
    dom.validationErrors.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Shows a Zoho Books error inside the form. The form stays open and editable. */
function showZohoError(err) {
    document.querySelectorAll('.row-err-msg').forEach((e) => e.remove());
    document.querySelectorAll('tr.row-err').forEach((t) => t.classList.remove('row-err'));

    const code = err && err.zohoCode !== undefined ? ' (code ' + err.zohoCode + ')' : '';
    dom.validationErrors.innerHTML =
        '<h4>Zoho Books could not save this Purchase Order' + escapeHtml(code) + '</h4>' +
        '<ul><li>' + escapeHtml((err && err.message) || 'Unknown error from Zoho Books.') + '</li></ul>';
    dom.validationErrors.style.display = 'block';
    dom.validationErrors.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setText(dom.footerStatus, 'Zoho Books rejected the request. Fix the issue and try again.');
}


// antigravity update with GST destination of supply fallback
/** GST fields Zoho's own PO form sends: vendor GST treatment / GSTIN and destination of supply. */
function poGstFields(formData) {
    const out = {};
    if (!orgHasGst()) return out;

    const vendor = getVendorGstInfo();
    if (vendor && vendor.treatment) {
        out.gst_treatment = vendor.treatment;
        if (vendor.gstin) out.gst_no = vendor.gstin;
    } else {
        const c = (VA.contact && String(VA.contact.contact_id) === String(formData.vendorId)) ? VA.contact : null;
        if (c) {
            if (c.gst_treatment) out.gst_treatment = c.gst_treatment;
            if (c.gst_no) out.gst_no = c.gst_no;
        }
    }

    const dest = getDeliveryLocationGstInfo();
    const destAlpha = gstAlpha(dest && dest.stateCode);
    if (destAlpha) out.destination_of_supply = destAlpha;
    const srcAlpha = gstAlpha(vendor && vendor.stateCode);
    if (srcAlpha) out.source_of_supply = srcAlpha;

    if (!out.destination_of_supply) {
        const loc = findLocationById(formData.deliveryTargetId) || findLocationById(formData.locationId);
        let name = loc && loc.state ? String(loc.state).trim().toLowerCase() : '';
        if (!name && state.org) {
            name = String(state.org.state_code || state.org.state || (state.org.address && state.org.address.state) || '').trim().toLowerCase();
        }
        if (name) {
            const st = NV_STATES.find((s) => s[1].toLowerCase() === name || s[0].toLowerCase() === name);
            if (st) out.destination_of_supply = st[0];
            else if (name.length === 2) out.destination_of_supply = name.toUpperCase();
        }
    }
    if (!out.destination_of_supply && state.salesOrder && state.salesOrder.destination_of_supply) {
        out.destination_of_supply = state.salesOrder.destination_of_supply;
    }
    return out;
}

// antigravity update with vendor reverse charge requirement
function vendorNeedsReverseCharge(contact) {
    const c = contact || VA.contact;
    const treatment = String(c?.gst_treatment || '')
        .trim()
        .toLowerCase();

    // Overseas vendors strictly require reverse charge in Zoho Books India.
    // Unregistered vendors do not automatically mandate RCM unless RCM is toggled or applicable.
    return treatment === 'overseas';
}

// antigravity update with vendor reverse charge verification
async function ensureVendorReverseCharge(formData) {
    const vendorId = String(formData.vendorId || '').trim();

    if (!vendorId) {
        throw new Error('Please select a vendor.');
    }

    // Always fetch fresh vendor details. Do not use the 30-second cache.
    const vendorResponse = await zbApi(
        'GET',
        '/contacts/' + vendorId
    );

    const contact = vendorResponse.contact;

    if (!contact || String(contact.contact_id) !== vendorId) {
        throw new Error('Unable to verify the selected vendor GST treatment.');
    }

    // Update the shared vendor details used by poGstFields().
    VA.contact = contact;
    VA.vendorId = vendorId;

    const treatment = String(contact.gst_treatment || '')
        .trim()
        .toLowerCase();

    // Overseas strictly requires reverse charge in Zoho Books.
    // Unregistered vendors do not automatically require RCM unless the user checked reverse charge.
    const required = (treatment === 'overseas');

    const checkbox = $('reverse-charge');

    if (required) {
        formData.reverseCharge = true;

        if (checkbox) {
            checkbox.checked = true;
        }
    } else {
        formData.reverseCharge = checkbox
            ? checkbox.checked
            : !!formData.reverseCharge;
    }

    log('REVERSE_CHARGE', 'Fresh vendor GST details', {
        vendorId: vendorId,
        contactName: contact.contact_name,
        gstTreatment: treatment,
        reverseChargeRequired: required,
        reverseChargeApplied: formData.reverseCharge
    });

    return required;
}
// ============================================================
// PURCHASE ORDER CREATION
// ============================================================

// antigravity update with reverse charge purchase order payload
function buildPurchaseOrderPayload(formData, salesOrderNumber) {
    const isRcm = formData.reverseCharge === true || vendorNeedsReverseCharge(VA.contact);

    return {
        vendor_id: formData.vendorId,
        date: formData.date,
        delivery_date: formData.deliveryDate || formData.date,
        reference_number: salesOrderNumber,
        ...(formData.shipVia ? { ship_via: formData.shipVia } : {}),
        ...poGstFields(formData),

        // Always send an explicit boolean to Zoho Books.
        is_reverse_charge_applied: isRcm,
        ...(state.salesOrder && state.salesOrder.id ? { salesorder_id: state.salesOrder.id } : {}),
        ...(formData.locationId ? { location_id: formData.locationId } : {}),
        // Do not send a Location ID as an Organization Address ID.
        // These are separate Zoho Books identifiers.
        ...(formData.deliverTo === 'customer' && formData.deliveryTargetId
            ? { delivery_customer_id: formData.deliveryTargetId } : {}),
        ...ptPayload(formData.paymentTermId),
        is_inclusive_tax: formData.taxInclusive,
        discount_type: discountApiValue(formData.discountType),
        ...(formData.txDiscount
            ? { discount: formData.txDiscount, is_discount_before_tax: formData.discountBeforeTax } : {}),
        ...(formData.adjustment ? { adjustment: formData.adjustment, adjustment_description: formData.adjustmentDescription || 'Adjustment' } : {}),
        // antigravity update with TDS / TCS payload fields
        ...(formData.tdsTaxId
            ? (formData.isTds
                ? { is_tds: true, tds_tax_id: formData.tdsTaxId }
                : { is_tds: false, tds_tax_id: formData.tdsTaxId, tcs_tax_id: formData.tdsTaxId })
            : {}),
        line_items: formData.lineItems
            .filter((li) => li.poQuantity > 0)
            .map((li) => {
                const isExemption = typeof li.taxId === 'string' && li.taxId.startsWith('exemption:');
                const rawTaxId = isExemption ? '' : (li.taxId || '');
                const exemptionId = isExemption ? li.taxId.replace(/^exemption:/, '') : undefined;

                return {
                    item_id: li.itemId || undefined,
                    name: li.name,
                    description: li.description,
                    quantity: li.poQuantity,
                    rate: li.rate,
                    discount: li.discountPct ? `${li.discount}%` : li.discount,
                    tax_id: isRcm ? '' : (rawTaxId || ''),
                    reverse_charge_tax_id: isRcm ? (rawTaxId || '') : '',
                    ...(exemptionId ? { tax_exemption_id: exemptionId } : {}),
                    account_id: li.accountId || undefined,
                    location_id: li.locationId || undefined,
                    unit: li.unit || undefined,
                    hsn_or_sac: li.hsn || undefined,
                    salesorder_item_id: (li.extra || /^new_/.test(li.lineItemId) || /^so_line_/.test(li.lineItemId)) ? undefined : li.lineItemId
                };
            }),
            // Mark this PO as created from the widget
            custom_fields: [
                { api_name: 'cf_iswidgetcreator', value: true }
            ],
        notes: formData.notes,
        terms: formData.terms
    };
}

// async function createPurchaseOrder(payload) {
//     log('CREATE_PO', 'Submitting...', payload);
//     const response = await ZFAPPS.request({
//         url: `${state.apiRootEndPoint}/purchaseorders`,
//         method: 'POST',
//         url_query: withOrgId(),
//         header: [{ key: 'Accept', value: 'application/json' }, { key: 'Content-Type', value: 'application/json' }],
//         body: { mode: 'raw', raw: JSON.stringify(payload) },
//         connection_link_name: CONNECTION_LINK_NAME
//     });

//     let data;
//     try {
//         data = JSON.parse(response.data.body);
//     } catch (e) {
//         throw new Error('Failed to parse create response: ' + e.message);
//     }

//     if (Number(data.code) !== 0) {
//         const error = new Error(
//             data.message || 'Purchase Order creation failed.'
//         );
    
//         error.zohoCode = data.code;
//         error.isZohoRejection = true;
    
//         throw error;
//     }

//     const po = data.purchaseorder;
//     log('CREATE_PO', 'Success. ID: ' + po.purchaseorder_id);

//     return {
//         id: po.purchaseorder_id,
//         number: po.purchaseorder_number,
//         vendorName: po.vendor_name,
//         total: po.total
//     };
// }

async function createPurchaseOrder(payload) {
    log('CREATE_PO', 'Submitting...', payload);

    const zohoError = (message, code) => {
        const e = new Error(message || 'Zoho Books rejected the Purchase Order.');
        e.isZohoRejection = true;     // real answer from Zoho: never retry or "recover"
        e.zohoCode = code;
        return e;
    };

    let response;
    try {
        response = await ZFAPPS.request({
            url: `${state.apiRootEndPoint}/purchaseorders`,
            method: 'POST',
            url_query: withOrgId(),
            header: [{ key: 'Accept', value: 'application/json' }, { key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: JSON.stringify(payload) },
            connection_link_name: CONNECTION_LINK_NAME
        });
    } catch (err) {
        // HTTP error (e.g. 400): the real Zoho message is in err.data.body
        let parsed = null;
        try { parsed = JSON.parse(err && err.data && err.data.body); } catch (_) { /* not JSON */ }
        if (parsed && parsed.message) {
            logError('CREATE_PO', 'Zoho rejected the request', parsed);
            throw zohoError(parsed.message, parsed.code);
        }
        throw err;                    // network / timeout: handled by the recovery check
    }

    let data;
    try {
        data = JSON.parse(response.data.body);
    } catch (e) {
        throw new Error('Failed to parse create response: ' + e.message);
    }

    if (Number(data.code) !== 0) {
        logError('CREATE_PO', 'Zoho returned an error', data);
        throw zohoError(data.message, data.code);
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
        showValidationErrors([]);          // clear the previous error before a new attempt

        const formData = collectFormData();

        if (!formData.vendorId) {
            showValidationErrors([{ message: 'Please select a vendor.' }]);
            return;
        }

        showLoading('Refreshing Sales Order and Purchase Orders...');

        const freshSO = await fetchSalesOrder();
        const normalizedSO = normalizeSalesOrder(freshSO);
        const allPOs = await getAllPurchaseOrders(normalizedSO.number);
        const relatedPOs = await getRelatedPurchaseOrdersWithLineItems(allPOs, normalizedSO.number);
        printPurchaseOrderLineItems(relatedPOs);

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
                setText(dom.footerStatus, 'Available quantities updated. Please review.');
            } else {
                showValidationErrors(errors);
            }
            return;
        }
        // antigravity update with handleCreatePurchaseOrder reverse charge validation
        showLoading('Verifying vendor GST treatment...');
        await ensureVendorReverseCharge(formData);
        
        const payload = buildPurchaseOrderPayload(
            formData,
            normalizedSO.number
        );
        


        log('CREATE_PO', 'FINAL API REQUEST JSON', JSON.stringify(payload, null, 2));

log('CREATE_PO', 'Reverse charge verification', {
    vendorId: payload.vendor_id,
    gstTreatment: VA.contact?.gst_treatment,
    reverseCharge: payload.is_reverse_charge_applied
});
        
        if (vendorNeedsReverseCharge(VA.contact) &&
            payload.is_reverse_charge_applied !== true) {
            throw new Error(
                'Reverse charge is mandatory for this vendor. PO creation stopped.'
            );
        }
        
        showLoading('Creating Purchase Order...');
        
        log('CREATE_PO', 'Final reverse charge payload value:', {
            is_reverse_charge_applied: payload.is_reverse_charge_applied || false,
            vendorId: payload.vendor_id
        });

        // IDs that already exist, so recovery can never mistake an old PO for the new one
        const existingPoIds = new Set(allPOs.map((p) => String(p.purchaseorder_id)));

        let result;
        try {
            result = await createPurchaseOrder(payload);
        } catch (createErr) {
            // A real answer from Zoho is final: show it, never "recover" around it
            if (createErr.isZohoRejection) throw createErr;

            logError('CREATE_PO', 'No clear answer from Zoho (network/timeout). Checking whether the PO was created...', createErr);
            try {
                showLoading('Verifying creation status with Zoho Books...');
                const verifyPOs = await getAllPurchaseOrders(normalizedSO.number);
                const matchingPo = verifyPOs.find((p) =>
                    !existingPoIds.has(String(p.purchaseorder_id)) &&      // must be NEW
                    String(p.reference_number || '').trim() === String(normalizedSO.number).trim() &&
                    String(p.vendor_id || '') === String(formData.vendorId)
                );
                if (matchingPo && matchingPo.purchaseorder_id) {
                    result = {
                        id: matchingPo.purchaseorder_id,
                        number: matchingPo.purchaseorder_number,
                        vendorName: matchingPo.vendor_name,
                        total: matchingPo.total,
                        recovered: true
                    };
                }
            } catch (recoveryErr) {
                logError('CREATE_PO', 'Recovery check failed', recoveryErr);
            }
            if (!result) throw createErr;
        }


        state.createdPoId = result.id;
        shipRemember(formData.shipVia);
        hideLoading();
        showSuccessScreen(result);
        state.dirty = false;

        // antigravity update with auto close and refresh current tab
        autoCloseAndRefreshAfterPoCreate();
    } catch (err) {
        hideLoading();
        logError('ERROR', 'Create PO failed', err);

        if (err && err.isZohoRejection) {
            showZohoError(err);                              // inside the form
        } else {
            showError(err.message || 'Unable to create Purchase Order.', true);   // overlay with Retry
        }
    } finally {
        state.creatingPurchaseOrder = false;
        dom.btnCreatePo.disabled = false;
        dom.btnCreatePo.textContent = 'Create Purchase Order';
    }
}

// ============================================================
// AUTO CLOSE & TAB REFRESH AFTER PO CREATION
// ============================================================

// ============================================================
// AFTER PO CREATION: GO TO THE CREATED PURCHASE ORDER PAGE
// ============================================================
function autoCloseAndRefreshAfterPoCreate() {
    const poId = state.createdPoId;
    if (!poId) return;

    const dcExt = state.organizationDataCenterExtension || '.com';
    const url = 'https://books.zoho' + dcExt + '/app/' + encodeURIComponent(state.organizationId) +
        '#/purchaseorders/' + encodeURIComponent(poId);

    log('CREATE_PO', 'Navigating to created Purchase Order: ' + url);

    // 1) Navigate the Zoho Books tab (the widget runs inside an iframe)
    try {
        if (window.top && window.top !== window) {
            window.top.location.href = url;
            return;                      // the page unloads, so nothing else is needed
        }
    } catch (e) {
        logError('CREATE_PO', 'Top-level navigation blocked, trying fallback', e);
    }

    // 2) Fallback: open in a new tab (may be blocked by the popup blocker, since this is not a click)
    let opened = null;
    try { opened = window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { /* ignore */ }

    // 3) If both fail, keep the success screen visible.
    //    The user can click "Open Purchase Order" (a real click, so it is never blocked).
    if (opened) {
        try { ZFAPPS.invoke('CLOSE'); } catch (e) { /* ignore */ }
    }
}
// ============================================================
// SUCCESS SCREEN & DISCARD
// ============================================================

function showSuccessScreen(po) {
    setText(dom.successPoNumber, po.number || '—');
    if (dom.successPoDetails) {
        dom.successPoDetails.innerHTML =
            `<div><strong>Vendor:</strong> ${escapeHtml(po.vendorName || '—')}</div>` +
            `<div><strong>Total:</strong> ${escapeHtml(String(po.total || '—'))}</div>`;
    }
    dom.app.style.display = 'none';
    dom.successScreen.style.display = 'block';
}

function openCreatedPurchaseOrder() {
    try {
        const poId = state.createdPoId;

        if (!poId) {
            logError('OPEN_PO', 'No Purchase Order ID available.');
            showError('No Purchase Order to open. Please create one first.', false);
            return;
        }

        const dcExt = state.organizationDataCenterExtension || '.com';
        const url = `https://books.zoho${dcExt}/app/#/purchaseorders/${encodeURIComponent(poId)}`;

        log('OPEN_PO', 'Opening Purchase Order URL: ' + url);
        window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
        logError('OPEN_PO', 'Failed to open Purchase Order', err);
        showError('Unable to open Purchase Order in a new tab.', false);
    }
}

// function confirmDiscard() {
//     if (!state.dirty || state.createdPoId) {
//         ZFAPPS.invoke('CLOSE');
//         return;
//     }

//     const backdrop = document.createElement('div');
//     backdrop.className = 'confirm-dialog-backdrop';
//     backdrop.innerHTML =
//         `<div class="confirm-dialog">` +
//         `<h3>Unsaved changes</h3>` +
//         `<p>You have unsaved changes. Discard them and close?</p>` +
//         `<div class="confirm-dialog-actions">` +
//         `<button class="btn btn-secondary" id="cd-cancel">Cancel</button>` +
//         `<button class="btn btn-primary" id="cd-discard">Discard</button>` +
//         `</div></div>`;
//     document.body.appendChild(backdrop);

//     backdrop.querySelector('#cd-cancel').addEventListener('click', () => backdrop.remove());
//     backdrop.querySelector('#cd-discard').addEventListener('click', () => {
//         state.dirty = false;
//         backdrop.remove();
//         ZFAPPS.invoke('CLOSE');
//     });
// }

function confirmDiscard() {
    // PO already created: nothing to lose, close directly
    if (state.createdPoId) {
        state.dirty = false;
        closeWidget();
        return;
    }

    // Don't stack dialogs if Cancel is clicked twice
    if (document.getElementById('cd-backdrop')) return;

    const hasChanges = state.dirty;
    const backdrop = document.createElement('div');
    backdrop.id = 'cd-backdrop';
    backdrop.className = 'confirm-dialog-backdrop';
    backdrop.innerHTML =
        `<div class="confirm-dialog">` +
        `<h3>${hasChanges ? 'Unsaved changes' : 'Close widget'}</h3>` +
        `<p>${hasChanges
            ? 'You have unsaved changes. Discard them and close?'
            : 'Are you sure you want to close this widget?'}</p>` +
        `<div class="confirm-dialog-actions">` +
        `<button class="btn btn-secondary" id="cd-cancel">No, stay</button>` +
        `<button class="btn btn-primary" id="cd-discard">Yes, close</button>` +
        `</div></div>`;
    document.body.appendChild(backdrop);

    const dismiss = () => backdrop.remove();

    backdrop.querySelector('#cd-cancel').addEventListener('click', dismiss);
    backdrop.addEventListener('mousedown', (ev) => { if (ev.target === backdrop) dismiss(); });
    backdrop.querySelector('#cd-discard').addEventListener('click', () => {
        state.dirty = false;          // stops the beforeunload "Leave site?" prompt
        dismiss();
        closeWidget();
    });
}

// ============================================================
// DATE PICKER — OPEN CALENDAR ON FULL FIELD CLICK
// ============================================================

function enableDatePickerOnFullField(input) {
    if (!input) return;

    input.style.cursor = 'pointer';

    // input.addEventListener('click', () => {
    //     try {
    //         if (typeof input.showPicker === 'function') {
    //             input.showPicker();
    //         } else {
    //             input.focus();
    //         }
    //     } catch (error) {
    //         input.focus();
    //     }
    // });

    input.addEventListener('click', () => {
        if (typeof input.showPicker === 'function') {
            try { input.showPicker(); } catch (e) { /* CSS overlay handles it */ }
        }
    });
}

// ============================================================
// EVENT WIRING
// ============================================================
function wireEvents() {
    wireTotalsCardEvents();

    enableDatePickerOnFullField(dom.orderDate);
    enableDatePickerOnFullField(dom.deliveryDate);

    dom.orderDate.addEventListener('change', markDirty);
    dom.deliveryDate.addEventListener('change', markDirty);

    dom.notes.addEventListener('input', markDirty);
    dom.terms.addEventListener('input', markDirty);

    // Keep the remaining existing code unchanged.


    const rc = $('reverse-charge');
    if (rc) {
        rc.addEventListener('change', () => {
            rc.dataset.touched = '1';
            markDirty();
            // antigravity update with reverse charge toggle line item GST update
            if (typeof updateAllLineItemGst === 'function') {
                updateAllLineItemGst(true);
            }
        });
    }

    dom.btnCreatePo.addEventListener('click', handleCreatePurchaseOrder);
    dom.btnCancel.addEventListener('click', confirmDiscard);
    dom.btnClose.addEventListener('click', confirmDiscard);

    dom.btnErrorRetry.addEventListener('click', () => {
        hideError();
        handleCreatePurchaseOrder();
    });
    dom.btnErrorClose.addEventListener('click', hideError);

    dom.btnSuccessClose.addEventListener('click', () => ZFAPPS.invoke('CLOSE'));
    dom.btnSuccessOpen.addEventListener('click', openCreatedPurchaseOrder);

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


function closeWidget() {
    try {
        const r = ZFAPPS.invoke('CLOSE');
        if (r && typeof r.catch === 'function') r.catch(() => { });
    } catch (e) { /* fall through to fallbacks */ }

    try { if (typeof ZFAPPS.closeModal === 'function') ZFAPPS.closeModal(); } catch (e) { }
    try { window.close(); } catch (e) { }
}

function showFullyPurchasedScreen(salesOrder) {
    hideLoading();
    hideError();
    dom.app.style.display = 'none';

    const old = document.getElementById('fully-purchased-screen');
    if (old) old.remove();

    const box = document.createElement('div');
    box.id = 'fully-purchased-screen';
    box.style.cssText =
        'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;' +
        'justify-content:center;gap:14px;background:#fff;text-align:center;padding:30px;z-index:50000;';

    box.innerHTML =
        '<div style="width:64px;height:64px;border-radius:50%;background:#e8f5e9;color:#2e7d32;' +
        'font-size:32px;display:flex;align-items:center;justify-content:center;">&#10003;</div>' +
        '<h2 style="font-size:20px;font-weight:600;color:#1a1a1a;margin:0;">' +
        'Purchase Order Already Created</h2>' +
        '<p style="font-size:14px;color:#666;max-width:420px;line-height:1.6;margin:0;">' +
        'All items in Sales Order <strong>' + escapeHtml(salesOrder.number) + '</strong> are already ' +
        'fully allocated to Purchase Orders. There is no remaining quantity to purchase.</p>' +
        '<button type="button" class="btn btn-primary" id="fp-close">Close</button>';

    document.body.appendChild(box);
    document.getElementById('fp-close').addEventListener('click', closeWidget);
}
// ============================================================
// INITIALISATION
// ============================================================

async function loadAllocationData() {
    showLoading('Loading Sales Order...');
    const salesOrder = normalizeSalesOrder(await fetchSalesOrder());
    state.salesOrder = salesOrder;

    showLoading('Loading item details...');
    await loadItemMasterForSalesOrder(salesOrder);

    showLoading('Loading Purchase Orders...');
    const allPOs = await getAllPurchaseOrders(salesOrder.number);

    shipCollectFromPOs(allPOs);

    showLoading('Fetching Purchase Order line item details...');
    const relatedPOs = await getRelatedPurchaseOrdersWithLineItems(allPOs, salesOrder.number);

    showLoading('Calculating available quantities...');
    const allocations = calculateAllAllocations(salesOrder, relatedPOs);
    state.lineItems = allocations;

    // Every SO line already fully purchased: do not open the PO form
    const list = Object.values(allocations);
    if (list.length > 0 && list.every((a) => a.remainingQuantity <= 0)) {
        showFullyPurchasedScreen(salesOrder);
        return false;
    }

    renderHeader(salesOrder);
    renderItems(allocations);
    if (typeof updateAllLineItemGst === 'function') updateAllLineItemGst(true);
    return true;
}

// Load ALL vendors quietly in the background (page after page) once the form is visible,
// so the Vendor dropdown opens instantly with the full list and never waits on the API.
let vendorPrefetchStarted = false;
async function prefetchVendorsInBackground() {
    if (vendorPrefetchStarted) return;
    vendorPrefetchStarted = true;
    try {
        await vendorSrc.init();                        // cached vendors appear here instantly
        let guard = 0, fails = 0;
        while (vendorSrc.canMore('') && guard++ < 20) {   // 20 rounds x 3 pages x 200 = up to 12,000 vendors
            try {
                await vendorSrc.loadBatch(3);          // 3 pages in parallel, no artificial pause
                fails = 0;
            } catch (e) {
                if (++fails >= 2) throw e;
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
        log('VENDOR', 'Background vendor prefetch complete', { count: vendorSrc.size() });
    } catch (err) {
        logError('VENDOR', 'Background vendor prefetch failed', err);
        vendorPrefetchStarted = false;
    }
}

async function init() {
    checkRequiredElements();

    wireVendorPicker();
    wireEvents();
    try {
        const App = await ZFAPPS.extension.init();
        await ZFAPPS.invoke('RESIZE', { width: '1300px', height: '850px' });

        showLoading('Loading organization context...');
        await loadOrganizationContext();
        // vendorSrc.init().catch(() => { });          // vendors start loading now
        vendorSrc.init().then(prefetchVendorsInBackground).catch(() => { });   // cached list shows now; the rest loads in parallel
        await Promise.all([loadTaxes(), loadAccounts(), loadLocations(), ptLoad(false)]);
        
        initLocationField();
        buildSupplyFields();
        await initPaymentTerms();                   // ptLoad is already done, so no new request


        const canCreate = await loadAllocationData();
        if (!canCreate) return;     // fully purchased: message page is already shown
        await initShipmentPreference();
        initDeliveryField();

        const urlContactId = getUrlParameter('contact_id');
        if (urlContactId) {
            try {
                const vendor = await fetchVendorById(urlContactId);
                if (vendor) selectVendor(vendor);
            } catch (err) {
                logError('ERROR', 'Vendor pre-load failed', err);
            }
        }

        dom.orderDate.value = todayISO();
        dom.deliveryDate.value = '';
        if (state.salesOrder.notes) dom.notes.value = state.salesOrder.notes;
        if (state.salesOrder.terms) dom.terms.value = state.salesOrder.terms;

        registerVendorSavedListener(App).catch((err) =>
            logError('ERROR', 'Error registering ON_VENDOR_SAVED', err)
        );

  
        hideLoading();
        setText(dom.footerStatus, 'Ready');
        prefetchVendorsInBackground();      // fire-and-forget: loads all vendors while the user fills the form
        // 
            } catch (err) {
        hideLoading();
        logError('ERROR', 'Init failed', err);
        showError(err.message || 'Unable to initialise the widget.', true);
    }
}


window.addEventListener('load', init);
