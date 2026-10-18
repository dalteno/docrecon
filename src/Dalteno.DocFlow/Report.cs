using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Dalteno.DocFlow;

/// <summary>Per-document state in the final report.</summary>
public sealed record DocumentState(string Role, bool Required, string Status, int? Version, string? ReceivedAt, IReadOnlyList<string>? Missing, string? IntegrationKey, bool SlaBreached);

/// <summary>Required-document progress counters.</summary>
public sealed record Progress(int Required, int Integrated, int Awaiting, int Missing);

/// <summary>Outcome of the last docrecon run over invoice + packing list + BL.</summary>
public sealed record ReconciliationState(string At, string Status, int Blockers, int Warnings, IReadOnlyList<string> Findings, string InputVersions);

/// <summary>One outbox record for the existing ERP. Status: QUEUED → ACKED, or SUPERSEDED / CANCELLED.</summary>
public sealed class IntegrationRecord
{
    public int Seq { get; init; }
    public string At { get; init; } = "";
    public string Document { get; init; } = "";
    public int Version { get; init; }
    public string Key { get; init; } = "";
    public string Adapter { get; init; } = "";
    public string Target { get; init; } = "";
    public JsonObject Fields { get; init; } = new();
    public string Status { get; set; } = "QUEUED";
    public string? AckedAt { get; set; }
}

/// <summary>A queued notification (template + recipient role + reason). Sending is an adapter, not the engine.</summary>
public sealed record Notification(int Seq, string At, string Role, string Template, string About, string Reason);

/// <summary>A command the engine refused (rule violation) or ignored (idempotent no-op).</summary>
public sealed record CommandOutcome(int Seq, string At, string Cmd, string? Type, string Rule, string Reason);

/// <summary>Full report. Shape mirrors the JS report; the parity test compares them structurally.</summary>
public sealed record FlowReport(
    string Version,
    string Dossier,
    string Definition,
    string Status,
    string? ClosedAt,
    Progress Progress,
    ReconciliationState? Reconciliation,
    IReadOnlyDictionary<string, DocumentState> Documents,
    IReadOnlyList<IntegrationRecord> Integration,
    IReadOnlyList<Notification> Notifications,
    IReadOnlyList<CommandOutcome> Rejected,
    IReadOnlyList<CommandOutcome> Ignored,
    IReadOnlyList<JsonObject> Events);
