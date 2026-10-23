namespace Dalteno.DocRecon;

/// <summary>Finding severity. BLOCKER ⇒ report status BLOCKED; WARNING ⇒ REVIEW; INFO never changes status.</summary>
public enum Severity
{
    /// <summary>Must be resolved before the shipment can be cleared.</summary>
    BLOCKER,
    /// <summary>Needs a human look; may be legitimate.</summary>
    WARNING,
    /// <summary>Data-quality note.</summary>
    INFO,
}

/// <summary>A rule in the catalogue. Ids are stable and shared with the JS implementation.</summary>
public sealed record Rule(string Id, string Code, Severity Severity, string Contract);

/// <summary>One reconciliation finding: which rule, where, what was expected, what was found, and why.</summary>
public sealed record Finding(
    string Rule,
    string Code,
    Severity Severity,
    string Key,
    string Field,
    string? Expected,
    string? Actual,
    string Reason,
    IReadOnlyList<string> Documents);

/// <summary>Counts per severity.</summary>
public sealed record Summary(
    [property: System.Text.Json.Serialization.JsonPropertyName("BLOCKER")] int BLOCKER,
    [property: System.Text.Json.Serialization.JsonPropertyName("WARNING")] int WARNING,
    [property: System.Text.Json.Serialization.JsonPropertyName("INFO")] int INFO);

/// <summary>Reconciliation report. Findings are ordered by rule id then key — deterministic for a given input.</summary>
public sealed record Report(string Version, string Status, int RulesEvaluated, Summary Summary, IReadOnlyList<Finding> Findings);

/// <summary>The rule catalogue (21 rules). Keep in sync with web/docrecon.js — the parity test enforces it.</summary>
public static class RuleCatalogue
{
    /// <summary>All rules in id order.</summary>
    public static readonly IReadOnlyList<Rule> All = new List<Rule>
    {
        new("R01", "PACKING_INVOICE_REF", Severity.BLOCKER, "Packing list must reference the invoice number."),
        new("R02", "BL_SHIPMENT_REF", Severity.BLOCKER, "Bill of lading and packing list must carry the same shipment reference."),
        new("R03", "LINE_MISSING_IN_PACKING", Severity.BLOCKER, "Every invoiced SKU must appear on the packing list."),
        new("R04", "LINE_EXTRA_IN_PACKING", Severity.BLOCKER, "Every packed SKU must appear on the invoice."),
        new("R05", "QTY_MISMATCH", Severity.BLOCKER, "Invoiced quantity must equal packed quantity per SKU (within tolerance)."),
        new("R06", "LINE_TOTAL_ARITHMETIC", Severity.BLOCKER, "quantity × unit price must equal the line total (±amount tolerance)."),
        new("R07", "INVOICE_TOTAL_ARITHMETIC", Severity.BLOCKER, "Sum of line totals must equal the invoice total (±amount tolerance)."),
        new("R08", "CURRENCY_MIXED", Severity.BLOCKER, "A line priced in a currency other than the invoice currency."),
        new("R09", "GROSS_WEIGHT_BL_VS_PACKING", Severity.WARNING, "BL gross weight must match packing-list gross weight within tolerance."),
        new("R10", "NET_GT_GROSS", Severity.BLOCKER, "Net weight can never exceed gross weight."),
        new("R11", "PACKAGE_COUNT_BL_VS_PACKING", Severity.WARNING, "BL package count must match packing-list package count."),
        new("R12", "DATE_ORDER", Severity.WARNING, "invoice date ≤ packing date ≤ shipped-on-board date, within the allowed span."),
        new("R13", "HS_CODE_FORMAT", Severity.INFO, "HS code must be 6–10 digits (separators ignored)."),
        new("R14", "HS_CODE_CONFLICT", Severity.WARNING, "The same SKU must carry the same HS code on invoice and packing list."),
        new("R15", "DUPLICATE_SKU_CONFLICT", Severity.WARNING, "A SKU repeated on the invoice with a different unit price or HS code."),
        new("R16", "NON_POSITIVE_VALUE", Severity.BLOCKER, "Quantities, prices, weights and package counts must be > 0."),
        new("R17", "CONSIGNEE_MISMATCH", Severity.WARNING, "BL consignee must match the invoice buyer (normalised, legal suffix ignored)."),
        new("R18", "INCOTERM_UNKNOWN", Severity.INFO, "Incoterm must be one of the Incoterms 2020 codes."),
        new("R19", "UNIT_MISMATCH", Severity.BLOCKER, "Unit of measure must agree per SKU between invoice and packing list."),
        new("R20", "PACKING_TOTALS_ARITHMETIC", Severity.WARNING, "Packing-list totals must equal the sum of their lines (packages, net, gross)."),
        new("R21", "MISSING_REQUIRED", Severity.BLOCKER, "A required document, field or line set is absent."),
        new("R22", "FIELD_ABSENT", Severity.WARNING, "A field another rule needs is absent, so that rule could not run. Reported once per field; absence is never treated as a match."),
    };

    private static readonly Dictionary<string, Rule> ById = All.ToDictionary(r => r.Id);

    /// <summary>Look a rule up by id; throws for an unknown id (programming error, never user input).</summary>
    public static Rule Get(string id) => ById[id];
}

/// <summary>
/// Engine options. Tolerances are basis points (1 bp = 0.01 %) and minor units, so the engine stays integer-only.
/// </summary>
public sealed record ReconcileOptions
{
    /// <summary>Quantity tolerance per SKU, basis points. Default 0.</summary>
    public int QtyToleranceBp { get; init; } = 0;
    /// <summary>Gross-weight tolerance BL vs packing list, basis points. Default 200 (2 %).</summary>
    public int WeightToleranceBp { get; init; } = 200;
    /// <summary>Package-count tolerance BL vs packing list, basis points. Default 0.</summary>
    public int PackageToleranceBp { get; init; } = 0;
    /// <summary>Allowed absolute drift on line/invoice totals, in minor units of the invoice currency. Default 1 (0.01).</summary>
    public int AmountToleranceMinor { get; init; } = 1;
    /// <summary>Maximum days between invoice date and shipped-on-board date. Default 60.</summary>
    public int MaxDocumentSpanDays { get; init; } = 60;
    /// <summary>Incoterms 2020.</summary>
    public IReadOnlyList<string> KnownIncoterms { get; init; } = new[] { "EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP" };
    /// <summary>Legal-form suffixes ignored when comparing party names.</summary>
    public IReadOnlyList<string> LegalSuffixes { get; init; } = new[] { "GMBH", "AG", "LTD", "LIMITED", "LLC", "INC", "CO", "BV", "NV", "SA", "SARL", "SAS", "SRL", "SPA", "PLC", "KG", "OHG", "UG", "SE", "LLP", "PTY", "CORP", "CORPORATION", "COMPANY" };

    /// <summary>Defaults.</summary>
    public static readonly ReconcileOptions Default = new();
}
