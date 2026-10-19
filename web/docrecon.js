/**
 * docrecon — deterministic reconciliation of Commercial Invoice ↔ Packing List ↔ Bill of Lading.
 *
 * JavaScript port of the Dalteno.DocRecon (.NET 10) rule engine. Both implementations must produce
 * identical findings for every case under /cases (parity is a CI gate, see tests/parity.test.mjs).
 *
 * Design rules (ADR-0001..0003):
 *  - all money / quantity / weight arithmetic is integer arithmetic in minor units (no floats);
 *  - every finding names the rule, the field, both values and the reason — never a bare "mismatch";
 *  - no I/O, no clock, no randomness: same bundle + same options ⇒ same report, byte for byte.
 */

export const VERSION = "1.0.0";

/** Scales for integer arithmetic (ADR-0002). */
export const SCALE = Object.freeze({ MONEY: 100, QTY: 1000, KG: 1000 });

export const SEVERITY = Object.freeze({ BLOCKER: "BLOCKER", WARNING: "WARNING", INFO: "INFO" });

/** Default options. Tolerances are expressed in basis points (1 bp = 0.01 %) to stay integer-only. */
export const DEFAULT_OPTIONS = Object.freeze({
  qtyToleranceBp: 0,
  weightToleranceBp: 200, // 2 %
  packageToleranceBp: 0,
  amountToleranceMinor: 1, // 0.01 in invoice currency (covers legitimate rounding on line totals)
  maxDocumentSpanDays: 60,
  knownIncoterms: Object.freeze(["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"]),
  legalSuffixes: Object.freeze(["GMBH", "AG", "LTD", "LIMITED", "LLC", "INC", "CO", "BV", "NV", "SA", "SARL", "SAS", "SRL", "SPA", "PLC", "KG", "OHG", "UG", "SE", "LLP", "PTY", "CORP", "CORPORATION", "COMPANY"]),
});

/** Rule catalogue — id, severity, one-line contract. The ids are stable and shared with the C# implementation. */
export const RULES = Object.freeze([
  r("R01", "PACKING_INVOICE_REF", SEVERITY.BLOCKER, "Packing list must reference the invoice number."),
  r("R02", "BL_SHIPMENT_REF", SEVERITY.BLOCKER, "Bill of lading and packing list must carry the same shipment reference."),
  r("R03", "LINE_MISSING_IN_PACKING", SEVERITY.BLOCKER, "Every invoiced SKU must appear on the packing list."),
  r("R04", "LINE_EXTRA_IN_PACKING", SEVERITY.BLOCKER, "Every packed SKU must appear on the invoice."),
  r("R05", "QTY_MISMATCH", SEVERITY.BLOCKER, "Invoiced quantity must equal packed quantity per SKU (within tolerance)."),
  r("R06", "LINE_TOTAL_ARITHMETIC", SEVERITY.BLOCKER, "quantity × unit price must equal the line total (±amount tolerance)."),
  r("R07", "INVOICE_TOTAL_ARITHMETIC", SEVERITY.BLOCKER, "Sum of line totals must equal the invoice total (±amount tolerance)."),
  r("R08", "CURRENCY_MIXED", SEVERITY.BLOCKER, "A line priced in a currency other than the invoice currency."),
  r("R09", "GROSS_WEIGHT_BL_VS_PACKING", SEVERITY.WARNING, "BL gross weight must match packing-list gross weight within tolerance."),
  r("R10", "NET_GT_GROSS", SEVERITY.BLOCKER, "Net weight can never exceed gross weight."),
  r("R11", "PACKAGE_COUNT_BL_VS_PACKING", SEVERITY.WARNING, "BL package count must match packing-list package count."),
  r("R12", "DATE_ORDER", SEVERITY.WARNING, "invoice date ≤ packing date ≤ shipped-on-board date, within the allowed span."),
  r("R13", "HS_CODE_FORMAT", SEVERITY.INFO, "HS code must be 6–10 digits (separators ignored)."),
  r("R14", "HS_CODE_CONFLICT", SEVERITY.WARNING, "The same SKU must carry the same HS code on invoice and packing list."),
  r("R15", "DUPLICATE_SKU_CONFLICT", SEVERITY.WARNING, "A SKU repeated on the invoice with a different unit price or HS code."),
  r("R16", "NON_POSITIVE_VALUE", SEVERITY.BLOCKER, "Quantities, prices, weights and package counts must be > 0."),
  r("R17", "CONSIGNEE_MISMATCH", SEVERITY.WARNING, "BL consignee must match the invoice buyer (normalised, legal suffix ignored)."),
  r("R18", "INCOTERM_UNKNOWN", SEVERITY.INFO, "Incoterm must be one of the Incoterms 2020 codes."),
  r("R19", "UNIT_MISMATCH", SEVERITY.BLOCKER, "Unit of measure must agree per SKU between invoice and packing list."),
  r("R20", "PACKING_TOTALS_ARITHMETIC", SEVERITY.WARNING, "Packing-list totals must equal the sum of their lines (packages, net, gross)."),
  r("R21", "MISSING_REQUIRED", SEVERITY.BLOCKER, "A required document, field or line set is absent."),
]);
function r(id, code, severity, contract) { return Object.freeze({ id, code, severity, contract }); }
const RULE_BY_ID = Object.fromEntries(RULES.map((x) => [x.id, x]));

// ───────────────────────────────────────────── helpers (pure) ─────────────────────────────────────────────

/** Parse a decimal (number or string) into integer minor units, half away from zero. Returns null for absent/invalid. */
export function toMinor(value, scale) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  // Commas are accepted only as thousands separators in the exact English grouping ("1,200.50"); "1.200,00" and "1,5"
  // are NOT silently reinterpreted — they return null and the caller reports R21 (ADR-0002: fail loud, never guess).
  if (raw.includes(",") && !/^[-+]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(raw)) return null;
  const s = raw.replace(/,/g, "");
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [ip, fp = ""] = s.replace(/^[-+]/, "").split(".");
  const digits = String(scale).length - 1; // 100 → 2, 1000 → 3
  const frac = (fp + "0".repeat(digits + 1)).slice(0, digits + 1); // one guard digit
  let minor = BigInt(ip || "0") * BigInt(scale) + BigInt(frac.slice(0, digits));
  if (Number(frac[digits]) >= 5) minor += 1n; // half away from zero on the guard digit
  // remaining digits beyond the guard are truncated; inputs are specified to ≤ scale precision (ADR-0002)
  return neg ? -minor : minor;
}

/** Format integer minor units back to a decimal string. */
export function fromMinor(minor, scale) {
  if (minor === null || minor === undefined) return null;
  const digits = String(scale).length - 1;
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const ip = abs / BigInt(scale), fp = (abs % BigInt(scale)).toString().padStart(digits, "0");
  return `${neg ? "-" : ""}${ip}${digits ? "." + fp : ""}`;
}

/** Integer multiply of two scaled values → money minor units, half away from zero. qty(QTY) × price(MONEY) / QTY. */
export function mulQtyPrice(qtyMinor, priceMinor) {
  const num = qtyMinor * priceMinor, den = BigInt(SCALE.QTY);
  const q = num / den, rem = num % den; // BigInt division truncates toward zero
  const absRem = rem < 0n ? -rem : rem;
  if (absRem * 2n >= den) return q + (num < 0n ? -1n : 1n);
  return q;
}

/** |a − b| × 10000 > bp × max(|a|,|b|)  — integer tolerance test in basis points. */
export function exceedsTolerance(a, b, bp) {
  const diff = a > b ? a - b : b - a;
  const base = (a < 0n ? -a : a) > (b < 0n ? -b : b) ? (a < 0n ? -a : a) : (b < 0n ? -b : b);
  return diff * 10000n > BigInt(bp) * base;
}

export function normKey(s) { return s === null || s === undefined ? "" : String(s).trim().replace(/\s+/g, " ").toUpperCase(); }

/** Party-name normalisation: uppercase, strip punctuation, collapse spaces, drop trailing legal suffixes. */
export function normParty(s, suffixes) {
  const tokens = normKey(s).replace(/[.,;:'"()&/\\-]+/g, " ").split(" ").filter(Boolean);
  while (tokens.length > 1 && suffixes.includes(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

export function normHs(s) { return s === null || s === undefined ? "" : String(s).replace(/[.\s-]/g, ""); }

/** ISO date "YYYY-MM-DD" → day number (proleptic Gregorian), or null if invalid. */
export function dayNumber(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return null;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return null;
  // days from civil (Howard Hinnant), exact integer arithmetic
  const yy = m <= 2 ? y - 1 : y, era = Math.floor(yy / 400), yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// ───────────────────────────────────────────── engine ─────────────────────────────────────────────

/**
 * Reconcile a document bundle.
 * @param {object} bundle {invoice, packingList, billOfLading}
 * @param {object} [options] overrides of DEFAULT_OPTIONS
 * @returns {{status:string, findings:object[], summary:object, rulesEvaluated:number, version:string}}
 */
export function reconcile(bundle, options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const findings = [];
  const add = (ruleId, key, field, expected, actual, reason, documents) => {
    const rule = RULE_BY_ID[ruleId];
    findings.push({ rule: rule.id, code: rule.code, severity: rule.severity, key: String(key), field, expected: expected === undefined ? null : expected, actual: actual === undefined ? null : actual, reason, documents });
  };

  const inv = bundle?.invoice ?? null, pl = bundle?.packingList ?? null, bl = bundle?.billOfLading ?? null;

  // R21 structural requirements — evaluated first; other rules skip what is absent (never crash, never guess)
  if (!inv) add("R21", "invoice", "invoice", "document", "absent", "Commercial invoice is required.", ["invoice"]);
  if (!pl) add("R21", "packingList", "packingList", "document", "absent", "Packing list is required.", ["packingList"]);
  if (!bl) add("R21", "billOfLading", "billOfLading", "document", "absent", "Bill of lading is required.", ["billOfLading"]);
  const req = (doc, name, field) => {
    if (!doc) return false;
    const v = doc[field];
    const ok = field === "lines" ? Array.isArray(v) && v.length > 0 : Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== "";
    if (!ok) add("R21", `${name}.${field}`, field, "present", "absent", `${name}.${field} is required.`, [name]);
    return ok;
  };
  const invNo = req(inv, "invoice", "number"), invCur = req(inv, "invoice", "currency"), invLines = req(inv, "invoice", "lines"), invTotal = req(inv, "invoice", "total");
  const plNo = req(pl, "packingList", "number"), plLines = req(pl, "packingList", "lines");
  req(bl, "billOfLading", "number");

  // ── per-line validation + aggregation per SKU ──
  const invBySku = new Map(), plBySku = new Map();
  const nonPositive = (doc, name, idx, sku, field, minor) => {
    if (minor !== null && minor <= 0n) add("R16", `${name}:${sku}:${field}`, field, "> 0", fromMinor(minor, field === "qty" ? SCALE.QTY : field === "unitPrice" || field === "lineTotal" ? SCALE.MONEY : SCALE.KG), `${name} line ${idx + 1} (${sku}) has a non-positive ${field}.`, [name]);
  };
  if (invLines) {
    inv.lines.forEach((raw, i) => {
      const ln = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}; // a non-object line is a line with nothing on it
      const sku = normKey(ln.sku);
      if (!sku) { add("R21", `invoice.lines[${i}].sku`, "sku", "present", "absent", `Invoice line ${i + 1} has no SKU.`, ["invoice"]); return; }
      const qty = toMinor(ln.qty, SCALE.QTY), price = toMinor(ln.unitPrice, SCALE.MONEY), total = toMinor(ln.lineTotal, SCALE.MONEY);
      nonPositive(inv, "invoice", i, sku, "qty", qty); nonPositive(inv, "invoice", i, sku, "unitPrice", price);
      if (qty === null) add("R21", `invoice:${sku}:qty`, "qty", "number", String(ln.qty ?? "absent"), `Invoice line ${sku}: qty is not a number.`, ["invoice"]);
      if (price === null) add("R21", `invoice:${sku}:unitPrice`, "unitPrice", "number", String(ln.unitPrice ?? "absent"), `Invoice line ${sku}: unitPrice is not a number.`, ["invoice"]);
      if (total === null) add("R21", `invoice:${sku}:lineTotal`, "lineTotal", "number", String(ln.lineTotal ?? "absent"), `Invoice line ${sku}: lineTotal is not a number.`, ["invoice"]);
      if (qty !== null && price !== null && total !== null) {
        const calc = mulQtyPrice(qty, price), diff = calc > total ? calc - total : total - calc;
        if (diff > BigInt(opt.amountToleranceMinor)) add("R06", sku, "lineTotal", fromMinor(calc, SCALE.MONEY), fromMinor(total, SCALE.MONEY), `${fromMinor(qty, SCALE.QTY)} × ${fromMinor(price, SCALE.MONEY)} = ${fromMinor(calc, SCALE.MONEY)}, invoice says ${fromMinor(total, SCALE.MONEY)}.`, ["invoice"]);
      }
      if (invCur && ln.currency && normKey(ln.currency) !== normKey(inv.currency)) add("R08", sku, "currency", normKey(inv.currency), normKey(ln.currency), `Line ${sku} is priced in ${normKey(ln.currency)} but the invoice currency is ${normKey(inv.currency)}.`, ["invoice"]);
      const hs = normHs(ln.hsCode);
      if (ln.hsCode !== undefined && ln.hsCode !== null && String(ln.hsCode) !== "" && !/^\d{6,10}$/.test(hs)) add("R13", `invoice:${sku}`, "hsCode", "6–10 digits", String(ln.hsCode), `Invoice line ${sku}: HS code "${ln.hsCode}" is not 6–10 digits.`, ["invoice"]);
      const agg = invBySku.get(sku);
      if (agg) {
        if ((price !== null && agg.price !== null && price !== agg.price) || (hs && agg.hs && hs !== agg.hs)) {
          if (!agg.dupFlagged) { add("R15", sku, "sku", `one price/HS for ${sku}`, `${fromMinor(agg.price, SCALE.MONEY)}/${agg.hs || "-"} vs ${fromMinor(price, SCALE.MONEY)}/${hs || "-"}`, `SKU ${sku} appears more than once on the invoice with conflicting unit price or HS code.`, ["invoice"]); agg.dupFlagged = true; }
        }
        agg.qty = qty === null || agg.qty === null ? null : agg.qty + qty; agg.total = total === null || agg.total === null ? null : agg.total + total;
      } else invBySku.set(sku, { qty, price, total, hs, unit: normKey(ln.unit), dupFlagged: false });
    });
  }
  if (plLines) {
    pl.lines.forEach((raw, i) => {
      const ln = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      const sku = normKey(ln.sku);
      if (!sku) { add("R21", `packingList.lines[${i}].sku`, "sku", "present", "absent", `Packing line ${i + 1} has no SKU.`, ["packingList"]); return; }
      const qty = toMinor(ln.qty, SCALE.QTY), net = toMinor(ln.netKg, SCALE.KG), gross = toMinor(ln.grossKg, SCALE.KG), pk = toMinor(ln.packages, 1);
      nonPositive(pl, "packingList", i, sku, "qty", qty); nonPositive(pl, "packingList", i, sku, "netKg", net); nonPositive(pl, "packingList", i, sku, "grossKg", gross);
      if (pk !== null && pk <= 0n) add("R16", `packingList:${sku}:packages`, "packages", "> 0", fromMinor(pk, 1), `Packing line ${i + 1} (${sku}) has a non-positive package count.`, ["packingList"]);
      if (qty === null) add("R21", `packingList:${sku}:qty`, "qty", "number", String(ln.qty ?? "absent"), `Packing line ${sku}: qty is not a number.`, ["packingList"]);
      if (net !== null && gross !== null && net > gross) add("R10", sku, "netKg", `≤ gross ${fromMinor(gross, SCALE.KG)}`, fromMinor(net, SCALE.KG), `Packing line ${sku}: net ${fromMinor(net, SCALE.KG)} kg exceeds gross ${fromMinor(gross, SCALE.KG)} kg.`, ["packingList"]);
      const hs = normHs(ln.hsCode);
      if (ln.hsCode !== undefined && ln.hsCode !== null && String(ln.hsCode) !== "" && !/^\d{6,10}$/.test(hs)) add("R13", `packingList:${sku}`, "hsCode", "6–10 digits", String(ln.hsCode), `Packing line ${sku}: HS code "${ln.hsCode}" is not 6–10 digits.`, ["packingList"]);
      const agg = plBySku.get(sku);
      if (agg) { agg.qty = qty === null || agg.qty === null ? null : agg.qty + qty; agg.net = sum(agg.net, net); agg.gross = sum(agg.gross, gross); agg.pk = sum(agg.pk, pk); if (!agg.hs) agg.hs = hs; }
      else plBySku.set(sku, { qty, net, gross, pk, hs, unit: normKey(ln.unit) });
    });
  }

  // ── cross-document line rules ──
  if (invLines && plLines) {
    for (const [sku, a] of invBySku) {
      const b = plBySku.get(sku);
      if (!b) { add("R03", sku, "sku", "present on packing list", "absent", `Invoiced SKU ${sku} is not on the packing list.`, ["invoice", "packingList"]); continue; }
      if (a.qty !== null && b.qty !== null && exceedsTolerance(a.qty, b.qty, opt.qtyToleranceBp)) add("R05", sku, "qty", fromMinor(a.qty, SCALE.QTY), fromMinor(b.qty, SCALE.QTY), `SKU ${sku}: invoiced ${fromMinor(a.qty, SCALE.QTY)}, packed ${fromMinor(b.qty, SCALE.QTY)}.`, ["invoice", "packingList"]);
      if (a.unit && b.unit && a.unit !== b.unit) add("R19", sku, "unit", a.unit, b.unit, `SKU ${sku}: invoice unit ${a.unit}, packing unit ${b.unit}.`, ["invoice", "packingList"]);
      if (a.hs && b.hs && a.hs !== b.hs) add("R14", sku, "hsCode", a.hs, b.hs, `SKU ${sku}: HS ${a.hs} on invoice, ${b.hs} on packing list.`, ["invoice", "packingList"]);
    }
    for (const sku of plBySku.keys()) if (!invBySku.has(sku)) add("R04", sku, "sku", "present on invoice", "absent", `Packed SKU ${sku} is not on the invoice.`, ["invoice", "packingList"]);
  }

  // ── invoice totals ──
  if (invLines && invTotal) {
    let sumLines = 0n, complete = true;
    for (const a of invBySku.values()) { if (a.total === null) { complete = false; break; } sumLines += a.total; }
    const total = toMinor(inv.total, SCALE.MONEY);
    if (total === null) add("R21", "invoice.total", "total", "number", String(inv.total), "Invoice total is not a number.", ["invoice"]);
    else if (complete) { const diff = sumLines > total ? sumLines - total : total - sumLines; if (diff > BigInt(opt.amountToleranceMinor)) add("R07", "invoice", "total", fromMinor(sumLines, SCALE.MONEY), fromMinor(total, SCALE.MONEY), `Line totals sum to ${fromMinor(sumLines, SCALE.MONEY)}, invoice total is ${fromMinor(total, SCALE.MONEY)}.`, ["invoice"]); }
  }
  if (inv && inv.incoterm !== undefined && inv.incoterm !== null && String(inv.incoterm) !== "" && !opt.knownIncoterms.includes(normKey(inv.incoterm))) add("R18", "invoice", "incoterm", opt.knownIncoterms.join("/"), String(inv.incoterm), `Incoterm "${inv.incoterm}" is not an Incoterms 2020 code.`, ["invoice"]);

  // ── packing list totals vs its lines ──
  let plPk = null, plNet = null, plGross = null;
  if (plLines) {
    let sPk = 0n, sNet = 0n, sGross = 0n, cPk = true, cNet = true, cGross = true;
    for (const b of plBySku.values()) { if (b.pk === null) cPk = false; else sPk += b.pk; if (b.net === null) cNet = false; else sNet += b.net; if (b.gross === null) cGross = false; else sGross += b.gross; }
    const chk = (field, declared, s, complete, scale) => {
      const d = toMinor(declared, scale);
      if (d === null) return complete ? s : null;
      if (complete && d !== s) add("R20", field, field, fromMinor(s, scale), fromMinor(d, scale), `Packing list declares ${field} ${fromMinor(d, scale)}, lines sum to ${fromMinor(s, scale)}.`, ["packingList"]);
      return d;
    };
    plPk = chk("totalPackages", pl.totalPackages, sPk, cPk, 1); plNet = chk("totalNetKg", pl.totalNetKg, sNet, cNet, SCALE.KG); plGross = chk("totalGrossKg", pl.totalGrossKg, sGross, cGross, SCALE.KG);
    if (plNet !== null && plGross !== null && plNet > plGross) add("R10", "TOTAL", "totalNetKg", `≤ gross ${fromMinor(plGross, SCALE.KG)}`, fromMinor(plNet, SCALE.KG), `Packing list total net ${fromMinor(plNet, SCALE.KG)} kg exceeds total gross ${fromMinor(plGross, SCALE.KG)} kg.`, ["packingList"]);
  }

  // ── references ──
  if (pl && invNo && plNo) { const ref = normKey(pl.invoiceRef); if (!ref) add("R21", "packingList.invoiceRef", "invoiceRef", "present", "absent", "Packing list must reference an invoice number.", ["packingList"]); else if (ref !== normKey(inv.number)) add("R01", "invoiceRef", "invoiceRef", normKey(inv.number), ref, `Packing list references invoice ${ref}, invoice number is ${normKey(inv.number)}.`, ["invoice", "packingList"]); }
  if (pl && bl) { const a = normKey(pl.shipmentRef), b = normKey(bl.shipmentRef); if (!a || !b) add("R21", "shipmentRef", "shipmentRef", "present on both", `${a || "absent"} / ${b || "absent"}`, "Shipment reference must be present on packing list and bill of lading.", ["packingList", "billOfLading"]); else if (a !== b) add("R02", "shipmentRef", "shipmentRef", a, b, `Packing list shipment ref ${a}, bill of lading shipment ref ${b}.`, ["packingList", "billOfLading"]); }

  // ── BL vs packing list physicals ──
  if (bl && plLines) {
    const blGross = toMinor(bl.grossKg, SCALE.KG), blPk = toMinor(bl.packages, 1);
    if (blGross !== null && blGross <= 0n) add("R16", "billOfLading:grossKg", "grossKg", "> 0", fromMinor(blGross, SCALE.KG), "Bill of lading gross weight is non-positive.", ["billOfLading"]);
    if (blPk !== null && blPk <= 0n) add("R16", "billOfLading:packages", "packages", "> 0", fromMinor(blPk, 1), "Bill of lading package count is non-positive.", ["billOfLading"]);
    if (blGross !== null && plGross !== null && blGross > 0n && plGross > 0n && exceedsTolerance(blGross, plGross, opt.weightToleranceBp)) add("R09", "grossKg", "grossKg", fromMinor(plGross, SCALE.KG), fromMinor(blGross, SCALE.KG), `BL gross ${fromMinor(blGross, SCALE.KG)} kg vs packing ${fromMinor(plGross, SCALE.KG)} kg exceeds ${opt.weightToleranceBp / 100} % tolerance.`, ["packingList", "billOfLading"]);
    if (blPk !== null && plPk !== null && blPk > 0n && plPk > 0n && exceedsTolerance(blPk, plPk, opt.packageToleranceBp)) add("R11", "packages", "packages", fromMinor(plPk, 1), fromMinor(blPk, 1), `BL declares ${blPk} packages, packing list ${plPk}.`, ["packingList", "billOfLading"]);
  }

  // ── parties ──
  if (inv && bl && inv.buyer && bl.consignee) { const a = normParty(inv.buyer, opt.legalSuffixes), b = normParty(bl.consignee, opt.legalSuffixes); if (a !== b) add("R17", "consignee", "consignee", String(inv.buyer), String(bl.consignee), `BL consignee "${bl.consignee}" does not match invoice buyer "${inv.buyer}" after normalisation (${a} ≠ ${b}).`, ["invoice", "billOfLading"]); }

  // ── dates ──
  const di = inv ? dayNumber(inv.date) : null, dp = pl ? dayNumber(pl.date) : null, db = bl ? dayNumber(bl.date) : null;
  if (inv && inv.date && di === null) add("R21", "invoice.date", "date", "YYYY-MM-DD", String(inv.date), "Invoice date is not a valid ISO date.", ["invoice"]);
  if (pl && pl.date && dp === null) add("R21", "packingList.date", "date", "YYYY-MM-DD", String(pl.date), "Packing list date is not a valid ISO date.", ["packingList"]);
  if (bl && bl.date && db === null) add("R21", "billOfLading.date", "date", "YYYY-MM-DD", String(bl.date), "Bill of lading date is not a valid ISO date.", ["billOfLading"]);
  if (di !== null && dp !== null && di > dp) add("R12", "invoice>packing", "date", `invoice ≤ packing`, `${inv.date} > ${pl.date}`, `Invoice (${inv.date}) is dated after the packing list (${pl.date}).`, ["invoice", "packingList"]);
  if (dp !== null && db !== null && dp > db) add("R12", "packing>bl", "date", `packing ≤ shipped on board`, `${pl.date} > ${bl.date}`, `Packing list (${pl.date}) is dated after shipped-on-board (${bl.date}).`, ["packingList", "billOfLading"]);
  if (di !== null && db !== null && db - di > opt.maxDocumentSpanDays) add("R12", "span", "date", `≤ ${opt.maxDocumentSpanDays} days`, `${db - di} days`, `${db - di} days between invoice and shipped-on-board exceeds ${opt.maxDocumentSpanDays}.`, ["invoice", "billOfLading"]);

  // deterministic order: rule id, then key
  findings.sort((x, y) => (x.rule < y.rule ? -1 : x.rule > y.rule ? 1 : x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const summary = { BLOCKER: 0, WARNING: 0, INFO: 0 };
  for (const f of findings) summary[f.severity]++;
  const status = summary.BLOCKER ? "BLOCKED" : summary.WARNING ? "REVIEW" : "PASS";
  return { version: VERSION, status, rulesEvaluated: RULES.length, summary, findings };
}

function sum(a, b) { return a === null || b === null ? null : a + b; }
