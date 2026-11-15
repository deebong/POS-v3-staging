// Supplier + purchase management. Cache-first for fast navigation; Google Sheets refreshes in background.
import { idb } from "./data/idb.js";
import { getConfig, getDevice, backend, currentStatus } from "./data/backend.js";
import { uid } from "./data/logic.js";
import { createSheetsAdapter } from "./data/sheets-adapter.js";
import { state, adjustStock, saveProduct } from "./store.js";
import { esc, icon, money, openModal, toast, hydrateIcons, setButtonBusy, confirmDialog } from "./ui.js";
import { can, currentStaff, ensureOnlineStaffAuth } from "./staff.js";
import { getAuthToken } from "./auth.js";
import { openProductForm } from "./inventory.js";

const KEY = "procurement.v1";
let data = { suppliers: [], purchases: [], purchaseItems: [], outbox: [], lastPull: null, supplierIdAliases: {}, nextSupplierTempId: -1 };
let mountGeneration = 0;
let activeRoot = null;
const now = () => new Date().toISOString();
const tempId = rows => Math.min(0, ...rows.map(x => Number(x.id) || 0)) - 1;
let syncRunning = null;
let cachePromise = null;
let refreshRunning = null;
let syncError = "";
let reconnectTimer = null;
let retryDelay = 10000;
let localPurchaseWrites = 0;

const api = async (action, payload = {}) => {
  const cfg = getConfig();
  if (cfg.mode === "local") return { ok: true, local: true };
  if (!cfg.url) throw new Error("Connect Google Sheets in Settings first");
  if (!navigator.onLine) throw new Error("You're offline; showing the last saved copy");
  const api = createSheetsAdapter(cfg);
  if (action === "procurementBootstrap") return api.procurementBootstrap();
  if (action === "procurementSync") return api.procurementSync(payload);
  throw new Error("Unknown procurement action");
};

export function getProcurementStatus() {
  if (!can("procurement") || getConfig().mode === "local") return {pending:0,syncing:false,error:""};
  return {pending:data.outbox.length,syncing:!!syncRunning,error:syncError};
}
function updateSyncStatus() {
  const box = activeRoot?.querySelector("#procSyncStatus");
  if (!box) return;
  const pending = data.outbox.length, local = getConfig().mode === "local", syncing = !!syncRunning;
  const label = local ? "Saved on this PC" : syncing ? "Synchronizing procurement…" :
    pending ? (navigator.onLine ? (syncError ? "Sync paused — " : "") + pending + " change(s) pending" : "Offline — " + pending + " change(s) pending") :
    navigator.onLine ? (syncError ? "Cloud refresh failed — cached records shown" : "Procurement up to date") : "Offline — showing saved records";
  box.querySelector("[data-proc-status]").textContent = label;
  box.querySelector("[data-proc-error]").textContent = syncError;
  const retry = box.querySelector("[data-proc-retry]");
  retry.disabled = syncing || !navigator.onLine || (!pending && !syncError) || local;
  retry.hidden = local || (!pending && !syncError);
}
function notifyProcurement() {
  updateSyncStatus();
  window.dispatchEvent(new CustomEvent("procurement:status", { detail: getProcurementStatus() }));
}
async function saveLocal() { await idb.set(KEY, data); notifyProcurement(); }
export async function getProcurementSnapshot({ refresh = false } = {}) {
  await loadCache();
  if (refresh) {
    try { await refreshCloud(); } catch (_) {}
  }
  return { suppliers: data.suppliers, purchases: data.purchases, purchaseItems: data.purchaseItems };
}
async function loadCache() {
  if (!cachePromise) cachePromise = idb.get(KEY).then(cached => {
    if (cached) data = { ...data, ...cached };
    data.supplierIdAliases ||= {};
    // Temporary IDs cannot be reused after an acknowledgement: an open modal
    // may still hold the previous ID while the server assigns a permanent one.
    data.nextSupplierTempId = Math.min(-1, Number(data.nextSupplierTempId) || -1, ...data.suppliers.map(s=>Number(s.id)-1), ...Object.keys(data.supplierIdAliases).map(id=>Number(id)-1), ...data.outbox.filter(op=>op.type==="supplier.save").map(op=>Number(op.payload.supplier.id)-1));
    return !!cached;
  }).catch(error => { cachePromise = null; throw error; });
  return cachePromise;
}
function checkStore() {
  const cfg = getConfig();
  if (cfg.mode === "local") return;
  if (data.cloudUrl && data.cloudUrl !== cfg.url) {
    if (data.outbox.length) throw new Error("Pending procurement belongs to a different Google Sheets connection. Reconnect the original store to sync it.");
    data = {suppliers:[],purchases:[],purchaseItems:[],outbox:[],lastPull:null,cloudUrl:cfg.url,supplierIdAliases:{},nextSupplierTempId:-1};
  }
  data.cloudUrl = cfg.url;
}
function scheduleRetry() {
  if (reconnectTimer || !navigator.onLine || !data.outbox.length || !can("procurement") || getConfig().mode === "local") return;
  // Only retry temporary transport failures. Permission and reconciliation
  // failures require operator intervention; never hammer the Apps Script API.
  if (!/timed? out|too long|network|failed to fetch|load failed|non-JSON|HTTP 5\d\d|unavailable|inventory changes still need|could not be synced/i.test(syncError)) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; retryDelay = Math.min(retryDelay * 2, 120000); resumeProcurement().catch(()=>{}); }, retryDelay);
}
export async function resumeProcurement({refresh=false}={}) {
  if (!currentStaff() || !can("procurement")) return false;
  try {
    await loadCache(); notifyProcurement();
    if (getConfig().mode === "local" || !navigator.onLine || localPurchaseWrites) return false;
    checkStore();
    if (!data.outbox.length) return refresh ? await refreshCloud() : false;
    if (!getAuthToken() && !(await ensureOnlineStaffAuth())) throw new Error("Google Sheets sign in required to sync procurement.");
    await sync();
    if (mounted(activeRoot,mountGeneration) && !document.querySelector(".modal-backdrop")) render(activeRoot,mountGeneration);
    return !data.outbox.length;
  } catch (e) {
    syncError = e.message || "Procurement sync failed";
    notifyProcurement(); scheduleRetry(); return false;
  }
}
window.addEventListener("online", () => { retryDelay = 10000; clearTimeout(reconnectTimer); reconnectTimer = null; resumeProcurement().catch(()=>{}); });
window.addEventListener("offline", notifyProcurement);
window.addEventListener("staff:server-auth", e => { if(e.detail?.ok) resumeProcurement().catch(()=>{}); });
window.addEventListener("staff:switched", () => resumeProcurement().catch(()=>{}));
async function refreshCloud() {
  const cfg = getConfig();
  if (cfg.mode === "local" || !navigator.onLine || !can("procurement")) return false;
  checkStore();
  if (data.outbox.length) return resumeProcurement();
  if (refreshRunning) return refreshRunning;
  refreshRunning = (async () => {
    const r = await api("procurementBootstrap");
    // A new local mutation may have been queued while this read was in flight.
    if (data.outbox.length || localPurchaseWrites || !can("procurement") || getConfig().url !== cfg.url) return false;
    data = { ...data, suppliers: r.suppliers || [], purchases: r.purchases || [], purchaseItems: r.purchaseItems || [], lastPull: now() };
    syncError = ""; await saveLocal(); return true;
  })().finally(() => { refreshRunning = null; });
  return refreshRunning;
}
async function sync() {
  if (getConfig().mode === "local" || !navigator.onLine || !data.outbox.length || !can("procurement") || localPurchaseWrites) return;
  if (syncRunning) return syncRunning;
  const syncUrl=getConfig().url;
  checkStore();
  syncRunning = (async () => {
    while (data.outbox.length && navigator.onLine && can("procurement") && !localPurchaseWrites && getConfig().url===syncUrl) {
      // Resolve temporary supplier IDs before submitting dependent purchases.
      const first = data.outbox[0];
      if (first.ready === false) throw new Error("A purchase needs stock reconciliation before it can sync. Review the saved purchase before retrying.");
      const stop = data.outbox.findIndex((op,i) => i > 0 && (op.ready === false || (op.type === "supplier.save" && Number(op.payload.supplier.id) < 0)));
      const batch = data.outbox.slice(0, first.type === "supplier.save" && Number(first.payload.supplier.id) < 0 ? 1 : Math.min(50, stop < 0 ? 50 : stop));
      if (batch.some(op => op.type === "purchase.save") && getConfig().mode === "hybrid" && currentStatus()?.pending) {
        // Product creation/stock/cost operations must reach the main inventory
        // before the purchase references them in the procurement tables.
        await backend.sync({ pull: false, throwOnError: true });
        if (currentStatus()?.pending) throw new Error("Inventory changes still need to sync before this purchase.");
      }
      if (!navigator.onLine || !can("procurement") || getConfig().url!==syncUrl) break;
      const r = await api("procurementSync", { ops: batch });
      const acknowledged = new Set((r.results || []).filter(x => x.ok === true).map(x => x.opId));
      for (const op of batch) {
        if (op.type !== "supplier.save" || Number(op.payload.supplier.id) >= 0 || !acknowledged.has(op.opId)) continue;
        const oldId = Number(op.payload.supplier.id);
        const result = (r.results || []).find(x => x.opId === op.opId);
        // Backward compatibility: older successful log entries did not retain IDs.
        const matches = (r.suppliers || []).filter(s => s.name === op.payload.supplier.name && s.createdAt === op.payload.supplier.createdAt);
        const newId = Number(result?.id || (matches.length === 1 ? matches[0].id : 0));
        if (!newId) throw new Error("Supplier was saved but its server ID could not be matched. Review pending procurement.");
        data.supplierIdAliases ||= {};
        data.supplierIdAliases[String(oldId)] = { id: newId, createdAt: op.payload.supplier.createdAt };
        data.suppliers.forEach(s => { if(Number(s.id)===oldId)s.id=newId; });
        data.purchases.forEach(p => { if(Number(p.supplierId)===oldId)p.supplierId=newId; });
        data.outbox.forEach(o => {
          if(o.type==="supplier.save" && Number(o.payload.supplier.id)===oldId)o.payload.supplier.id=newId;
          if(o.type==="supplier.delete" && Number(o.payload.id)===oldId)o.payload.id=newId;
          if(o.type==="purchase.save" && Number(o.payload.purchase.supplierId)===oldId)o.payload.purchase.supplierId=newId;
        });
      }
      data.outbox = data.outbox.filter(x => !acknowledged.has(x.opId));
      if (!data.outbox.length) {
        data.suppliers = r.suppliers || data.suppliers;
        data.purchases = r.purchases || data.purchases;
        data.purchaseItems = r.purchaseItems || data.purchaseItems;
        data.lastPull = now();
      }
      await saveLocal();
      if (batch.some(x => !acknowledged.has(x.opId))) throw new Error((r.results || []).find(x=>!x.ok)?.error || "Some procurement changes could not be synced; pending records have been retained.");
    }
  })();
  notifyProcurement();
  try { await syncRunning; syncError = ""; retryDelay = 10000; clearTimeout(reconnectTimer); reconnectTimer = null; }
  catch(e) { syncError = e.message || "Procurement sync failed"; scheduleRetry(); throw e; }
  finally { syncRunning = null; notifyProcurement(); }
}
async function syncAfterSave() {
  if (getConfig().mode === "local") return true;
  if (!navigator.onLine) return false;
  try { if(!getAuthToken() && !(await ensureOnlineStaffAuth())) throw new Error("Google Sheets sign in required to sync procurement."); await sync(); if(data.outbox.length&&!syncRunning&&!localPurchaseWrites&&can("procurement"))await sync(); return !data.outbox.length; }
  catch (error) { syncError = error.message; notifyProcurement(); scheduleRetry(); return false; }
}
function queue(type, payload, ready = true) { const op = { opId: `${Date.now()}-${Math.random().toString(36).slice(2)}`, type, payload: structuredClone(payload), ready }; data.outbox.push(op); return op; }
function supplier(id, createdAt = "") {
  const key=Number(id);
  const direct=data.suppliers.find(s=>Number(s.id)===key && (!createdAt || s.createdAt===createdAt));
  if(direct)return direct;
  const alias=data.supplierIdAliases?.[String(key)];
  if(!alias || (createdAt && alias.createdAt!==createdAt))return null;
  return data.suppliers.find(s=>Number(s.id)===Number(alias.id) && (!alias.createdAt || s.createdAt===alias.createdAt)) || null;
}
function allocateSupplierTempId(){
  const next=Math.min(-1,Number(data.nextSupplierTempId)||-1,...data.suppliers.map(s=>Number(s.id)-1),...Object.keys(data.supplierIdAliases||{}).map(id=>Number(id)-1));
  data.nextSupplierTempId=next-1;
  return next;
}
function purchaseItems(purchaseId) { return data.purchaseItems.filter(x => Number(x.purchaseId) === Number(purchaseId)); }
function totals(lines) { const subtotal = lines.reduce((s,x) => s + Number(x.qty || 0) * Number(x.unitCost || 0), 0); const tax = lines.reduce((s,x) => s + Number(x.qty || 0) * Number(x.unitCost || 0) * Number(x.taxRate || 0) / 100, 0); return { subtotal, tax, total: subtotal + tax }; }
function mounted(root, generation) { return generation === mountGeneration && root?.isConnected && document.getElementById("view") === root; }

async function saveSupplier(s) {
  if(!can("procurement"))throw new Error("Procurement access required.");checkStore();
  const existing = s.id ? supplier(s.id,s.createdAt) : null;
  if(s.id&&!existing)throw new Error("This supplier was changed or no longer exists. Refresh suppliers before editing; a new record will not be created.");
  const row = { ...s, id: existing ? existing.id : allocateSupplierTempId(), active: s.active !== false, createdAt: existing?.createdAt || now(), updatedAt: now() };
  if (existing) Object.assign(existing, row); else data.suppliers.unshift(row);
  queue("supplier.save", { supplier: row });
  await saveLocal();
  return syncAfterSave();
}
async function deactivateSupplier(s) { if(!can("procurement"))throw new Error("Procurement access required.");checkStore();s=supplier(s.id,s.createdAt);if(!s)throw new Error("Supplier no longer exists. Refresh the list.");s.active = false; s.updatedAt = now(); queue("supplier.delete", { id: s.id }); await saveLocal(); return syncAfterSave(); }

function supplierModal(s, root, generation) {
  const editing = !!s;
  const p = s || { name: "", phone: "", email: "", address: "", gstin: "", notes: "", active: true };
  const m = openModal({ title: editing ? "Edit supplier" : "Add supplier", sub: "Supplier contact and billing details", size: "md", body: `<form id="supplierForm" class="form-grid"><div class="field span-2"><label>Supplier / company name *</label><input class="input" name="name" required maxlength="120" value="${esc(p.name)}" placeholder="e.g. Sri Lakshmi Distributors"></div><div class="field"><label>Phone</label><input class="input" name="phone" maxlength="40" value="${esc(p.phone || "")}"></div><div class="field"><label>Email</label><input class="input" name="email" type="email" maxlength="120" value="${esc(p.email || "")}"></div><div class="field"><label>GSTIN</label><input class="input" name="gstin" maxlength="40" value="${esc(p.gstin || "")}"></div><div class="field span-2"><label>Address</label><textarea class="input" name="address" rows="2" maxlength="300">${esc(p.address || "")}</textarea></div><div class="field span-2"><label>Notes</label><textarea class="input" name="notes" rows="2" maxlength="300">${esc(p.notes || "")}</textarea></div></form>`, footer: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="supplierSave">${icon("check")} Save supplier</button>` });
  const f = m.$("#supplierForm"), cancel = m.$("[data-cancel]"), save = m.$("#supplierSave");
  if (cancel) cancel.onclick = () => m.close();
  if (save) save.onclick = async () => {
    if (save.disabled || !f.reportValidity()) return;
    const restore = setButtonBusy(save,"Saving supplier…");
    const values = Object.fromEntries(new FormData(f));
    try { const synced = await saveSupplier({ ...p, ...values }); toast(synced ? "Supplier saved" : "Supplier saved on this PC — sync pending"); m.close(); if (mounted(root, generation)) render(root, generation); }
    catch (e) { toast(e.message, "error"); }
    finally { restore(); }
  };
}

async function savePurchase(purchase, lines) {
  if(!can("procurement"))throw new Error("Procurement access required.");checkStore();
  const t = totals(lines), localId = tempId(data.purchases), s = supplier(purchase.supplierId,purchase.supplierCreatedAt);
  if(!s || !s.active)throw new Error("The selected supplier is no longer active. Refresh suppliers and select again.");
  const row = { id: localId, purchaseNo: `PUR-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${getDevice().code}-${uid().replace(/-/g,"").slice(-12).toUpperCase()}`, supplierId: Number(s.id), supplierName: s.name || "", invoiceNo: purchase.invoiceNo || "", createdAt: now(), receivedAt: now(), status: "received", ...t, notes: purchase.notes || "" };
  data.purchases.unshift(row);
  const items = lines.map((x,i) => ({ id: -(data.purchaseItems.filter(z => z.id < 0).length + i + 1), purchaseId: localId, productId: Number(x.productId), sku: x.sku, name: x.name, unit: x.unit, qty: Number(x.qty), unitCost: Number(x.unitCost), taxRate: Number(x.taxRate) || 0, lineSubtotal: Number(x.qty) * Number(x.unitCost), lineTax: Number(x.qty) * Number(x.unitCost) * (Number(x.taxRate) || 0) / 100 }));
  localPurchaseWrites++;
  try {
    data.purchaseItems.push(...items);
    const op = queue("purchase.save", { purchase: row, items }, false);
    await saveLocal();
    for (const x of items) {
      const p = await adjustStock({ productId: x.productId, mode: "add", quantity: x.qty, reason: `Supplier delivery ${row.purchaseNo}` });
      await saveProduct({ ...p, cost: Number(x.unitCost) });
    }
    op.ready=true;
    await saveLocal();
  } catch(error) { syncError="Purchase needs stock reconciliation: "+error.message;notifyProcurement();throw error; } finally { localPurchaseWrites--; }
  return syncAfterSave();
}

function purchaseModal(root, generation) {
  if (!data.suppliers.some(s => s.active)) return toast("Add a supplier before recording a purchase", "warn");
  let products = state.all.filter(p => p.isActive);
  const m = openModal({ title: "Receive supplier purchase", sub: "Stock is increased immediately when this purchase is saved", size: "lg", body: `<form id="purchaseForm"><div class="proc-grid"><div class="field"><label>Supplier *</label><select class="select" name="supplierId" required><option value="">Select supplier</option>${data.suppliers.filter(s=>s.active).map(s=>`<option value="${s.id}" data-created-at="${esc(s.createdAt||"")}">${esc(s.name)}</option>`).join("")}</select></div><div class="field"><label>Supplier invoice / bill no. <span class="muted">(optional)</span></label><input class="input" name="invoiceNo" maxlength="60" placeholder="e.g. SLD/26/1842"><span class="hint">Enter the reference printed on the supplier’s bill. Marvels generates its own purchase ID.</span></div><div class="field"><label>Notes</label><input class="input" name="notes"></div></div><div class="proc-lines" id="procLines"><div class="proc-empty">Add products to this purchase.</div></div><button type="button" class="btn btn-outline" id="addPurchaseLine">${icon("plus")} Add purchase line</button> <button type="button" class="btn btn-outline" id="newPurchaseProduct">${icon("plus")} Create new product</button><div class="proc-total" id="procTotal"></div></form>`, footer: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="purchaseSave">${icon("check")} Receive purchase</button>` });
  const f = m.$("#purchaseForm"), lines = m.$("#procLines");
  const renderLines = () => { const rows = [...lines.querySelectorAll(".proc-line")]; m.$("#procTotal").innerHTML = rows.length ? `<b>Total</b> ${money(rows.reduce((s,r)=>s+Number(r.querySelector('[name=qty]').value||0)*Number(r.querySelector('[name=unitCost]').value||0)*(1+Number(r.querySelector('[name=taxRate]').value||0)/100),0))}` : ""; };
  const add = () => { if (lines.querySelector(".proc-empty")) lines.innerHTML = ""; const r = document.createElement("div"); r.className = "proc-line"; r.innerHTML = `<label class="proc-line-field proc-product-field"><span>Product</span><select class="select" name="product" required><option value="">Product</option>${products.map(p=>`<option value="${p.id}">${esc(p.name)} · ${esc(p.sku)}</option>`).join("")}</select></label><label class="proc-line-field"><span>Quantity</span><input class="input" name="qty" type="number" min="0.001" step="0.001" placeholder="Qty" required></label><label class="proc-line-field"><span>Unit cost</span><input class="input" name="unitCost" type="number" min="0" step="0.01" placeholder="Cost" required></label><label class="proc-line-field"><span>Tax %</span><input class="input" name="taxRate" type="number" min="0" max="100" step="0.01" value="0" placeholder="Tax %"></label><button type="button" class="icon-btn" data-remove title="Remove" aria-label="Remove purchase line">${icon("trash")}</button>`; lines.appendChild(r); hydrateIcons(r); r.querySelector("[data-remove]").onclick=()=>{r.remove();renderLines();}; r.querySelectorAll("input").forEach(x=>x.oninput=renderLines); r.querySelector('[name=product]').onchange=()=>{const p=products.find(x=>Number(x.id)===Number(r.querySelector('[name=product]').value));if(p){r.querySelector('[name=unitCost]').value=p.cost ?? "";r.querySelector('[name=taxRate]').value=p.taxRate || 0;}renderLines();}; renderLines(); };
  m.$("[data-cancel]").onclick = () => m.close(); m.$("#addPurchaseLine").onclick = add; add();
  m.$("#newPurchaseProduct").onclick=()=>{
    if(!can("inventory"))return toast("Inventory access required","error");
    openProductForm(null,{receiving:true,onSaved:(saved)=>{
      if(!m.el.isConnected || !saved)return;
      products=state.all.filter(p=>p.isActive);
      const options='<option value="">Product</option>'+products.map(p=>`<option value="${p.id}">${esc(p.name)} · ${esc(p.sku)}</option>`).join("");
      lines.querySelectorAll('[name=product]').forEach(select=>{const selected=select.value;select.innerHTML=options;select.value=selected;});
      let target=[...lines.querySelectorAll('[name=product]')].find(select=>!select.value);
      if(!target){add();target=lines.querySelector(".proc-line:last-child [name=product]");}
      target.value=String(saved.id);target.dispatchEvent(new Event("change"));
    }});
  };
  m.$("#purchaseSave").onclick = async () => { const button=m.$("#purchaseSave"); if(button.disabled)return; const ls=[...lines.querySelectorAll(".proc-line")].map(r=>{const p=products.find(x=>x.id===Number(r.querySelector('[name=product]').value));return p?{productId:p.id,sku:p.sku,name:p.name,unit:p.unit,qty:Number(r.querySelector('[name=qty]').value),unitCost:Number(r.querySelector('[name=unitCost]').value),taxRate:Number(r.querySelector('[name=taxRate]').value||0)}:null;}).filter(Boolean); if(!f.reportValidity()||!ls.length||ls.length!==lines.querySelectorAll(".proc-line").length||ls.some(x=>!Number.isFinite(x.qty)||x.qty<=0||!Number.isFinite(x.unitCost)||x.unitCost<0||x.taxRate<0||x.taxRate>100))return toast("Select every product and enter valid quantities/costs/tax","error"); const restore=setButtonBusy(button,"Receiving purchase…"); try{const purchase=Object.fromEntries(new FormData(f));purchase.supplierCreatedAt=f.elements.supplierId.selectedOptions[0]?.dataset.createdAt||"";const synced=await savePurchase(purchase,ls);toast(synced?"Purchase received and stock updated":"Purchase saved on this PC — sync pending");m.close();if(mounted(root,generation))render(root,generation);}catch(e){toast("Purchase could not be fully processed. Review the saved purchase and stock before retrying: "+e.message,"error");m.close();if(mounted(root,generation))render(root,generation);}finally{restore();} };
}

function purchaseDetails(p) {
  const items = purchaseItems(p.id);
  const pending = data.outbox.some(op=>op.type==="purchase.save" && op.payload.purchase.purchaseNo===p.purchaseNo);
  const m=openModal({title:p.purchaseNo,sub:"Supplier purchase details",size:"lg",body:`<div class="proc-detail-grid"><div class="field"><label>Supplier</label><b>${esc(p.supplierName||"—")}</b></div><div class="field"><label>Supplier invoice</label><b>${esc(p.invoiceNo||"—")}</b></div><div class="field"><label>Received</label><span>${esc(new Date(p.receivedAt||p.createdAt).toLocaleString())}</span></div><div class="field"><label>Status</label><span>${pending&&getConfig().mode!=="local"?"Saved on this PC — sync pending":"Received"}</span></div></div><div class="proc-table"><table><thead><tr><th>Product / SKU</th><th>Qty</th><th>Unit cost</th><th>Tax</th><th>Line total</th></tr></thead><tbody>${items.map(x=>`<tr><td><b>${esc(x.name)}</b><small>${esc(x.sku)}</small></td><td>${Number(x.qty)} ${esc(x.unit||"")}</td><td>${money(x.unitCost)}</td><td>${money(x.lineTax)}</td><td>${money(Number(x.lineSubtotal||0)+Number(x.lineTax||0))}</td></tr>`).join("")}</tbody></table></div><div class="proc-detail-totals"><div>Subtotal <b>${money(p.subtotal)}</b></div><div>Tax <b>${money(p.tax)}</b></div><div>Total <b>${money(p.total)}</b></div></div>${p.notes?`<p class="muted">Notes: ${esc(p.notes)}</p>`:""}`,footer:'<button class="btn btn-outline" data-done>Close</button>'});
  m.$("[data-done]").onclick=()=>m.close();
}

function render(root = activeRoot, generation = mountGeneration) {
  if (!mounted(root, generation)) return;
  const totalPurchases = data.purchases.reduce((s,p)=>s+Number(p.total||0),0);
  const selectedTab = root.querySelector(".proc-tabs button.active")?.dataset.tab || "suppliers";
  const supplierQuery=root.querySelector("#supplierSearch")?.value||"";
  const purchaseQuery=root.querySelector("#purchaseSearch")?.value||"";
  root.innerHTML = `<div class="proc-wrap"><div class="proc-head"><div><p class="proc-kicker">Manage suppliers and incoming stock.</p></div><div class="btn-row"><button class="btn btn-outline" id="addSupplier">${icon("plus")} Add supplier</button><button class="btn btn-primary" id="addPurchase">${icon("package")} Receive purchase</button></div></div><div id="procSyncStatus" class="proc-sync-status"><div><span data-proc-status role="status"></span><small data-proc-error></small></div><button class="btn btn-sm btn-outline" data-proc-retry>Sync now</button></div><div class="proc-stats"><div><span>Active suppliers</span><b>${data.suppliers.filter(s=>s.active).length}</b></div><div><span>Received purchases</span><b>${data.purchases.length}</b></div><div><span>Recorded purchase value</span><b>${money(totalPurchases)}</b></div></div><div class="proc-tabs"><button class="active" data-tab="suppliers">Suppliers</button><button data-tab="purchases">Purchase history</button></div><section id="supplierTab"><div class="proc-card"><div class="proc-search"><input class="input" id="supplierSearch" placeholder="Search supplier, phone or GSTIN…"></div><div class="proc-table mobile-records supplier-records" id="supplierTable"></div></div></section><section id="purchaseTab" class="hidden"><div class="proc-card"><div class="proc-search"><input class="input" id="purchaseSearch" placeholder="Search purchase no., supplier or invoice…"></div><div class="proc-table mobile-records purchase-records" id="purchaseTable"></div></div></section></div>`;
  hydrateIcons(root);
  root.querySelector("#addSupplier").onclick = () => supplierModal(null, root, generation);
  root.querySelector("#addPurchase").onclick = () => purchaseModal(root, generation);
  const renderSup = () => { const q=root.querySelector("#supplierSearch")?.value.toLowerCase()||"", box=root.querySelector("#supplierTable"); if(!box)return; const rows=data.suppliers.filter(s=>s.active&&(`${s.name} ${s.phone} ${s.gstin}`).toLowerCase().includes(q)); box.innerHTML=rows.length?`<table><thead><tr><th>Supplier</th><th>Phone</th><th>GSTIN</th><th>Purchases</th><th>Recorded value</th><th></th></tr></thead><tbody>${rows.map(s=>{const ps=data.purchases.filter(p=>Number(p.supplierId)===Number(s.id));return `<tr><td data-mobile-label="Supplier"><b>${esc(s.name)}</b><small>${esc(s.email||s.address||"")}</small></td><td data-mobile-label="Phone">${esc(s.phone||"—")}</td><td data-mobile-label="GSTIN">${esc(s.gstin||"—")}</td><td data-mobile-label="Purchases">${ps.length}</td><td data-mobile-label="Recorded value">${money(ps.reduce((a,p)=>a+Number(p.total||0),0))}</td><td data-mobile-label="Actions"><button class="btn btn-sm btn-outline" data-edit="${s.id}">Edit</button> <button class="btn btn-sm btn-ghost" data-deactivate="${s.id}">Deactivate</button></td></tr>`}).join("")}</tbody></table>`:`<div class="proc-empty">No suppliers found.</div>`;box.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>supplierModal(supplier(b.dataset.edit),root,generation));box.querySelectorAll("[data-deactivate]").forEach(b=>b.onclick=async()=>{const s=supplier(b.dataset.deactivate);if(!s)return;if(await confirmDialog({title:"Deactivate supplier?",message:`Deactivate ${s.name}?`,confirmText:"Deactivate",danger:true})){const restore=setButtonBusy(b,"Deactivating…");try{const synced=await deactivateSupplier(s);toast(synced?"Supplier deactivated":"Supplier deactivated on this PC — sync pending");if(mounted(root,generation))render(root,generation);}catch(e){toast(e.message,"error");}finally{restore();}}}); };
  const renderPur = () => { const q=root.querySelector("#purchaseSearch")?.value.toLowerCase()||"",box=root.querySelector("#purchaseTable"); if(!box)return; const rows=data.purchases.filter(p=>`${p.purchaseNo} ${p.supplierName} ${p.invoiceNo}`.toLowerCase().includes(q));box.innerHTML=rows.length?`<table><thead><tr><th>Purchase</th><th>Supplier</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows.map(p=>`<tr><td data-mobile-label="Purchase"><button class="proc-purchase-link" data-purchase-id="${p.id}">${esc(p.purchaseNo)}</button><small>${esc(p.invoiceNo||"")}</small></td><td data-mobile-label="Supplier">${esc(p.supplierName||"—")}</td><td data-mobile-label="Received">${new Date(p.receivedAt||p.createdAt).toLocaleString()}</td><td data-mobile-label="Items">${purchaseItems(p.id).length}</td><td data-mobile-label="Total"><b>${money(p.total)}</b></td><td data-mobile-label="Status"><span class="proc-status ${getConfig().mode!=="local"&&data.outbox.some(op=>op.type==="purchase.save"&&op.payload.purchase.purchaseNo===p.purchaseNo)?"pending":""}">${getConfig().mode!=="local"&&data.outbox.some(op=>op.type==="purchase.save"&&op.payload.purchase.purchaseNo===p.purchaseNo)?"Pending sync":"Received"}</span></td></tr>`).join("")}</tbody></table>`:`<div class="proc-empty">No purchases found.</div>`; box.querySelectorAll("[data-purchase-id]").forEach(b=>b.onclick=()=>{const p=data.purchases.find(x=>Number(x.id)===Number(b.dataset.purchaseId));if(p)purchaseDetails(p);}); };
  root.querySelector("#supplierSearch").oninput=renderSup;root.querySelector("#purchaseSearch").oninput=renderPur;root.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{root.querySelectorAll("[data-tab]").forEach(x=>x.classList.toggle("active",x===b));root.querySelector("#supplierTab").classList.toggle("hidden",b.dataset.tab!=="suppliers");root.querySelector("#purchaseTab").classList.toggle("hidden",b.dataset.tab!=="purchases");});
  root.querySelector("#supplierSearch").value=supplierQuery;root.querySelector("#purchaseSearch").value=purchaseQuery;
  renderSup(); renderPur();
  if(selectedTab==="purchases")root.querySelector('[data-tab="purchases"]').click();
  root.querySelector("[data-proc-retry]").onclick=async()=>{const button=root.querySelector("[data-proc-retry]");const restore=setButtonBusy(button,"Syncing…");try{const ok=await resumeProcurement({refresh:true});if(ok&&mounted(root,generation))render(root,generation);}finally{restore();updateSyncStatus();}};
  updateSyncStatus();
}

const STYLE=`.proc-wrap{padding:28px 34px}.proc-head{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:4px}.proc-kicker{margin:0;color:var(--muted);font-size:16px}.proc-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:22px 0}.proc-stats>div,.proc-card{background:var(--card,#fff);border:1px solid var(--border,#e4e8ef);border-radius:16px}.proc-stats>div{padding:18px 20px}.proc-stats span{display:block;color:var(--muted);font-size:13px}.proc-stats b{display:block;font-size:23px;margin-top:7px}.proc-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px}.proc-tabs button{border:0;background:transparent;padding:11px 16px;color:var(--muted);font-weight:700;cursor:pointer;border-bottom:2px solid transparent}.proc-tabs button.active{color:var(--primary);border-color:var(--primary)}.proc-card{overflow:hidden}.proc-search{padding:16px;border-bottom:1px solid var(--border)}.proc-table{overflow:auto}.proc-table table{width:100%;border-collapse:collapse}.proc-table th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);text-align:left;background:var(--surface,#f8fafc);padding:12px 16px}.proc-table td{padding:14px 16px;border-top:1px solid var(--border);vertical-align:middle}.proc-table small{display:block;color:var(--muted);margin-top:3px}.proc-status{display:inline-flex;padding:6px 10px;border-radius:999px;background:#eaf8ef;color:#15803d;font-weight:700;font-size:12px}.proc-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px}.proc-grid .field:last-child{grid-column:1/-1}.proc-lines{display:grid;gap:8px;margin:12px 0}.proc-line{display:grid;grid-template-columns:2.2fr .8fr .9fr .7fr 42px;gap:8px;align-items:center}.proc-empty{padding:30px;text-align:center;color:var(--muted)}.proc-total{display:flex;justify-content:flex-end;gap:8px;padding:14px 0;font-size:16px}@media(max-width:850px){.proc-wrap{padding:20px}.proc-head{flex-direction:column;align-items:stretch}.proc-stats{grid-template-columns:1fr}.proc-line{grid-template-columns:1fr 1fr}.proc-line select{grid-column:1/-1}.proc-grid{grid-template-columns:1fr}}`;
function injectStyle(){if(document.getElementById("proc-style"))return;const s=document.createElement("style");s.id="proc-style";s.textContent=STYLE;document.head.appendChild(s);}

export async function mount(root) {
  const generation = ++mountGeneration;
  activeRoot = root;
  injectStyle();
  await loadCache();
  if (!mounted(root,generation)) return;
  try{checkStore();}catch(e){syncError=e.message;root.innerHTML=`<div class="empty"><h4>Procurement connection mismatch</h4><p>${esc(e.message)}</p></div>`;notifyProcurement();return;}
  render(root,generation);
  const hasCache = data.suppliers.length || data.purchases.length || data.purchaseItems.length || data.lastPull;
  const cfg = getConfig();
  if (cfg.mode !== "local" && navigator.onLine) {
    (data.outbox.length ? resumeProcurement() : refreshCloud()).then(changed => { if(changed && mounted(root,generation)) render(root,generation); }).catch(e => { if(!hasCache && mounted(root,generation)){root.innerHTML=`<div class="empty"><div class="big">⚠️</div><h4>Supplier data couldn't load</h4><p>${esc(e.message)}</p><button class="btn btn-primary" id="procRetry">Retry</button></div>`;const b=root.querySelector("#procRetry");if(b)b.onclick=()=>mount(root);} else if(mounted(root,generation)){syncError=e.message;notifyProcurement();toast("Supplier data could not refresh: "+e.message,"warn");} });
  }
}
export function unmount(){ mountGeneration++; activeRoot=null; }
export function refresh(){ const root=document.getElementById("view"); if(root&&location.hash.includes("procurement")) mount(root); }
