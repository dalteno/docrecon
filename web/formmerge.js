/**
 * Form ↔ bundle merge for the docrecon demo. The visible form shows only some fields; edits are applied onto a copy of
 * the ORIGINAL case bundle so that fields the form does not display (currency on a line, seller, shipper, ports…)
 * are preserved. Pure functions; tested in web/tests/formmerge.test.mjs over every shared case.
 */
export const INV_COLS = ["sku", "qty", "unit", "unitPrice", "lineTotal", "hsCode"];
export const PL_COLS = ["sku", "qty", "unit", "packages", "netKg", "grossKg", "hsCode"];
export const INV_HEAD = ["number", "date", "currency", "incoterm", "buyer", "total"];
export const PL_HEAD = ["number", "date", "invoiceRef", "shipmentRef", "totalPackages", "totalNetKg", "totalGrossKg"];
export const BL_HEAD = ["number", "date", "shipmentRef", "consignee", "packages", "grossKg"];

/** A line entry as the form can show it: null / non-object entries (which the engine reports as R21) render as an empty line. */
export const asLine = (ln) => (ln !== null && typeof ln === "object" && !Array.isArray(ln) ? ln : {});

/** Apply one edit (header field or line field) onto the bundle, in place. Creates the document/line if absent. */
export function applyEdit(bundle, doc, line, key, value) {
  bundle[doc] ??= doc === "billOfLading" ? {} : { lines: [] };
  if (line === null || line === undefined) { bundle[doc][key] = value; return bundle; }
  bundle[doc].lines ??= [];
  bundle[doc].lines[line] ??= {};
  bundle[doc].lines[line][key] = value;
  return bundle;
}

/** The bundle as the engine should see it: a bill of lading whose every visible field is empty counts as absent. */
export function effectiveBundle(bundle) {
  const b = structuredClone(bundle);
  if (b.billOfLading && BL_HEAD.every((k) => (b.billOfLading[k] ?? "") === "")) delete b.billOfLading;
  return b;
}

/** Round-trip helper used by the test: re-apply every visible value onto a copy; must be a no-op. */
export function roundTrip(bundle) {
  const b = structuredClone(bundle);
  const docs = [["invoice", INV_HEAD, INV_COLS], ["packingList", PL_HEAD, PL_COLS], ["billOfLading", BL_HEAD, null]];
  for (const [doc, head, cols] of docs) {
    if (!bundle[doc]) continue;
    for (const k of head) if (k in bundle[doc]) applyEdit(b, doc, null, k, bundle[doc][k]);
    if (cols && Array.isArray(bundle[doc].lines)) bundle[doc].lines.forEach((ln, i) => { const l = asLine(ln); for (const k of cols) if (k in l) applyEdit(b, doc, i, k, l[k]); });
  }
  return b;
}
