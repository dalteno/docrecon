/**
 * Generates the shared reconciliation cases under /cases (one JSON per case).
 * Expectations are written BY HAND below — never derived from the engine — so the engine can be wrong and get caught.
 * Each expectation is "RULE|key". Run: node cases/generate.mjs
 */
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** A fully consistent synthetic bundle (all data fictitious). */
function base() {
  return {
    invoice: {
      number: "INV-2026-0417", date: "2026-03-02", currency: "EUR", incoterm: "FOB",
      seller: "Nile Components Co.", buyer: "Rheinwerk Automation GmbH", total: "18450.00",
      lines: [
        { sku: "PMP-200", description: "Centrifugal pump 2 kW", qty: "10", unit: "PCS", unitPrice: "1200.00", lineTotal: "12000.00", hsCode: "8413.70" },
        { sku: "VLV-050", description: "Ball valve DN50", qty: "150", unit: "PCS", unitPrice: "35.00", lineTotal: "5250.00", hsCode: "8481.80" },
        { sku: "GSK-012", description: "Gasket set", qty: "400", unit: "PCS", unitPrice: "3.00", lineTotal: "1200.00", hsCode: "8484.10" },
      ],
    },
    packingList: {
      number: "PL-0417", date: "2026-03-04", invoiceRef: "INV-2026-0417", shipmentRef: "SHP-77-2026",
      totalPackages: "12", totalNetKg: "1840.000", totalGrossKg: "1990.000",
      lines: [
        { sku: "PMP-200", qty: "10", unit: "PCS", packages: "10", netKg: "1500.000", grossKg: "1600.000", hsCode: "8413.70" },
        { sku: "VLV-050", qty: "150", unit: "PCS", packages: "1", netKg: "300.000", grossKg: "340.000", hsCode: "8481.80" },
        { sku: "GSK-012", qty: "400", unit: "PCS", packages: "1", netKg: "40.000", grossKg: "50.000", hsCode: "8484.10" },
      ],
    },
    billOfLading: {
      number: "MSKU-99120034", date: "2026-03-09", shipmentRef: "SHP-77-2026",
      shipper: "Nile Components Co.", consignee: "Rheinwerk Automation GmbH",
      packages: "12", grossKg: "1990.000", portOfLoading: "EGALY", portOfDischarge: "DEHAM",
    },
  };
}

const cases = [];
const add = (id, title, mutate, expect, { adversarial = false, options = undefined, note = "" } = {}) => {
  const bundle = base(); mutate(bundle); cases.push({ id, title, adversarial, note, options, bundle, expect: [...expect].sort() });
};
const inv = (b) => b.invoice, pl = (b) => b.packingList, bl = (b) => b.billOfLading;

// ── 00 baseline ──
add("C00_clean", "Consistent bundle → PASS", () => {}, []);

// ── references ──
add("C01_packing_wrong_invoice_ref", "Packing list references another invoice", (b) => { pl(b).invoiceRef = "INV-2026-0418"; }, ["R01|invoiceRef"]);
add("C02_bl_wrong_shipment_ref", "BL shipment ref differs from packing list", (b) => { bl(b).shipmentRef = "SHP-78-2026"; }, ["R02|shipmentRef"]);
add("C03_ref_case_and_spaces", "Refs differ only by case/whitespace → PASS", (b) => { pl(b).invoiceRef = "  inv-2026-0417 "; bl(b).shipmentRef = "shp-77-2026"; }, [], { adversarial: true });

// ── lines ──
add("C04_sku_missing_in_packing", "Invoiced SKU absent from packing list", (b) => { pl(b).lines.splice(2, 1); pl(b).totalPackages = "11"; pl(b).totalNetKg = "1800.000"; pl(b).totalGrossKg = "1940.000"; bl(b).packages = "11"; bl(b).grossKg = "1940.000"; }, ["R03|GSK-012"]);
add("C05_sku_extra_in_packing", "Packed SKU absent from invoice", (b) => { pl(b).lines.push({ sku: "BLT-M8", qty: "500", unit: "PCS", packages: "1", netKg: "20.000", grossKg: "22.000" }); pl(b).totalPackages = "13"; pl(b).totalNetKg = "1860.000"; pl(b).totalGrossKg = "2012.000"; bl(b).packages = "13"; bl(b).grossKg = "2012.000"; }, ["R04|BLT-M8"]);
add("C06_qty_short_shipped", "Packed quantity lower than invoiced", (b) => { pl(b).lines[1].qty = "140"; }, ["R05|VLV-050"]);
add("C07_qty_over_shipped", "Packed quantity higher than invoiced", (b) => { pl(b).lines[1].qty = "151"; }, ["R05|VLV-050"]);
add("C08_qty_split_across_packing_lines", "Same SKU on two packing lines, sums match → PASS", (b) => { pl(b).lines[1] = { ...pl(b).lines[1], qty: "100", packages: "1", netKg: "200.000", grossKg: "230.000" }; pl(b).lines.push({ sku: "VLV-050", qty: "50", unit: "PCS", packages: "1", netKg: "100.000", grossKg: "110.000", hsCode: "8481.80" }); pl(b).totalPackages = "13"; bl(b).packages = "13"; }, [], { adversarial: true });
add("C09_qty_within_tolerance", "1 % short with 2 % qty tolerance → PASS", (b) => { pl(b).lines[2].qty = "396"; }, [], { options: { qtyToleranceBp: 200 } });
add("C10_qty_outside_tolerance", "3 % short with 2 % qty tolerance → R05", (b) => { pl(b).lines[2].qty = "388"; }, ["R05|GSK-012"], { options: { qtyToleranceBp: 200 } });
add("C11_sku_case_whitespace", "SKU differs only by case/whitespace → PASS", (b) => { pl(b).lines[0].sku = " pmp-200 "; }, [], { adversarial: true });
add("C12_unit_mismatch", "Invoice PCS vs packing KG", (b) => { pl(b).lines[2].unit = "KG"; }, ["R19|GSK-012"]);

// ── arithmetic ──
add("C13_line_total_wrong", "qty × price ≠ line total", (b) => { inv(b).lines[1].lineTotal = "5200.00"; inv(b).total = "18400.00"; }, ["R06|VLV-050"]);
add("C14_invoice_total_wrong", "Lines sum ≠ invoice total", (b) => { inv(b).total = "18500.00"; }, ["R07|invoice"]);
add("C15_float_trap", "3 × 0.10 = 0.30 (binary float would say 0.30000000000000004) → PASS", (b) => { inv(b).lines.push({ sku: "WSH-003", qty: "3", unit: "PCS", unitPrice: "0.10", lineTotal: "0.30" }); inv(b).total = "18450.30"; pl(b).lines.push({ sku: "WSH-003", qty: "3", unit: "PCS", packages: "1", netKg: "0.100", grossKg: "0.200" }); pl(b).totalPackages = "13"; pl(b).totalNetKg = "1840.100"; pl(b).totalGrossKg = "1990.200"; bl(b).packages = "13"; bl(b).grossKg = "1990.200"; }, [], { adversarial: true });
add("C16_half_cent_rounds_away", "1.5 × 0.01 = 0.015 → rounds to 0.02; 0.02 declared → PASS", (b) => { inv(b).lines.push({ sku: "WSH-003", qty: "1.5", unit: "KG", unitPrice: "0.01", lineTotal: "0.02" }); inv(b).total = "18450.02"; pl(b).lines.push({ sku: "WSH-003", qty: "1.5", unit: "KG", packages: "1", netKg: "1.500", grossKg: "1.600" }); pl(b).totalPackages = "13"; pl(b).totalNetKg = "1841.500"; pl(b).totalGrossKg = "1991.600"; bl(b).packages = "13"; bl(b).grossKg = "1991.600"; }, [], { adversarial: true });
add("C17_half_cent_declared_down", "1.5 × 0.01 declared as 0.01 → within 0.01 tolerance → PASS", (b) => { inv(b).lines.push({ sku: "WSH-003", qty: "1.5", unit: "KG", unitPrice: "0.01", lineTotal: "0.01" }); inv(b).total = "18450.01"; pl(b).lines.push({ sku: "WSH-003", qty: "1.5", unit: "KG", packages: "1", netKg: "1.500", grossKg: "1.600" }); pl(b).totalPackages = "13"; pl(b).totalNetKg = "1841.500"; pl(b).totalGrossKg = "1991.600"; bl(b).packages = "13"; bl(b).grossKg = "1991.600"; }, [], { adversarial: true });
add("C17b_half_cent_zero_tolerance", "1.5 × 0.01 declared 0.02 with zero amount tolerance → PASS only if rounding is half-away-from-zero", (b) => { inv(b).lines.push({ sku: "WSH-003", qty: "1.5", unit: "KG", unitPrice: "0.01", lineTotal: "0.02" }); inv(b).total = "18450.02"; pl(b).lines.push({ sku: "WSH-003", qty: "1.5", unit: "KG", packages: "1", netKg: "1.500", grossKg: "1.600" }); pl(b).totalPackages = "13"; pl(b).totalNetKg = "1841.500"; pl(b).totalGrossKg = "1991.600"; bl(b).packages = "13"; bl(b).grossKg = "1991.600"; }, [], { adversarial: true, options: { amountToleranceMinor: 0 } });
add("C18_two_cent_drift", "Line total off by 0.02 → beyond 0.01 tolerance → R06", (b) => { inv(b).lines[2].lineTotal = "1200.02"; inv(b).total = "18450.02"; }, ["R06|GSK-012"]);
add("C19_negative_qty_balancing_total", "Negative line keeps totals consistent — still rejected", (b) => { inv(b).lines.push({ sku: "ADJ-001", qty: "-1", unit: "PCS", unitPrice: "100.00", lineTotal: "-100.00" }); inv(b).lines[0].lineTotal = "12100.00"; inv(b).lines[0].unitPrice = "1210.00"; pl(b).lines.push({ sku: "ADJ-001", qty: "-1", unit: "PCS", packages: "1", netKg: "0.100", grossKg: "0.200" }); pl(b).totalPackages = "13"; pl(b).totalNetKg = "1840.100"; pl(b).totalGrossKg = "1990.200"; bl(b).packages = "13"; bl(b).grossKg = "1990.200"; }, ["R16|invoice:ADJ-001:qty", "R16|packingList:ADJ-001:qty"], { adversarial: true });
add("C20_zero_price", "Zero unit price", (b) => { inv(b).lines[2].unitPrice = "0.00"; inv(b).lines[2].lineTotal = "0.00"; inv(b).total = "17250.00"; }, ["R16|invoice:GSK-012:unitPrice"]);
add("C21_qty_not_a_number", "qty = 'ten'", (b) => { inv(b).lines[0].qty = "ten"; }, ["R21|invoice:PMP-200:qty"]);
add("C22_thousands_separator", "Price '1,200.00' with thousands separator → parsed → PASS", (b) => { inv(b).lines[0].unitPrice = "1,200.00"; inv(b).lines[0].lineTotal = "12,000.00"; inv(b).total = "18,450.00"; }, [], { adversarial: true });

// ── currency / incoterm / HS ──
add("C22b_european_decimal_format", "Price '1.200,00' (German grouping) → not silently read as 1.20 → R21 on the field", (b) => { inv(b).lines[0].unitPrice = "1.200,00"; }, ["R21|invoice:PMP-200:unitPrice"], { adversarial: true });
add("C22c_comma_decimal", "Quantity '1,5' (comma decimal) → R21, never 15", (b) => { inv(b).lines[2].qty = "1,5"; }, ["R21|invoice:GSK-012:qty"], { adversarial: true, note: "an unparseable quantity is reported once (R21); comparisons that need it are skipped, not guessed" });
add("C23_mixed_currency_line", "One line priced in USD on a EUR invoice", (b) => { inv(b).lines[1].currency = "USD"; }, ["R08|VLV-050"]);
add("C24_currency_case", "Line currency 'eur' vs invoice 'EUR' → PASS", (b) => { inv(b).lines[1].currency = "eur"; }, [], { adversarial: true });
add("C25_incoterm_unknown", "Incoterm 'FOB Alexandria' is not a code", (b) => { inv(b).incoterm = "FOB Alexandria"; }, ["R18|invoice"]);
add("C26_incoterm_retired", "Incoterm DAT (retired 2020)", (b) => { inv(b).incoterm = "DAT"; }, ["R18|invoice"]);
add("C27_hs_too_short", "HS code 5 digits", (b) => { inv(b).lines[0].hsCode = "84137"; pl(b).lines[0].hsCode = "84137"; }, ["R13|invoice:PMP-200", "R13|packingList:PMP-200"]);
add("C28_hs_with_separators", "HS '8413.70.00' and '8413 70 00' → same 8 digits → PASS", (b) => { inv(b).lines[0].hsCode = "8413.70.00"; pl(b).lines[0].hsCode = "8413 70 00"; }, [], { adversarial: true });
add("C29_hs_conflict", "Different HS for same SKU on invoice vs packing", (b) => { pl(b).lines[1].hsCode = "8481.90"; }, ["R14|VLV-050"]);

// ── duplicates ──
add("C30_duplicate_sku_same_price", "SKU repeated on invoice, same price/HS, totals consistent → PASS", (b) => { inv(b).lines[2].qty = "250"; inv(b).lines[2].lineTotal = "750.00"; inv(b).lines.push({ sku: "GSK-012", qty: "150", unit: "PCS", unitPrice: "3.00", lineTotal: "450.00", hsCode: "8484.10" }); }, [], { adversarial: true });
add("C31_duplicate_sku_price_conflict", "SKU repeated on invoice with a different unit price", (b) => { inv(b).lines[2].qty = "250"; inv(b).lines[2].lineTotal = "750.00"; inv(b).lines.push({ sku: "GSK-012", qty: "150", unit: "PCS", unitPrice: "3.50", lineTotal: "525.00", hsCode: "8484.10" }); inv(b).total = "18525.00"; }, ["R15|GSK-012"]);

// ── weights / packages ──
add("C32_gross_within_2pct", "BL gross 1.9 % above packing → PASS", (b) => { bl(b).grossKg = "2027.810"; }, []);
add("C33_gross_at_boundary", "BL gross exactly 2.0 % above packing → PASS (≤ tolerance)", (b) => { bl(b).grossKg = "2029.800"; }, [], { adversarial: true });
add("C34_gross_beyond_tolerance", "BL gross 2.06 % above packing (tolerance measured against the larger value) → R09", (b) => { bl(b).grossKg = "2031.000"; }, ["R09|grossKg"]);
add("C35_net_gt_gross_line", "Packing line net > gross", (b) => { pl(b).lines[2].netKg = "55.000"; pl(b).totalNetKg = "1855.000"; }, ["R10|GSK-012"]);
add("C36_packing_totals_wrong", "Declared packing totals ≠ sum of lines", (b) => { pl(b).totalPackages = "13"; pl(b).totalGrossKg = "2000.000"; }, ["R20|totalPackages", "R20|totalGrossKg", "R11|packages"]);
add("C37_bl_packages_mismatch", "BL packages ≠ packing list packages", (b) => { bl(b).packages = "11"; }, ["R11|packages"]);
add("C38_bl_zero_gross", "BL gross weight 0", (b) => { bl(b).grossKg = "0"; }, ["R16|billOfLading:grossKg"]);

// ── parties ──
add("C39_consignee_punctuation_suffix", "'ACME, GmbH.' vs 'Acme GmbH' style normalisation → PASS", (b) => { bl(b).consignee = "RHEINWERK AUTOMATION, GmbH."; }, [], { adversarial: true });
add("C40_consignee_suffix_only_differs", "Buyer 'X GmbH' vs consignee 'X Ltd' → PASS (legal form ignored)", (b) => { bl(b).consignee = "Rheinwerk Automation Ltd"; }, []);
add("C41_consignee_real_mismatch", "Consignee is a different company", (b) => { bl(b).consignee = "Rheinwerk Trading GmbH"; }, ["R17|consignee"]);

// ── dates ──
add("C42_dates_equal", "All three documents same day → PASS", (b) => { inv(b).date = pl(b).date = bl(b).date = "2026-03-05"; }, []);
add("C43_bl_before_packing", "Shipped on board before packing list date", (b) => { bl(b).date = "2026-03-03"; }, ["R12|packing>bl"]);
add("C44_invoice_after_packing", "Invoice dated after packing list", (b) => { inv(b).date = "2026-03-06"; }, ["R12|invoice>packing"]);
add("C45_span_too_long", "61 days between invoice and BL", (b) => { inv(b).date = "2026-01-07"; pl(b).date = "2026-01-08"; }, ["R12|span"]);
add("C46_invalid_date", "Invoice date 2026-02-30", (b) => { inv(b).date = "2026-02-30"; }, ["R21|invoice.date"]);
add("C47_leap_day_valid", "2028-02-29 is valid; span 10 days → PASS", (b) => { inv(b).date = "2028-02-29"; pl(b).date = "2028-03-01"; bl(b).date = "2028-03-10"; }, [], { adversarial: true });

// ── structure ──
add("C48_no_invoice_lines", "Invoice with empty lines array", (b) => { inv(b).lines = []; }, ["R21|invoice.lines"]);
add("C52_lines_not_a_list", "Invoice lines sent as an object instead of a list → R21, no exception", (b) => { inv(b).lines = { sku: "PMP-200" }; }, ["R21|invoice.lines"], { adversarial: true });
add("C49_missing_bl", "Bundle without bill of lading", (b) => { delete b.billOfLading; }, ["R21|billOfLading"]);
add("C50_everything_wrong", "Multiple simultaneous defects — all reported, none masked", (b) => { pl(b).invoiceRef = "INV-X"; pl(b).lines[1].qty = "140"; inv(b).lines[2].lineTotal = "1210.00"; bl(b).consignee = "Other Co"; bl(b).date = "2026-03-01"; }, ["R01|invoiceRef", "R05|VLV-050", "R06|GSK-012", "R07|invoice", "R17|consignee", "R12|packing>bl"]);

// write
const out = join(here);
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith(".json")) unlinkSync(join(out, f));
for (const c of cases) writeFileSync(join(out, `${c.id}.json`), JSON.stringify(c, null, 2) + "\n");
const ids = new Set(cases.map((c) => c.id));
if (ids.size !== cases.length) throw new Error("duplicate case id");
console.log(`wrote ${cases.length} cases (${cases.filter((c) => c.adversarial).length} adversarial) to ${out}`);
