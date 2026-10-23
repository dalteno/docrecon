namespace Dalteno.DocFlow;

/// <summary>One document type in a dossier definition.</summary>
public sealed record DocumentSpec(
    string Type,
    string Role,
    bool Required,
    IReadOnlyList<string> Fields,
    int SlaDays,
    string? RequiredIf = null,
    IReadOnlyList<string>? RequiresApproved = null,
    string? Gate = null,
    string? Check = null);

/// <summary>Reconciliation gate: which documents feed docrecon and who is told when it is BLOCKED.</summary>
public sealed record ReconciliationSpec(IReadOnlyList<string> Group, string ComplianceRole, bool ReviewNeedsSignoff = true);

/// <summary>Outbox target for the existing ERP (adapter name and staging schema).</summary>
public sealed record IntegrationSpec(string Adapter, string Schema);

/// <summary>A dossier definition — data, not code. Mirrors DEFAULT_DEFINITION in web/docflow.js.</summary>
public sealed record DossierDefinition(string Id, string IntakeRole, IReadOnlyList<DocumentSpec> Documents, ReconciliationSpec Reconciliation, IntegrationSpec Integration)
{
    /// <summary>Sea import, Egyptian customs practice; the roles are the real roles of the process.</summary>
    public static readonly DossierDefinition Default = new(
        "SEA_IMPORT_V1",
        "INTAKE",
        new List<DocumentSpec>
        {
            new("COMMERCIAL_INVOICE", "FINANCE", true, new[] { "number", "date", "currency", "total", "buyer" }, 2),
            new("PACKING_LIST", "WAREHOUSE", true, new[] { "number", "invoiceRef", "totalPackages", "totalGrossKg" }, 2),
            new("BILL_OF_LADING", "LOGISTICS", true, new[] { "number", "shipmentRef", "containers", "seals" }, 1),
            new("CERTIFICATE_OF_ORIGIN", "CUSTOMS_BROKER", true, new[] { "number", "originCountry", "invoiceRef" }, 3),
            new("CUSTOMS_ENTRY", "CUSTOMS_BROKER", true, new[] { "entryNo", "declaredValue", "hsCodes" }, 5, RequiresApproved: new[] { "CERTIFICATE_OF_ORIGIN" }, Gate: "RECONCILIATION"),
            new("INSURANCE_CERT", "FINANCE", true, new[] { "policyNo", "coveredValue", "currency" }, 3, Check: "INSURANCE_COVERS_INVOICE"),
            new("INSPECTION_CERT", "QUALITY", false, new[] { "certNo", "result" }, 3, RequiredIf: "requiresInspection"),
        },
        new ReconciliationSpec(new[] { "COMMERCIAL_INVOICE", "PACKING_LIST", "BILL_OF_LADING" }, "CUSTOMS_BROKER"),
        new IntegrationSpec("ORACLE_STAGING", "DOCFLOW_STG"));
}

/// <summary>A workflow rule. Ids are stable and shared with web/docflow.js.</summary>
public sealed record FlowRule(string Id, string Code, string Contract);

/// <summary>Rule catalogue F01–F16.</summary>
public static class FlowRules
{
    public static readonly IReadOnlyList<FlowRule> All = new List<FlowRule>
    {
        new("F01", "ROLE_AUTHORISATION", "Only the role assigned to a document type may approve or reject it."),
        new("F02", "IDEMPOTENT_RECEIVE", "Receiving the same document bytes (sha) again is ignored, never duplicated."),
        new("F03", "VERSION_SUPERSEDES", "A higher version supersedes: approval and pending integration are invalidated and the document is re-routed. A lower or equal version is rejected."),
        new("F04", "EXTRACTION_BEFORE_APPROVAL", "A document cannot be approved while required fields are missing."),
        new("F05", "APPROVAL_BEFORE_INTEGRATION", "Integration is queued only by a successful approval."),
        new("F06", "INTEGRATION_IDEMPOTENCY", "Integration key = dossier|type|version; an unknown key is rejected, a repeated ack is ignored."),
        new("F07", "RECONCILIATION_GATE", "When invoice, packing list and BL are all extracted, docrecon runs; BLOCKED routes to compliance and blocks the customs entry."),
        new("F08", "PREREQUISITE_APPROVAL", "A document with prerequisites (customs entry ← certificate of origin) cannot be approved before they are approved."),
        new("F09", "INSURANCE_COVERS_INVOICE", "Insurance cover must be ≥ invoice total in the invoice currency; needs the invoice first."),
        new("F10", "SLA_BREACH", "Days since receipt beyond the role's SLA raise one breach per document version."),
        new("F11", "CLOSE_WHEN_COMPLETE", "The dossier closes exactly when every required document is INTEGRATED; commands after close are rejected."),
        new("F12", "CONDITIONAL_DOCUMENT", "Inspection certificate is required only when the dossier flags requiresInspection."),
        new("F13", "ONE_NOTIFICATION_PER_HANDOFF", "Every routing, rejection, extraction failure, compliance routing and SLA breach queues exactly one notification."),
        new("F14", "REJECTION_NEEDS_REASON", "A rejection without a reason is itself rejected."),
        new("F15", "UNKNOWN_DOCUMENT_TYPE", "A document type outside the dossier definition is rejected."),
        new("F16", "INVALID_COMMAND", "A command without a valid ISO date or with an unknown verb is rejected."),
        new("F17", "MONOTONIC_TIME", "A command dated before the latest processed command is rejected: the dossier clock never runs backwards."),
        new("F18", "REVIEW_NEEDS_SIGNOFF", "When reconciliation ends in REVIEW, the gated document is approved only with acceptWarnings and a written reason; the acceptance is recorded with the role. A re-run of reconciliation clears it. BLOCKED can never be accepted."),
    };
}
