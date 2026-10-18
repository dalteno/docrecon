/** Synthetic sample dossier payloads shared by the case generator and the live demo. All data fictitious. */
export const ID = "SHP-77-2026";
export const ROLE = { COMMERCIAL_INVOICE: "FINANCE", PACKING_LIST: "WAREHOUSE", BILL_OF_LADING: "LOGISTICS", CERTIFICATE_OF_ORIGIN: "CUSTOMS_BROKER", CUSTOMS_ENTRY: "CUSTOMS_BROKER", INSURANCE_CERT: "FINANCE", INSPECTION_CERT: "QUALITY" };
export const ALL = Object.keys(ROLE);
export const SIX = ALL.filter((t) => t !== "INSPECTION_CERT");

/** Synthetic, consistent payloads. The first three are docrecon documents (they reconcile PASS). */
export const P = {
  COMMERCIAL_INVOICE: () => ({ number: "INV-2026-0417", date: "2026-03-02", currency: "EUR", incoterm: "FOB", seller: "Nile Components Co.", buyer: "Rheinwerk Automation GmbH", total: "18450.00",
    lines: [{ sku: "PMP-200", qty: "10", unit: "PCS", unitPrice: "1200.00", lineTotal: "12000.00", hsCode: "8413.70" }, { sku: "VLV-050", qty: "150", unit: "PCS", unitPrice: "35.00", lineTotal: "5250.00", hsCode: "8481.80" }, { sku: "GSK-012", qty: "400", unit: "PCS", unitPrice: "3.00", lineTotal: "1200.00", hsCode: "8484.10" }] }),
  PACKING_LIST: () => ({ number: "PL-0417", date: "2026-03-04", invoiceRef: "INV-2026-0417", shipmentRef: ID, totalPackages: "12", totalNetKg: "1840.000", totalGrossKg: "1990.000",
    lines: [{ sku: "PMP-200", qty: "10", unit: "PCS", packages: "10", netKg: "1500.000", grossKg: "1600.000", hsCode: "8413.70" }, { sku: "VLV-050", qty: "150", unit: "PCS", packages: "1", netKg: "300.000", grossKg: "340.000", hsCode: "8481.80" }, { sku: "GSK-012", qty: "400", unit: "PCS", packages: "1", netKg: "40.000", grossKg: "50.000", hsCode: "8484.10" }] }),
  BILL_OF_LADING: () => ({ number: "MSKU-99120034", date: "2026-03-09", shipmentRef: ID, shipper: "Nile Components Co.", consignee: "Rheinwerk Automation GmbH", packages: "12", grossKg: "1990.000", portOfLoading: "EGALY", portOfDischarge: "DEHAM", containers: ["MSKU1234567"], seals: ["SL-778812"] }),
  CERTIFICATE_OF_ORIGIN: () => ({ number: "COO-2026-0088", originCountry: "EG", invoiceRef: "INV-2026-0417", issuer: "Chamber of Commerce Alexandria" }),
  CUSTOMS_ENTRY: () => ({ entryNo: "CE-ALY-2026-5531", declaredValue: "18450.00", currency: "EUR", hsCodes: ["841370", "848180", "848410"] }),
  INSURANCE_CERT: () => ({ policyNo: "MAR-2026-1190", coveredValue: "18450.00", currency: "EUR", insurer: "Delta Marine" }),
  INSPECTION_CERT: () => ({ certNo: "INS-2026-0421", result: "CONFORM" }),
};

