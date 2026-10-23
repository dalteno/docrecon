/**
 * Shared docflow cases — expectations written BY HAND (never derived from the engine). Run: node cases/generate.mjs
 * Each case: dossier + ordered commands + expect { status, documents, reconciliation, rejected, ignored, slaBreached, slaBreaches, notifications, integrationQueued, integrationAcked }.
 * rejected / ignored entries are "RULE|documentType-or-command".
 */
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
import { ID, ROLE, ALL, SIX, P } from "../web/docflow-samples.js";

const rcv = (type, at, version = 1, payload = P[type]?.(), sha = `sha-${type}-v${version}`) => ({ cmd: "RECEIVE", type, version, sha, payload, at });
const appr = (type, at, role = ROLE[type]) => ({ cmd: "APPROVE", type, role, at });
const rej = (type, at, reason, role = ROLE[type]) => ({ cmd: "REJECT", type, role, reason, at });
const key = (type, version = 1) => `${ID}|${type}|v${version}`;
const ack = (type, at, version = 1) => ({ cmd: "INTEGRATION_ACK", key: key(type, version), at });
const tick = (at) => ({ cmd: "TICK", at });

const D0 = "2026-03-10", D1 = "2026-03-11", D2 = "2026-03-12", D3 = "2026-03-13", D4 = "2026-03-14", D5 = "2026-03-15", D6 = "2026-03-16";
const docs = (over = {}) => Object.fromEntries(ALL.map((t) => [t, over[t] ?? "MISSING"]));
const allOf = (status, types = SIX) => Object.fromEntries(types.map((t) => [t, status]));

const cases = [];
const add = (id, title, dossier, commands, expect, { adversarial = false, note = "" } = {}) => {
  const e = { status: "OPEN", documents: docs(), reconciliation: null, rejected: [], ignored: [], slaBreached: [], slaBreaches: 0, notifications: 0, integrationQueued: 0, integrationAcked: 0, ...expect };
  e.rejected = [...e.rejected].sort(); e.ignored = [...e.ignored].sort(); e.slaBreached = [...e.slaBreached].sort();
  cases.push({ id, title, adversarial, note, dossier, commands, expect: e });
};
const base = { id: ID };

// ── happy paths ──
add("D00_happy_path", "Six required documents, definition order → CLOSED", base,
  [...SIX.map((t) => rcv(t, D0)), ...SIX.map((t) => appr(t, D1)), ...SIX.map((t) => ack(t, D2))],
  { status: "CLOSED", documents: docs(allOf("INTEGRATED")), reconciliation: "PASS", notifications: 6, integrationQueued: 6, integrationAcked: 6 });
add("D01_reverse_arrival", "Documents arrive in reverse order → same outcome", base,
  [...[...SIX].reverse().map((t) => rcv(t, D0)), ...SIX.map((t) => appr(t, D1)), ...[...SIX].reverse().map((t) => ack(t, D2))],
  { status: "CLOSED", documents: docs(allOf("INTEGRATED")), reconciliation: "PASS", notifications: 6, integrationQueued: 6, integrationAcked: 6 });
add("D02_eager_approvals", "Approve each document as it arrives; customs entry too early → F08, later succeeds", base,
  [rcv("COMMERCIAL_INVOICE", D0), appr("COMMERCIAL_INVOICE", D0), rcv("PACKING_LIST", D0), appr("PACKING_LIST", D0), rcv("BILL_OF_LADING", D0), appr("BILL_OF_LADING", D0),
   rcv("CUSTOMS_ENTRY", D0), appr("CUSTOMS_ENTRY", D0), rcv("CERTIFICATE_OF_ORIGIN", D0), appr("CERTIFICATE_OF_ORIGIN", D0), appr("CUSTOMS_ENTRY", D0),
   rcv("INSURANCE_CERT", D0), appr("INSURANCE_CERT", D0), ...SIX.map((t) => ack(t, D1))],
  { status: "CLOSED", documents: docs(allOf("INTEGRATED")), reconciliation: "PASS", rejected: ["F08|CUSTOMS_ENTRY"], notifications: 6, integrationQueued: 6, integrationAcked: 6 });

// ── idempotency / versions ──
add("D03_duplicate_receive_ignored", "Same packing-list bytes received twice → ignored (F02), nothing duplicated", base,
  [...SIX.map((t) => rcv(t, D0)), rcv("PACKING_LIST", D0), ...SIX.map((t) => appr(t, D1)), ...SIX.map((t) => ack(t, D2))],
  { status: "CLOSED", documents: docs(allOf("INTEGRATED")), reconciliation: "PASS", ignored: ["F02|PACKING_LIST"], notifications: 6, integrationQueued: 6, integrationAcked: 6 }, { adversarial: true });
add("D04_new_version_before_ack", "Packing list v2 arrives after approval, before ERP ack → v1 integration cancelled, old key rejected, re-approval queues v2", base,
  [...SIX.map((t) => rcv(t, D0)), ...SIX.map((t) => appr(t, D1)), rcv("PACKING_LIST", D1, 2), ack("PACKING_LIST", D2, 1), appr("PACKING_LIST", D2),
   ...SIX.filter((t) => t !== "PACKING_LIST").map((t) => ack(t, D2)), ack("PACKING_LIST", D2, 2)],
  { status: "CLOSED", documents: docs(allOf("INTEGRATED")), reconciliation: "PASS", rejected: ["F06|INTEGRATION_ACK"], notifications: 7, integrationQueued: 7, integrationAcked: 6 });
add("D05_new_version_after_integration", "Invoice v2 after it was already integrated → superseded, reconciliation re-run, new integration key", base,
  [...SIX.map((t) => rcv(t, D0)), ...SIX.map((t) => appr(t, D1)), ...SIX.filter((t) => t !== "CUSTOMS_ENTRY").map((t) => ack(t, D2)),
   rcv("COMMERCIAL_INVOICE", D3, 2), appr("COMMERCIAL_INVOICE", D3), ack("COMMERCIAL_INVOICE", D4, 2), ack("CUSTOMS_ENTRY", D4)],
  { status: "CLOSED", documents: docs(allOf("INTEGRATED")), reconciliation: "PASS", notifications: 7, integrationQueued: 7, integrationAcked: 7 });
add("D06_version_not_above_current", "Re-sending v1 with different bytes → rejected (F03)", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("COMMERCIAL_INVOICE", D0, 1, P.COMMERCIAL_INVOICE(), "sha-other")],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL" }), rejected: ["F03|COMMERCIAL_INVOICE"], notifications: 1 });
add("D35_same_sha_higher_version", "Same bytes labelled v2 → still ignored (F02): bytes decide, not labels", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("COMMERCIAL_INVOICE", D0, 2, P.COMMERCIAL_INVOICE(), "sha-COMMERCIAL_INVOICE-v1")],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL" }), ignored: ["F02|COMMERCIAL_INVOICE"], notifications: 1 }, { adversarial: true });
add("D30_bad_version_values", "Version 0 and version '1' (string) → rejected (F03)", base,
  [rcv("COMMERCIAL_INVOICE", D0, 0), { ...rcv("COMMERCIAL_INVOICE", D0), version: "1" }],
  { rejected: ["F03|COMMERCIAL_INVOICE", "F03|COMMERCIAL_INVOICE"] }, { adversarial: true });

// ── authorisation / rejection ──
add("D07_wrong_role", "FINANCE tries to approve the packing list → F01; WAREHOUSE succeeds", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("PACKING_LIST", D0), appr("PACKING_LIST", D1, "FINANCE"), appr("PACKING_LIST", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", PACKING_LIST: "APPROVED" }), rejected: ["F01|PACKING_LIST"], notifications: 2, integrationQueued: 1 });
add("D08_reject_resubmit", "Rejection without reason → F14; with reason → REJECTED + intake notified; approving a rejected doc → F03; v2 approved", base,
  [rcv("CERTIFICATE_OF_ORIGIN", D0), rej("CERTIFICATE_OF_ORIGIN", D1, ""), rej("CERTIFICATE_OF_ORIGIN", D1, "issuer stamp missing"), appr("CERTIFICATE_OF_ORIGIN", D1), rcv("CERTIFICATE_OF_ORIGIN", D2, 2), appr("CERTIFICATE_OF_ORIGIN", D2)],
  { documents: docs({ CERTIFICATE_OF_ORIGIN: "APPROVED" }), rejected: ["F14|CERTIFICATE_OF_ORIGIN", "F03|CERTIFICATE_OF_ORIGIN"], notifications: 3, integrationQueued: 1 });
add("D33_approve_twice_ignored", "Approving an already approved document → ignored (F05), no second integration", base,
  [rcv("COMMERCIAL_INVOICE", D0), appr("COMMERCIAL_INVOICE", D1), appr("COMMERCIAL_INVOICE", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "APPROVED" }), ignored: ["F05|COMMERCIAL_INVOICE"], notifications: 1, integrationQueued: 1 });
add("D34_reject_integrated", "Rejecting an integrated document → F03 (a new version is the only way back)", base,
  [rcv("COMMERCIAL_INVOICE", D0), appr("COMMERCIAL_INVOICE", D1), ack("COMMERCIAL_INVOICE", D2), rej("COMMERCIAL_INVOICE", D3, "wrong buyer")],
  { documents: docs({ COMMERCIAL_INVOICE: "INTEGRATED" }), rejected: ["F03|COMMERCIAL_INVOICE"], notifications: 1, integrationQueued: 1, integrationAcked: 1 });
add("D38_reject_after_approval_cancels_integration", "Approved then rejected before ERP ack → pending integration cancelled, late ack rejected (F06)", base,
  [rcv("COMMERCIAL_INVOICE", D0), appr("COMMERCIAL_INVOICE", D1), rej("COMMERCIAL_INVOICE", D1, "duplicate of INV-0416"), ack("COMMERCIAL_INVOICE", D2)],
  { documents: docs({ COMMERCIAL_INVOICE: "REJECTED" }), rejected: ["F06|INTEGRATION_ACK"], notifications: 2, integrationQueued: 1 }, { adversarial: true });
add("D28_approve_missing_document", "Approving a document that never arrived → F04", base,
  [appr("PACKING_LIST", D0)], { rejected: ["F04|PACKING_LIST"] });

// ── integration ──
add("D09_ack_unknown_key", "ERP acknowledges an unknown key → F06", base, [ack("COMMERCIAL_INVOICE", D0)], { rejected: ["F06|INTEGRATION_ACK"] });
add("D10_ack_twice_ignored", "Second ack for the same key → ignored (F06)", base,
  [rcv("COMMERCIAL_INVOICE", D0), appr("COMMERCIAL_INVOICE", D1), ack("COMMERCIAL_INVOICE", D2), ack("COMMERCIAL_INVOICE", D2)],
  { documents: docs({ COMMERCIAL_INVOICE: "INTEGRATED" }), ignored: ["F06|INTEGRATION_ACK"], notifications: 1, integrationQueued: 1, integrationAcked: 1 });
add("D37_ack_key_from_other_dossier", "Key of another dossier → F06", base,
  [rcv("COMMERCIAL_INVOICE", D0), appr("COMMERCIAL_INVOICE", D1), { cmd: "INTEGRATION_ACK", key: "SHP-78-2026|COMMERCIAL_INVOICE|v1", at: D2 }],
  { documents: docs({ COMMERCIAL_INVOICE: "APPROVED" }), rejected: ["F06|INTEGRATION_ACK"], notifications: 1, integrationQueued: 1 }, { adversarial: true });

// ── reconciliation gate ──
const plShort = () => { const p = P.PACKING_LIST(); p.lines[1].qty = "140"; return p; };
const blNoGross = () => { const b = P.BILL_OF_LADING(); b.grossKg = ""; return b; }; // R22 → REVIEW, no blockers
const apprAccept = (type, at, reason, role = ROLE[type]) => ({ cmd: "APPROVE", type, role, acceptWarnings: true, reason, at });
add("D43_review_blocks_without_signoff", "BL without gross weight → reconciliation REVIEW (R22, 0 blockers) → customs entry approval refused (F18); a REVIEW never passes the gate silently", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("PACKING_LIST", D0), rcv("BILL_OF_LADING", D0, 1, blNoGross(), "sha-bl-nogross"), rcv("CERTIFICATE_OF_ORIGIN", D0), appr("CERTIFICATE_OF_ORIGIN", D1), rcv("CUSTOMS_ENTRY", D1), appr("CUSTOMS_ENTRY", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", PACKING_LIST: "AWAITING_APPROVAL", BILL_OF_LADING: "AWAITING_APPROVAL", CERTIFICATE_OF_ORIGIN: "APPROVED", CUSTOMS_ENTRY: "AWAITING_APPROVAL" }),
    reconciliation: "REVIEW", rejected: ["F18|CUSTOMS_ENTRY"], notifications: 5, integrationQueued: 1 }, { adversarial: true });
add("D44_review_accepted_with_reason", "Same REVIEW; the broker approves with acceptWarnings and a written reason → accepted, recorded, customs entry approved", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("PACKING_LIST", D0), rcv("BILL_OF_LADING", D0, 1, blNoGross(), "sha-bl-nogross"), rcv("CERTIFICATE_OF_ORIGIN", D0), appr("CERTIFICATE_OF_ORIGIN", D1), rcv("CUSTOMS_ENTRY", D1),
   apprAccept("CUSTOMS_ENTRY", D1, "gross weight will be taken from the weighbridge certificate")],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", PACKING_LIST: "AWAITING_APPROVAL", BILL_OF_LADING: "AWAITING_APPROVAL", CERTIFICATE_OF_ORIGIN: "APPROVED", CUSTOMS_ENTRY: "APPROVED" }),
    reconciliation: "REVIEW", notifications: 5, integrationQueued: 2 });
add("D45_signoff_cannot_override_blocked_or_skip_reason", "acceptWarnings without a reason → F18; acceptWarnings on a BLOCKED reconciliation → still F07", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("PACKING_LIST", D0), rcv("BILL_OF_LADING", D0, 1, blNoGross(), "sha-bl-nogross"), rcv("CERTIFICATE_OF_ORIGIN", D0), appr("CERTIFICATE_OF_ORIGIN", D1), rcv("CUSTOMS_ENTRY", D1),
   apprAccept("CUSTOMS_ENTRY", D1, ""),
   rcv("PACKING_LIST", D1, 2, plShort(), "sha-pl-short"), apprAccept("CUSTOMS_ENTRY", D1, "trying to force it")],  // same day: no SLA boundary crossed
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", PACKING_LIST: "AWAITING_APPROVAL", BILL_OF_LADING: "AWAITING_APPROVAL", CERTIFICATE_OF_ORIGIN: "APPROVED", CUSTOMS_ENTRY: "AWAITING_APPROVAL" }),
    reconciliation: "BLOCKED", rejected: ["F07|CUSTOMS_ENTRY", "F18|CUSTOMS_ENTRY"], notifications: 7, integrationQueued: 1 }, { adversarial: true });

add("D11_reconciliation_blocked", "Packed qty ≠ invoiced → docrecon BLOCKED → compliance notified → customs entry approval refused (F07)", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("PACKING_LIST", D0, 1, plShort(), "sha-pl-short"), rcv("BILL_OF_LADING", D0), rcv("CERTIFICATE_OF_ORIGIN", D0), appr("CERTIFICATE_OF_ORIGIN", D1), rcv("CUSTOMS_ENTRY", D1), appr("CUSTOMS_ENTRY", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", PACKING_LIST: "AWAITING_APPROVAL", BILL_OF_LADING: "AWAITING_APPROVAL", CERTIFICATE_OF_ORIGIN: "APPROVED", CUSTOMS_ENTRY: "AWAITING_APPROVAL" }),
    reconciliation: "BLOCKED", rejected: ["F07|CUSTOMS_ENTRY"], notifications: 6, integrationQueued: 1 });
add("D12_blocked_then_corrected", "Corrected packing list v2 → reconciliation re-run PASS → customs entry approved", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("PACKING_LIST", D0, 1, plShort(), "sha-pl-short"), rcv("BILL_OF_LADING", D0), rcv("CERTIFICATE_OF_ORIGIN", D0), appr("CERTIFICATE_OF_ORIGIN", D1), rcv("CUSTOMS_ENTRY", D1), appr("CUSTOMS_ENTRY", D1),
   rcv("PACKING_LIST", D1, 2), appr("CUSTOMS_ENTRY", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", PACKING_LIST: "AWAITING_APPROVAL", BILL_OF_LADING: "AWAITING_APPROVAL", CERTIFICATE_OF_ORIGIN: "APPROVED", CUSTOMS_ENTRY: "APPROVED" }),
    reconciliation: "PASS", rejected: ["F07|CUSTOMS_ENTRY"], notifications: 7, integrationQueued: 2 });
add("D13_customs_entry_before_reconciliation", "Customs entry approval before the three documents exist → F07 (gate not run)", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("CERTIFICATE_OF_ORIGIN", D0), rcv("CUSTOMS_ENTRY", D0), appr("CERTIFICATE_OF_ORIGIN", D1), appr("CUSTOMS_ENTRY", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", CERTIFICATE_OF_ORIGIN: "APPROVED", CUSTOMS_ENTRY: "AWAITING_APPROVAL" }), rejected: ["F07|CUSTOMS_ENTRY"], notifications: 3, integrationQueued: 1 });
add("D14_customs_entry_before_coo", "Customs entry approval before certificate of origin is approved → F08", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("PACKING_LIST", D0), rcv("BILL_OF_LADING", D0), rcv("CERTIFICATE_OF_ORIGIN", D0), rcv("CUSTOMS_ENTRY", D0), appr("CUSTOMS_ENTRY", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", PACKING_LIST: "AWAITING_APPROVAL", BILL_OF_LADING: "AWAITING_APPROVAL", CERTIFICATE_OF_ORIGIN: "AWAITING_APPROVAL", CUSTOMS_ENTRY: "AWAITING_APPROVAL" }),
    reconciliation: "PASS", rejected: ["F08|CUSTOMS_ENTRY"], notifications: 5 });
add("D26_extraction_failure_blocks_reconciliation", "BL without seals → extraction failed → reconciliation does not run", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("PACKING_LIST", D0), rcv("BILL_OF_LADING", D0, 1, { ...P.BILL_OF_LADING(), seals: [] }, "sha-bl-noseals")],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", PACKING_LIST: "AWAITING_APPROVAL", BILL_OF_LADING: "EXTRACTION_FAILED" }), reconciliation: null, notifications: 3 });
const invBadTotal = () => ({ ...P.COMMERCIAL_INVOICE(), total: "18500.00" });
add("D36_reconciliation_flips_with_versions", "PASS → invoice v2 breaks totals → BLOCKED (entry refused) → invoice v3 fixes → PASS (entry approved)", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("PACKING_LIST", D0), rcv("BILL_OF_LADING", D0), rcv("CERTIFICATE_OF_ORIGIN", D0), rcv("CUSTOMS_ENTRY", D0), appr("CERTIFICATE_OF_ORIGIN", D1),
   rcv("COMMERCIAL_INVOICE", D1, 2, invBadTotal(), "sha-inv-v2"), appr("CUSTOMS_ENTRY", D1), rcv("COMMERCIAL_INVOICE", D1, 3), appr("CUSTOMS_ENTRY", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", PACKING_LIST: "AWAITING_APPROVAL", BILL_OF_LADING: "AWAITING_APPROVAL", CERTIFICATE_OF_ORIGIN: "APPROVED", CUSTOMS_ENTRY: "APPROVED" }),
    reconciliation: "PASS", rejected: ["F07|CUSTOMS_ENTRY"], notifications: 8, integrationQueued: 2 }, { adversarial: true });

// ── insurance ──
const ins = (over) => ({ ...P.INSURANCE_CERT(), ...over });
add("D15_insurance_under_cover", "Cover 18,000 < invoice 18,450 → F09", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("INSURANCE_CERT", D0, 1, ins({ coveredValue: "18000.00" }), "sha-ins-low"), appr("INSURANCE_CERT", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", INSURANCE_CERT: "AWAITING_APPROVAL" }), rejected: ["F09|INSURANCE_CERT"], notifications: 2 });
add("D16_insurance_currency_mismatch", "Cover in USD on a EUR invoice → F09", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("INSURANCE_CERT", D0, 1, ins({ currency: "USD" }), "sha-ins-usd"), appr("INSURANCE_CERT", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", INSURANCE_CERT: "AWAITING_APPROVAL" }), rejected: ["F09|INSURANCE_CERT"], notifications: 2 });
add("D17_insurance_before_invoice", "Insurance approval before the invoice exists → F09", base,
  [rcv("INSURANCE_CERT", D0), appr("INSURANCE_CERT", D1)],
  { documents: docs({ INSURANCE_CERT: "AWAITING_APPROVAL" }), rejected: ["F09|INSURANCE_CERT"], notifications: 1 });
add("D18_insurance_equal_cover", "Cover exactly equal to the invoice total → approved (boundary)", base,
  [rcv("COMMERCIAL_INVOICE", D0), rcv("INSURANCE_CERT", D0), appr("INSURANCE_CERT", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "AWAITING_APPROVAL", INSURANCE_CERT: "APPROVED" }), notifications: 2, integrationQueued: 1 }, { adversarial: true });

// ── conditional document ──
add("D19_inspection_required", "requiresInspection → six integrated is not enough; closes only after the inspection certificate", { id: ID, requiresInspection: true },
  [...SIX.map((t) => rcv(t, D0)), ...SIX.map((t) => appr(t, D1)), ...SIX.map((t) => ack(t, D2)), rcv("INSPECTION_CERT", D3), appr("INSPECTION_CERT", D3), ack("INSPECTION_CERT", D4)],
  { status: "CLOSED", documents: docs(allOf("INTEGRATED", ALL)), reconciliation: "PASS", notifications: 7, integrationQueued: 7, integrationAcked: 7 });
add("D20_inspection_optional_but_sent", "Inspection not required but sent → processed; closure ignores it; commands after close → F11", base,
  [...ALL.map((t) => rcv(t, D0)), ...ALL.map((t) => appr(t, D1)), ...SIX.map((t) => ack(t, D2)), ack("INSPECTION_CERT", D2)],
  { status: "CLOSED", documents: docs({ ...allOf("INTEGRATED"), INSPECTION_CERT: "APPROVED" }), reconciliation: "PASS", rejected: ["F11|INTEGRATION_ACK"], notifications: 7, integrationQueued: 7, integrationAcked: 6 });

// ── SLA ──
add("D21_sla_breach_once", "BL (SLA 1 day): no breach at +1, breach at +2, never a second one", base,
  [rcv("BILL_OF_LADING", D0), tick(D1), tick(D2), tick(D3)],
  { documents: docs({ BILL_OF_LADING: "AWAITING_APPROVAL" }), slaBreached: ["BILL_OF_LADING"], slaBreaches: 1, notifications: 2 });
add("D22_sla_boundary", "Invoice approved exactly at SLA (2 days) → no breach", base,
  [rcv("COMMERCIAL_INVOICE", D0), appr("COMMERCIAL_INVOICE", D2)],
  { documents: docs({ COMMERCIAL_INVOICE: "APPROVED" }), notifications: 1, integrationQueued: 1 }, { adversarial: true });
add("D23_sla_reset_by_new_version", "Breach on v1; v2 restarts the clock", base,
  [rcv("BILL_OF_LADING", D0), tick(D3), rcv("BILL_OF_LADING", D3, 2), tick(D4)],
  { documents: docs({ BILL_OF_LADING: "AWAITING_APPROVAL" }), slaBreached: [], slaBreaches: 1, notifications: 3 });
add("D24_sla_checked_on_any_command", "A breach is detected on the next command of any kind, not only on TICK", base,
  [rcv("BILL_OF_LADING", D0), rcv("COMMERCIAL_INVOICE", D3)],
  { documents: docs({ BILL_OF_LADING: "AWAITING_APPROVAL", COMMERCIAL_INVOICE: "AWAITING_APPROVAL" }), slaBreached: ["BILL_OF_LADING"], slaBreaches: 1, notifications: 3 });
add("D40_late_approvals_full_dossier", "Everything approved five days late → five SLA breaches, dossier still closes", base,
  [...SIX.map((t) => rcv(t, D0)), ...SIX.map((t) => appr(t, D5)), ...SIX.map((t) => ack(t, D6))],
  { status: "CLOSED", documents: docs(allOf("INTEGRATED")), reconciliation: "PASS", slaBreached: ["BILL_OF_LADING", "CERTIFICATE_OF_ORIGIN", "COMMERCIAL_INVOICE", "INSURANCE_CERT", "PACKING_LIST"], slaBreaches: 5, notifications: 11, integrationQueued: 6, integrationAcked: 6 });

// ── extraction ──
add("D25_extraction_failed_then_fixed", "Invoice without buyer → extraction failed (F04 on approve); v2 complete → approved", base,
  [rcv("COMMERCIAL_INVOICE", D0, 1, { ...P.COMMERCIAL_INVOICE(), buyer: "" }, "sha-inv-nobuyer"), appr("COMMERCIAL_INVOICE", D1), rcv("COMMERCIAL_INVOICE", D1, 2), appr("COMMERCIAL_INVOICE", D1)],
  { documents: docs({ COMMERCIAL_INVOICE: "APPROVED" }), rejected: ["F04|COMMERCIAL_INVOICE"], notifications: 2, integrationQueued: 1 });

// ── structure ──
add("D27_unknown_document_type", "PROFORMA is not in the dossier definition → F15", base, [{ ...rcv("COMMERCIAL_INVOICE", D0), type: "PROFORMA" }], { rejected: ["F15|PROFORMA"] });
add("D29_commands_after_close", "TICK after closure → F11", base,
  [...SIX.map((t) => rcv(t, D0)), ...SIX.map((t) => appr(t, D1)), ...SIX.map((t) => ack(t, D2)), tick(D3)],
  { status: "CLOSED", documents: docs(allOf("INTEGRATED")), reconciliation: "PASS", rejected: ["F11|TICK"], notifications: 6, integrationQueued: 6, integrationAcked: 6 });
add("D31_invalid_date", "Command dated 2026-02-30 → F16", base, [rcv("COMMERCIAL_INVOICE", "2026-02-30")], { rejected: ["F16|COMMERCIAL_INVOICE"] }, { adversarial: true });
add("D32_unknown_command", "Unknown verb → F16", base, [{ cmd: "FOO", at: D0 }], { rejected: ["F16|FOO"] });
add("D42_clock_never_runs_backwards", "An approval dated before the last processed command → F17; a later TICK is fine", base,
  [rcv("COMMERCIAL_INVOICE", D2), appr("COMMERCIAL_INVOICE", D1), tick(D1), appr("COMMERCIAL_INVOICE", D2)],
  { documents: docs({ COMMERCIAL_INVOICE: "APPROVED" }), rejected: ["F17|COMMERCIAL_INVOICE", "F17|TICK"], notifications: 1, integrationQueued: 1 }, { adversarial: true });
add("D41_empty_dossier", "No commands → OPEN, everything MISSING", base, [], {});

// write
mkdirSync(here, { recursive: true });
for (const f of readdirSync(here)) if (f.endsWith(".json")) unlinkSync(join(here, f));
const ids = new Set();
for (const c of cases) { if (ids.has(c.id)) throw new Error("dup " + c.id); ids.add(c.id); writeFileSync(join(here, `${c.id}.json`), JSON.stringify(c, null, 2) + "\n"); }
console.log(`wrote ${cases.length} cases (${cases.filter((c) => c.adversarial).length} adversarial)`);
