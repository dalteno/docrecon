/**
 * docflow — deterministic, event-sourced workflow for a shipment document dossier.
 *
 * Documents arrive in any order → each is routed to its role → structured fields are extracted → when invoice,
 * packing list and bill of lading are all present, docrecon reconciles them → the role approves or rejects →
 * an integration record is queued for the existing ERP (outbox + idempotency key) → the role is notified at every
 * hand-off → the dossier closes only when every required document is APPROVED and INTEGRATED.
 *
 * Pure function: run(dossier, commands) → report. No clock (every command carries `at`), no I/O, no randomness.
 * JavaScript twin of Dalteno.DocFlow (.NET 8); shared cases under /cases are the parity gate.
 */
import { reconcile as docrecon, toMinor, dayNumber, normKey, SCALE } from "./docrecon.js";

export const VERSION = "1.0.0";

/** Default dossier definition — sea import, Egyptian customs practice. Roles are the real roles of the process. */
export const DEFAULT_DEFINITION = Object.freeze({
  id: "SEA_IMPORT_V1",
  intakeRole: "INTAKE",
  documents: [
    { type: "COMMERCIAL_INVOICE", role: "FINANCE", required: true, fields: ["number", "date", "currency", "total", "buyer"], slaDays: 2 },
    { type: "PACKING_LIST", role: "WAREHOUSE", required: true, fields: ["number", "invoiceRef", "totalPackages", "totalGrossKg"], slaDays: 2 },
    { type: "BILL_OF_LADING", role: "LOGISTICS", required: true, fields: ["number", "shipmentRef", "containers", "seals"], slaDays: 1 },
    { type: "CERTIFICATE_OF_ORIGIN", role: "CUSTOMS_BROKER", required: true, fields: ["number", "originCountry", "invoiceRef"], slaDays: 3 },
    { type: "CUSTOMS_ENTRY", role: "CUSTOMS_BROKER", required: true, fields: ["entryNo", "declaredValue", "hsCodes"], slaDays: 5, requiresApproved: ["CERTIFICATE_OF_ORIGIN"], gate: "RECONCILIATION" },
    { type: "INSURANCE_CERT", role: "FINANCE", required: true, fields: ["policyNo", "coveredValue", "currency"], slaDays: 3, check: "INSURANCE_COVERS_INVOICE" },
    { type: "INSPECTION_CERT", role: "QUALITY", required: false, requiredIf: "requiresInspection", fields: ["certNo", "result"], slaDays: 3 },
  ],
  reconciliation: { group: ["COMMERCIAL_INVOICE", "PACKING_LIST", "BILL_OF_LADING"], complianceRole: "CUSTOMS_BROKER" },
  integration: { adapter: "ORACLE_STAGING", schema: "DOCFLOW_STG" },
});

/** Rule catalogue — stable ids shared with the C# implementation. */
export const RULES = Object.freeze([
  r("F01", "ROLE_AUTHORISATION", "Only the role assigned to a document type may approve or reject it."),
  r("F02", "IDEMPOTENT_RECEIVE", "Receiving the same document bytes (sha) again is ignored, never duplicated."),
  r("F03", "VERSION_SUPERSEDES", "A higher version supersedes: approval and pending integration are invalidated and the document is re-routed. A lower or equal version is rejected."),
  r("F04", "EXTRACTION_BEFORE_APPROVAL", "A document cannot be approved while required fields are missing."),
  r("F05", "APPROVAL_BEFORE_INTEGRATION", "Integration is queued only by a successful approval."),
  r("F06", "INTEGRATION_IDEMPOTENCY", "Integration key = dossier|type|version; an unknown key is rejected, a repeated ack is ignored."),
  r("F07", "RECONCILIATION_GATE", "When invoice, packing list and BL are all extracted, docrecon runs; BLOCKED routes to compliance and blocks the customs entry."),
  r("F08", "PREREQUISITE_APPROVAL", "A document with prerequisites (customs entry ← certificate of origin) cannot be approved before they are approved."),
  r("F09", "INSURANCE_COVERS_INVOICE", "Insurance cover must be ≥ invoice total in the invoice currency; needs the invoice first."),
  r("F10", "SLA_BREACH", "Days since receipt beyond the role's SLA raise one breach per document version."),
  r("F11", "CLOSE_WHEN_COMPLETE", "The dossier closes exactly when every required document is INTEGRATED; commands after close are rejected."),
  r("F12", "CONDITIONAL_DOCUMENT", "Inspection certificate is required only when the dossier flags requiresInspection."),
  r("F13", "ONE_NOTIFICATION_PER_HANDOFF", "Every routing, rejection, extraction failure, compliance routing and SLA breach queues exactly one notification."),
  r("F14", "REJECTION_NEEDS_REASON", "A rejection without a reason is itself rejected."),
  r("F15", "UNKNOWN_DOCUMENT_TYPE", "A document type outside the dossier definition is rejected."),
  r("F16", "INVALID_COMMAND", "A command without a valid ISO date or with an unknown verb is rejected."),
  r("F17", "MONOTONIC_TIME", "A command dated before the latest processed command is rejected: the dossier clock never runs backwards."),
]);
function r(id, code, contract) { return Object.freeze({ id, code, contract }); }

export const DOC_STATUS = Object.freeze(["MISSING", "EXTRACTION_FAILED", "AWAITING_APPROVAL", "REJECTED", "APPROVED", "INTEGRATED"]);

// ───────────────────────────────────────────── engine ─────────────────────────────────────────────

/**
 * Run a dossier through a command list.
 * @param {object} dossier {id, requiresInspection?, definition?}
 * @param {object[]} commands ordered; each {cmd, at:"YYYY-MM-DD", ...}
 * @returns {object} report
 */
export function run(dossier, commands) {
  const def = dossier?.definition ?? DEFAULT_DEFINITION;
  const dossierId = String(dossier?.id ?? "DOSSIER");
  const requiresInspection = dossier?.requiresInspection === true;
  const byType = Object.fromEntries(def.documents.map((d) => [d.type, d]));
  const isRequired = (d) => d.required || (d.requiredIf === "requiresInspection" && requiresInspection);

  const events = [], rejected = [], ignored = [], notifications = [], integration = [];
  const docs = Object.fromEntries(def.documents.map((d) => [d.type, { type: d.type, role: d.role, required: isRequired(d), status: "MISSING", version: null, sha: null, receivedAt: null, fields: null, missing: null, payload: null, integrationKey: null, slaBreached: false }]));
  let seq = 0, closed = false, closedAt = null, recon = null, reconInputVersions = null, clock = null;

  const emit = (type, at, data) => { events.push({ seq: ++seq, type, at, ...data }); };
  const notify = (at, role, template, about, reason) => { notifications.push({ seq: seq + 1, at, role, template, about, reason }); emit("NotificationQueued", at, { role, template, about, reason }); };
  const reject = (c, rule, reason) => { rejected.push({ seq: seq + 1, at: c.at, cmd: c.cmd, type: c.type ?? null, rule, reason }); emit("CommandRejected", c.at, { cmd: c.cmd, document: c.type ?? null, rule, reason }); };
  const ignore = (c, rule, reason) => { ignored.push({ seq: seq + 1, at: c.at, cmd: c.cmd, type: c.type ?? null, rule, reason }); emit("CommandIgnored", c.at, { cmd: c.cmd, document: c.type ?? null, rule, reason }); };

  const integrationKey = (type, version) => `${dossierId}|${type}|v${version}`;

  function checkSla(at) {
    const today = dayNumber(at);
    if (today === null) return;
    for (const d of Object.values(docs)) {
      if (d.receivedAt === null || d.slaBreached || d.status === "APPROVED" || d.status === "INTEGRATED") continue;
      const start = dayNumber(d.receivedAt), sla = byType[d.type].slaDays;
      if (start !== null && today - start > sla) {
        d.slaBreached = true;
        emit("SlaBreached", at, { document: d.type, role: d.role, days: today - start, slaDays: sla, version: d.version, rule: "F10" });
        notify(at, d.role, "SLA_BREACH", d.type, `${today - start} days since receipt, SLA ${sla}`);
      }
    }
  }

  function runReconciliation(at) {
    const g = def.reconciliation.group;
    const ready = g.every((t) => docs[t].payload !== null && docs[t].missing === null);
    if (!ready) return;
    const versions = g.map((t) => `${t}@${docs[t].version}`).join(",");
    if (reconInputVersions === versions) return; // already run for exactly these versions
    reconInputVersions = versions;
    const bundle = { invoice: docs.COMMERCIAL_INVOICE.payload, packingList: docs.PACKING_LIST.payload, billOfLading: docs.BILL_OF_LADING.payload };
    const report = docrecon(bundle);
    recon = { at, status: report.status, blockers: report.summary.BLOCKER, warnings: report.summary.WARNING, findings: report.findings.map((f) => `${f.rule}|${f.key}`), inputVersions: versions };
    emit("ReconciliationRun", at, { status: report.status, blockers: report.summary.BLOCKER, warnings: report.summary.WARNING, findings: recon.findings, rule: "F07" });
    if (report.status === "BLOCKED") {
      emit("RoutedToCompliance", at, { role: def.reconciliation.complianceRole, findings: recon.findings, rule: "F07" });
      notify(at, def.reconciliation.complianceRole, "RECONCILIATION_BLOCKED", "RECONCILIATION", `${report.summary.BLOCKER} blocking finding(s): ${recon.findings.join(" ")}`);
    }
  }

  function tryClose(at) {
    if (closed) return;
    const req = Object.values(docs).filter((d) => d.required);
    if (req.length && req.every((d) => d.status === "INTEGRATED")) {
      closed = true; closedAt = at;
      emit("DossierClosed", at, { documents: req.map((d) => d.type), rule: "F11" });
    }
  }

  for (const c of commands ?? []) {
    if (!c || typeof c !== "object") continue;
    if (dayNumber(c.at) === null) { reject({ ...c, at: String(c.at ?? "") }, "F16", `command has no valid ISO date 'at' (${c.at})`); continue; }
    if (clock !== null && dayNumber(c.at) < dayNumber(clock)) { reject(c, "F17", `command dated ${c.at} is before the dossier clock ${clock}`); continue; }
    clock = c.at;
    if (closed) { reject(c, "F11", `dossier closed on ${closedAt}`); continue; }
    checkSla(c.at);
    switch (c.cmd) {
      case "RECEIVE": {
        const d = byType[c.type] ? docs[c.type] : null;
        if (!d) { reject(c, "F15", `unknown document type ${c.type}`); break; }
        const version = Number.isInteger(c.version) ? c.version : null;
        if (version === null || version < 1) { reject(c, "F03", `version must be a positive integer (${c.version})`); break; }
        if (d.sha !== null && c.sha && c.sha === d.sha) { ignore(c, "F02", `same sha ${c.sha} already received as v${d.version}`); break; }
        if (d.version !== null && version <= d.version) { reject(c, "F03", `version ${version} is not above current v${d.version}`); break; }
        if (d.version !== null) {
          const pending = integration.find((i) => i.document === d.type && i.status === "QUEUED");
          if (pending) { pending.status = "SUPERSEDED"; emit("IntegrationCancelled", c.at, { document: d.type, key: pending.key, rule: "F03" }); }
          emit("DocumentSuperseded", c.at, { document: d.type, oldVersion: d.version, newVersion: version, previousStatus: d.status, rule: "F03" });
        }
        d.version = version; d.sha = c.sha ?? null; d.receivedAt = c.at; d.payload = c.payload ?? {}; d.integrationKey = null; d.slaBreached = false;
        emit("DocumentReceived", c.at, { document: d.type, version, sha: d.sha });
        const spec = byType[d.type];
        const present = {}, missing = [];
        for (const f of spec.fields) {
          const v = d.payload[f];
          const ok = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== "";
          if (ok) present[f] = v; else missing.push(f);
        }
        d.fields = present; d.missing = missing.length ? missing : null;
        if (missing.length) {
          d.status = "EXTRACTION_FAILED";
          emit("ExtractionFailed", c.at, { document: d.type, missing, rule: "F04" });
          notify(c.at, d.role, "EXTRACTION_FAILED", d.type, `missing: ${missing.join(", ")}`);
        } else {
          d.status = "AWAITING_APPROVAL";
          emit("ExtractionSucceeded", c.at, { document: d.type, fields: Object.keys(present) });
          emit("Routed", c.at, { document: d.type, role: d.role });
          notify(c.at, d.role, "ACTION_REQUIRED", d.type, `v${version} awaiting your approval`);
        }
        if (def.reconciliation.group.includes(d.type)) runReconciliation(c.at);
        break;
      }
      case "APPROVE":
      case "REJECT": {
        const d = byType[c.type] ? docs[c.type] : null;
        if (!d) { reject(c, "F15", `unknown document type ${c.type}`); break; }
        if (c.role !== d.role) { reject(c, "F01", `${c.role ?? "no role"} may not act on ${d.type}; assigned role is ${d.role}`); break; }
        if (d.status === "MISSING") { reject(c, "F04", `${d.type} has not been received`); break; }
        if (c.cmd === "REJECT") {
          if (!c.reason || !String(c.reason).trim()) { reject(c, "F14", "rejection requires a reason"); break; }
          if (d.status === "INTEGRATED") { reject(c, "F03", `${d.type} v${d.version} is already integrated; a new version is required`); break; }
          const pending = integration.find((i) => i.document === d.type && i.status === "QUEUED");
          if (pending) { pending.status = "CANCELLED"; emit("IntegrationCancelled", c.at, { document: d.type, key: pending.key, rule: "F05" }); }
          d.status = "REJECTED"; d.integrationKey = null;
          emit("ApprovalRejected", c.at, { document: d.type, version: d.version, role: c.role, reason: String(c.reason) });
          notify(c.at, def.intakeRole, "DOCUMENT_REJECTED", d.type, `${c.role}: ${String(c.reason)} — resubmit as v${d.version + 1}`);
          break;
        }
        if (d.status === "EXTRACTION_FAILED") { reject(c, "F04", `${d.type} is missing ${d.missing.join(", ")}`); break; }
        if (d.status === "APPROVED" || d.status === "INTEGRATED") { ignore(c, "F05", `${d.type} v${d.version} already ${d.status.toLowerCase()}`); break; }
        if (d.status === "REJECTED") { reject(c, "F03", `${d.type} v${d.version} was rejected; a new version is required`); break; }
        const spec = byType[d.type];
        if (spec.requiresApproved) {
          const notYet = spec.requiresApproved.filter((t) => !["APPROVED", "INTEGRATED"].includes(docs[t].status));
          if (notYet.length) { reject(c, "F08", `${d.type} requires approved ${notYet.join(", ")}`); break; }
        }
        if (spec.gate === "RECONCILIATION") {
          if (!recon) { reject(c, "F07", `reconciliation has not run yet (needs ${def.reconciliation.group.join(", ")})`); break; }
          if (recon.status === "BLOCKED") { reject(c, "F07", `reconciliation BLOCKED: ${recon.findings.join(" ")}`); break; }
        }
        if (spec.check === "INSURANCE_COVERS_INVOICE") {
          const inv = docs.COMMERCIAL_INVOICE;
          if (inv.payload === null || inv.missing !== null) { reject(c, "F09", "invoice must be received and extracted before insurance can be approved"); break; }
          const cover = toMinor(d.payload.coveredValue, SCALE.MONEY), total = toMinor(inv.payload.total, SCALE.MONEY);
          if (cover === null || total === null) { reject(c, "F09", `coveredValue (${d.payload.coveredValue}) or invoice total (${inv.payload.total}) is not a number`); break; }
          if (normKey(d.payload.currency) !== normKey(inv.payload.currency)) { reject(c, "F09", `insurance currency ${normKey(d.payload.currency)} ≠ invoice currency ${normKey(inv.payload.currency)}`); break; }
          if (cover < total) { reject(c, "F09", `cover ${d.payload.coveredValue} < invoice total ${inv.payload.total}`); break; }
        }
        d.status = "APPROVED";
        emit("ApprovalGranted", c.at, { document: d.type, version: d.version, role: c.role });
        const key = integrationKey(d.type, d.version);
        d.integrationKey = key;
        const rec = { seq: seq + 1, at: c.at, document: d.type, version: d.version, key, adapter: def.integration.adapter, target: `${def.integration.schema}.STG_${d.type}`, fields: d.fields, status: "QUEUED", ackedAt: null };
        integration.push(rec);
        emit("IntegrationQueued", c.at, { document: d.type, key, adapter: rec.adapter, target: rec.target, rule: "F05" });
        break;
      }
      case "INTEGRATION_ACK": {
        const rec = integration.find((i) => i.key === c.key);
        if (!rec) { reject(c, "F06", `unknown integration key ${c.key}`); break; }
        if (rec.status === "ACKED") { ignore(c, "F06", `key ${c.key} already acknowledged on ${rec.ackedAt}`); break; }
        if (rec.status !== "QUEUED") { reject(c, "F06", `key ${c.key} is ${rec.status.toLowerCase()} (superseded by a newer version or cancelled by a rejection)`); break; }
        rec.status = "ACKED"; rec.ackedAt = c.at;
        const d = docs[rec.document];
        if (d.integrationKey === c.key) { d.status = "INTEGRATED"; }
        emit("IntegrationAcked", c.at, { document: rec.document, key: c.key });
        tryClose(c.at);
        break;
      }
      case "TICK": {
        emit("Tick", c.at, {});
        break;
      }
      default:
        reject(c, "F16", `unknown command ${c.cmd}`);
    }
  }

  const documents = {};
  for (const d of Object.values(docs)) documents[d.type] = { role: d.role, required: d.required, status: d.status, version: d.version, receivedAt: d.receivedAt, missing: d.missing, integrationKey: d.integrationKey, slaBreached: d.slaBreached };
  const required = Object.values(docs).filter((d) => d.required);
  return {
    version: VERSION,
    dossier: dossierId,
    definition: def.id,
    status: closed ? "CLOSED" : "OPEN",
    closedAt,
    progress: { required: required.length, integrated: required.filter((d) => d.status === "INTEGRATED").length, awaiting: required.filter((d) => d.status === "AWAITING_APPROVAL").length, missing: required.filter((d) => d.status === "MISSING").length },
    reconciliation: recon,
    documents,
    integration,
    notifications,
    rejected,
    ignored,
    events,
  };
}
