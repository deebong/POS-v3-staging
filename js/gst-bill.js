// Print-ready GST tax invoice.
// Uses the same sale/item records as the normal receipt, with company, customer,
// taxable-value and tax details. Browser printing can save the invoice as PDF.
import { esc, money } from "./ui.js";
import { state } from "./store.js";

const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const r2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

function storePhones(settings) {
  try {
    const a = JSON.parse(settings.phoneNumbers || "[]");
    if (Array.isArray(a) && a.length) return a.map(x => x.number).filter(Boolean).join(" · ");
  } catch {}
  return settings.phone || "";
}

export function gstBillHtml(sale, items = [], settings = {}, { word = false } = {}) {
  const discountRatio = num(sale.subtotal) > 0 ? num(sale.discount) / num(sale.subtotal) : 0;
  const lines = items.map((it) => {
    const taxable = r2(num(it.lineSubtotal) * (1 - discountRatio));
    const tax = r2(taxable * num(it.taxRate) / 100);
    const productNameTa = it.nameTa || state.products.find(p => Number(p.id) === Number(it.productId))?.nameTa || "";
    return { ...it, nameTa: productNameTa, taxable, tax, lineTotal: r2(taxable + tax) };
  });
  const taxableTotal = r2(lines.reduce((s, x) => s + x.taxable, 0));
  const taxTotal = r2(lines.reduce((s, x) => s + x.tax, 0));
  const total = r2(taxableTotal + taxTotal);
  const rates = [...new Set(lines.map(x => num(x.taxRate)).filter(x => x > 0))].sort((a,b) => a-b);
  const company = settings.storeName || "Store";
  const phone = storePhones(settings);
  const currency = settings.currency || "₹";
  // Use a numeric HTML entity for the Indian rupee in exported HTML/Word documents.
  // This avoids legacy Word/HTML charset handling that can drop the ₹ glyph.
  const currencyMarkup = currency === "₹" ? "&#8377;" : esc(currency);
  const taxLabel = settings.taxLabel || "GST";
  const customer = sale.customerName || "Walk-in customer";

  const rows = lines.map((it) => `
    <tr>
      <td><b>${esc(it.name || "")}</b>${it.nameTa ? `<div class="muted" lang="ta">${esc(it.nameTa)}</div>` : ""}<div class="muted">${esc(it.sku || "—")}</div></td>
      <td class="r">${esc(String(it.qty ?? ""))} ${esc(it.unit || "")}</td>
      <td class="r">${currencyMarkup}${num(it.price).toFixed(2)}</td>
      <td class="r">${currencyMarkup}${it.taxable.toFixed(2)}</td>
      <td class="r">${num(it.taxRate).toFixed(2)}%</td>
      <td class="r">${currencyMarkup}${it.tax.toFixed(2)}</td>
      <td class="r"><b>${currencyMarkup}${it.lineTotal.toFixed(2)}</b></td>
    </tr>`).join("");

  const theme = ["classic", "modern", "minimal", "emerald"].includes(settings.gstInvoiceTheme) ? settings.gstInvoiceTheme : "classic";
  const topBorder = { classic: "2px solid #111827", modern: "4px solid #2563eb", minimal: "1px solid #9ca3af", emerald: "4px solid #047857" }[theme];
  const headerBg = { classic: "#f3f4f6", modern: "#dbeafe", minimal: "#ffffff", emerald: "#d1fae5" }[theme];
  if (word) return wordInvoice({ sale, lines, settings, theme, topBorder, headerBg, company, phone, currencyMarkup, taxLabel, customer, taxableTotal, taxTotal, total, rates });
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>GST Bill ${esc(sale.invoiceNo)}</title>
<style>
.gst-invoice,.gst-invoice *{box-sizing:border-box}
.gst-invoice{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#111827;font-size:12px;max-width:900px;margin:0 auto;padding:28px;line-height:1.45}
.gst-invoice .top{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #111827;padding-bottom:16px}
.gst-invoice.theme-modern .top{border-bottom:4px solid #2563eb}.gst-invoice.theme-modern .box{border-radius:2px;border-color:#bfdbfe}.gst-invoice.theme-modern th{background:#dbeafe}
.gst-invoice.theme-minimal .top{border-bottom:1px solid #9ca3af}.gst-invoice.theme-minimal .box{border:0;border-radius:0;border-left:2px solid #d1d5db}.gst-invoice.theme-minimal th{background:#fff;border-bottom:2px solid #111827}
.gst-invoice.theme-emerald .top{border-bottom:4px solid #047857}.gst-invoice.theme-emerald .box{border-color:#a7f3d0}.gst-invoice.theme-emerald th{background:#d1fae5}
.gst-invoice .company h1{font-size:22px;margin:0 0 5px}.gst-invoice .company div{margin:2px 0;color:#4b5563}.gst-invoice .title{text-align:right}.gst-invoice .title h2{margin:0 0 6px;font-size:20px}.gst-invoice .title b{font-size:13px}
.gst-invoice .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:18px 0}.gst-invoice .box{border:1px solid #d1d5db;border-radius:8px;padding:12px}.gst-invoice .box h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin:0 0 7px;color:#6b7280}.gst-invoice .box p{margin:3px 0}
.gst-invoice table{width:100%;border-collapse:collapse;margin-top:14px}.gst-invoice th{background:#f3f4f6;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#111827;position:static}.gst-invoice th,.gst-invoice td{border:1px solid #d1d5db;padding:8px}.gst-invoice td.r,.gst-invoice th.r{text-align:right}.gst-invoice .muted{font-size:10px;color:#6b7280;margin-top:2px}
.gst-invoice .summary{margin-left:auto;width:330px;max-width:100%;margin-top:14px}.gst-invoice .sum{display:flex;justify-content:space-between;padding:5px 0}.gst-invoice .grand{border-top:2px solid #111827;font-size:16px;font-weight:800;padding-top:9px}
.gst-invoice .taxbox{margin-top:16px;border:1px solid #d1d5db;padding:10px}.gst-invoice .footer{margin-top:24px;border-top:1px solid #d1d5db;padding-top:12px;color:#6b7280}
/* Distinct visual systems, not just accent colours. */
.gst-invoice.theme-classic .title h2{font-family:Georgia,"Times New Roman",serif;letter-spacing:.01em}
.gst-invoice.theme-classic .grand{border-bottom:1px solid #111827;padding-bottom:7px}
.gst-invoice.theme-modern .company h1{color:#1d4ed8;font-size:25px}.gst-invoice.theme-modern .title{background:#eff6ff;border-radius:4px;padding:10px 14px}.gst-invoice.theme-modern .title h2{color:#1d4ed8;font-size:18px}
.gst-invoice.theme-modern .grid{grid-template-columns:1.3fr .7fr}.gst-invoice.theme-modern .box{background:#f8fbff}.gst-invoice.theme-modern td{border-left:0;border-right:0}.gst-invoice.theme-modern .grand{background:#eff6ff;border-color:#2563eb;color:#1d4ed8;padding:10px 12px}.gst-invoice.theme-modern .taxbox{border-color:#bfdbfe}
.gst-invoice.theme-minimal{font-size:11px;line-height:1.35}.gst-invoice.theme-minimal .top{display:block;padding-bottom:10px}.gst-invoice.theme-minimal .title{text-align:left;display:flex;flex-wrap:wrap;gap:5px 16px;align-items:baseline;margin-top:8px}.gst-invoice.theme-minimal .title h2{font-size:14px;margin:0}.gst-invoice.theme-minimal .title b{font-size:11px}.gst-invoice.theme-minimal .company h1{font-size:27px;letter-spacing:-.025em}.gst-invoice.theme-minimal .grid{gap:18px;margin:10px 0}.gst-invoice.theme-minimal .box{padding:4px 8px}.gst-invoice.theme-minimal th,.gst-invoice.theme-minimal td{border-left:0;border-right:0;padding:5px 4px}.gst-invoice.theme-minimal th{border-top:0}.gst-invoice.theme-minimal .summary{width:280px}.gst-invoice.theme-minimal .sum{padding:3px 0}.gst-invoice.theme-minimal .taxbox{border:0;padding:0;margin-top:10px}.gst-invoice.theme-minimal .footer{margin-top:12px;padding-top:6px}
.gst-invoice.theme-emerald .top{flex-direction:row-reverse;background:#ecfdf5;padding:14px;align-items:center}.gst-invoice.theme-emerald .title{text-align:left}.gst-invoice.theme-emerald .title h2{color:#065f46;font-size:18px}.gst-invoice.theme-emerald .company{text-align:right}.gst-invoice.theme-emerald .company h1{color:#065f46;font-size:23px}.gst-invoice.theme-emerald .box{border:0;border-top:2px solid #047857;background:#f0fdf4;border-radius:0;padding:10px}.gst-invoice.theme-emerald .summary{width:100%;padding:10px 14px;background:#f0fdf4}.gst-invoice.theme-emerald .summary .sum{max-width:340px;margin-left:auto}.gst-invoice.theme-emerald .grand{color:#065f46;border-color:#047857}.gst-invoice.theme-emerald .taxbox{border-color:#a7f3d0}
@media print{.gst-invoice{font-size:11px;max-width:none;padding:4mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}.gst-invoice .no-print{display:none!important}.gst-invoice thead{display:table-header-group}.gst-invoice tr,.gst-invoice .summary,.gst-invoice .taxbox{break-inside:avoid;page-break-inside:avoid}@page{size:A4;margin:8mm}}
</style></head><body class="theme-${theme}"><main class="invoice gst-invoice theme-${theme}">
<section class="top" style="border-bottom:${topBorder}"><div class="company"><h1>${esc(company)}</h1>
${settings.address ? `<div>${esc(settings.address)}</div>` : ""}
${phone ? `<div>Phone: ${esc(phone)}</div>` : ""}
${settings.taxId ? `<div><b>${esc(taxLabel)}IN / Tax ID:</b> ${esc(settings.taxId)}</div>` : ""}</div>
<div class="title"><h2>TAX INVOICE / GST BILL</h2><div>Invoice: <b>${esc(sale.invoiceNo)}</b></div><div>Date: ${esc(new Date(sale.createdAt).toLocaleString())}</div><div>Status: ${esc(sale.status || "completed")}</div></div></section>

<section class="grid"><div class="box"><h3>Bill To</h3><p><b>${esc(customer)}</b></p>${sale.customerAddress ? `<p>${esc(sale.customerAddress)}</p>` : ""}${sale.customerPhone ? `<p>Phone: ${esc(sale.customerPhone)}</p>` : ""}</div>
<div class="box"><h3>Payment</h3><p>Method: <b>${esc(sale.paymentMethod === "upi" ? "UPI / QR" : sale.paymentMethod === "card" ? "Card" : "Cash")}</b></p><p>Amount paid: <b>${currencyMarkup}${num(sale.amountPaid).toFixed(2)}</b></p>${num(sale.changeDue)>0 ? `<p>Change due: ${currencyMarkup}${num(sale.changeDue).toFixed(2)}</p>` : ""}</div></section>

<table><thead><tr><th style="background-color:${headerBg}">Item / SKU</th><th class="r" style="background-color:${headerBg}">Qty</th><th class="r" style="background-color:${headerBg}">Rate</th><th class="r" style="background-color:${headerBg}">Taxable</th><th class="r" style="background-color:${headerBg}">${esc(taxLabel)} %</th><th class="r" style="background-color:${headerBg}">Tax</th><th class="r" style="background-color:${headerBg}">Line total</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No line items</td></tr>'}</tbody></table>

<div class="summary"><div class="sum"><span>Subtotal</span><b>${currencyMarkup}${num(sale.subtotal).toFixed(2)}</b></div><div class="sum"><span>Discount</span><b>− ${currencyMarkup}${num(sale.discount).toFixed(2)}</b></div><div class="sum"><span>Taxable value</span><b>${currencyMarkup}${taxableTotal.toFixed(2)}</b></div><div class="sum"><span>${esc(taxLabel)}</span><b>${currencyMarkup}${taxTotal.toFixed(2)}</b></div><div class="sum grand"><span>Grand Total</span><span>${currencyMarkup}${total.toFixed(2)}</span></div></div>

<div class="taxbox"><b>Tax summary</b><div class="muted">${rates.length ? rates.map(r => `${r.toFixed(2)}% ${esc(taxLabel)}: ${currencyMarkup}${lines.filter(x=>num(x.taxRate)===r).reduce((s,x)=>s+x.tax,0).toFixed(2)}`).join(" · ") : "No GST/tax charged on this invoice."}</div></div>
<div class="footer">${settings.receiptFooter ? esc(settings.receiptFooter) : "Thank you for your business."}</div>
</main></body></html>`;
}

// Word imports HTML differently from browsers. Use conventional tables, explicit
// point measurements and Word's page-section CSS instead of Grid/Flexbox.
function wordInvoice({sale,lines,settings,theme,topBorder,headerBg,company,phone,currencyMarkup,taxLabel,customer,taxableTotal,taxTotal,total,rates}) {
  const accent={classic:"#111827",modern:"#1d4ed8",minimal:"#374151",emerald:"#065f46"}[theme];
  const tint={classic:"#f3f4f6",modern:"#eff6ff",minimal:"#ffffff",emerald:"#ecfdf5"}[theme];
  const amount=v=>currencyMarkup+num(v).toFixed(2);
  const p=(content,extra="")=>`<p style="margin:0;line-height:12pt;${extra}">${content}</p>`;
  const table=(content,attrs="")=>`<table width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;table-layout:fixed;mso-table-lspace:0pt;mso-table-rspace:0pt" ${attrs}>${content}</table>`;
  const cell=(content,width,style="")=>`<td width="${width}%" valign="top" style="width:${width}%;padding:3pt 4pt;vertical-align:top;${style}">${content}</td>`;
  const lineBorder=theme==="minimal"||theme==="modern"?"border-bottom:0.5pt solid #cbd5e1;":"border:0.5pt solid #cbd5e1;";
  const widths=[30,8,12,13,8,12,17];
  const headings=["Item / SKU","Qty","Rate","Taxable",esc(taxLabel)+" %","Tax","Line total"];
  const header=`<thead><tr>${headings.map((h,i)=>`<th width="${widths[i]}%" style="width:${widths[i]}%;background:${headerBg};color:${accent};font-size:8pt;font-weight:bold;text-align:${i?"right":"left"};padding:4pt 3pt;${lineBorder}">${h}</th>`).join("")}</tr></thead>`;
  const body=lines.map(it=>{
    const product=p(`<b>${esc(it.name||"")}</b>`)+(it.nameTa?p(esc(it.nameTa),'font-size:8pt;color:#4b5563;'):"")+p(esc(it.sku||"—"),"font-size:7.5pt;color:#6b7280;");
    const vals=[product,esc(String(it.qty??""))+" "+esc(it.unit||""),amount(it.price),amount(it.taxable),num(it.taxRate).toFixed(2)+"%",amount(it.tax),"<b>"+amount(it.lineTotal)+"</b>"];
    return `<tr style="page-break-inside:avoid">${vals.map((v,i)=>cell(i?p(v):v,widths[i],lineBorder+(i?"text-align:right;":""))).join("")}</tr>`;
  }).join("");
  const companyBlock=p(`<b style="font-size:15pt;color:${accent}">${esc(company)}</b>`,"line-height:18pt;")+
    (settings.address?p(esc(settings.address)):"")+(phone?p("Phone: "+esc(phone)):"")+(settings.taxId?p("<b>"+esc(taxLabel)+"IN / Tax ID:</b> "+esc(settings.taxId)):"");
  const titleBlock=p(`<b style="font-size:12pt;color:${accent}">TAX INVOICE / GST BILL</b>`,"line-height:15pt;")+
    p("Invoice: <b>"+esc(sale.invoiceNo)+"</b>")+p("Date: "+esc(new Date(sale.createdAt).toLocaleString()))+p("Status: "+esc(sale.status||"completed"));
  const headerCells=theme==="emerald" ? cell(titleBlock,43,"background:"+tint+";")+cell(companyBlock,57,"text-align:right;background:"+tint+";") : cell(companyBlock,57)+cell(titleBlock,43,"text-align:right;"+(theme==="modern"?"background:"+tint+";":""));
  const payment=sale.paymentMethod==="upi"?"UPI / QR":sale.paymentMethod==="card"?"Card":sale.paymentMethod==="cash"?"Cash":String(sale.paymentMethod||"—");
  const billTo=p(`<b style="color:${accent}">BILL TO</b>`)+p("<b>"+esc(customer)+"</b>")+(sale.customerAddress?p(esc(sale.customerAddress)):"")+(sale.customerPhone?p("Phone: "+esc(sale.customerPhone)):"");
  const pay=p(`<b style="color:${accent}">PAYMENT</b>`)+p("Method: "+esc(payment))+p("Amount paid: <b>"+amount(sale.amountPaid)+"</b>")+(num(sale.changeDue)>0?p("Change due: "+amount(sale.changeDue)):"");
  const taxInfo=p("<b>Tax summary</b>")+(rates.length?rates.map(r=>p(r.toFixed(2)+"% "+esc(taxLabel)+": "+amount(lines.filter(x=>num(x.taxRate)===r).reduce((s,x)=>s+x.tax,0)),"font-size:8pt;")).join(""):p("No GST/tax charged on this invoice.","font-size:8pt;"));
  const sums=[["Subtotal",amount(sale.subtotal)],["Discount","− "+amount(sale.discount)],["Taxable value",amount(taxableTotal)],[esc(taxLabel),amount(taxTotal)],["Grand Total",amount(total)]];
  const summary=table(sums.map(([label,value],i)=>`<tr>${cell(p(i===4?"<b>"+label+"</b>":label),54,i===4?"border-top:1pt solid "+accent+";background:"+tint+";":"")}${cell(p("<b>"+value+"</b>",i===4?"font-size:11pt;color:"+accent+";":""),46,"text-align:right;"+(i===4?"border-top:1pt solid "+accent+";background:"+tint+";":""))}</tr>`).join(""));
  return `<!doctype html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>GST Bill ${esc(sale.invoiceNo)}</title>
<style>@page WordSection1{size:595.3pt 841.9pt;margin:32pt 36pt 32pt 36pt;mso-header-margin:0pt;mso-footer-margin:0pt}div.WordSection1{page:WordSection1}body{font-family:Arial,Helvetica,sans-serif;font-size:9pt;color:#111827;margin:0;padding:0}p{margin:0;line-height:12pt;mso-margin-top-alt:0pt;mso-margin-bottom-alt:0pt}table{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt}thead{display:table-header-group}tr{page-break-inside:avoid}td,th{vertical-align:top}</style></head>
<body><div class="invoice gst-invoice theme-${theme}"><div class="WordSection1">
${table("<tr>"+headerCells+"</tr>")}
${table(`<tr><td style="height:3pt;font-size:1pt;border-bottom:${topBorder};">&nbsp;</td></tr>`)}
${table("<tr>"+cell(billTo,57,"padding-top:6pt;padding-bottom:6pt;")+cell(pay,43,"padding-top:6pt;padding-bottom:6pt;")+"</tr>")}
${table(header+"<tbody>"+(body||'<tr><td colspan="7">No line items</td></tr>')+"</tbody>")}
${table("<tr>"+cell(taxInfo,52,"padding-top:7pt;")+cell(summary,48,"padding:6pt 0 0 4pt;")+"</tr>")}
${settings.receiptFooter?p(esc(settings.receiptFooter),"font-size:8pt;color:#6b7280;margin-top:6pt;"):p("Thank you for your business.","font-size:8pt;color:#6b7280;margin-top:6pt;")}
</div></div></body></html>`;
}

export function gstBillDocument(sale, items, settings) {
  return gstBillHtml(sale, items, settings, { word: true });
}
