using System.Numerics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Dalteno.DocRecon;

namespace Dalteno.DocFlow;

/// <summary>
/// Deterministic, event-sourced dossier workflow. <c>Run(dossier, commands)</c> is a pure function: no clock (every
/// command carries <c>at</c>), no I/O, no randomness. Mirrors web/docflow.js command by command; the shared cases
/// under /cases-docflow are the parity gate.
/// </summary>
public static class Engine
{
    public const string Version = "1.1.0";

    private sealed class Doc
    {
        public required string Type; public required string Role; public bool Required;
        public string Status = "MISSING"; public int? Version; public string? Sha; public string? ReceivedAt;
        public JsonObject? Fields; public List<string>? Missing; public JsonObject? Payload; public string? IntegrationKey; public bool SlaBreached;
    }

    /// <summary>Run with the default definition.</summary>
    public static FlowReport Run(JsonObject? dossier, JsonArray? commands) => Run(dossier, commands, DossierDefinition.Default);

    /// <summary>Run a dossier through an ordered command list.</summary>
    public static FlowReport Run(JsonObject? dossier, JsonArray? commands, DossierDefinition def)
    {
        var dossierId = Str(dossier?["id"]) ?? "DOSSIER";
        var requiresInspection = dossier?["requiresInspection"] is JsonValue rv && rv.TryGetValue<bool>(out var b) && b;
        var byType = def.Documents.ToDictionary(d => d.Type);
        bool IsRequired(DocumentSpec d) => d.Required || (d.RequiredIf == "requiresInspection" && requiresInspection);

        var events = new List<JsonObject>(); var rejected = new List<CommandOutcome>(); var ignored = new List<CommandOutcome>();
        var notifications = new List<Notification>(); var integration = new List<IntegrationRecord>();
        var docs = def.Documents.ToDictionary(d => d.Type, d => new Doc { Type = d.Type, Role = d.Role, Required = IsRequired(d) });
        var order = def.Documents.Select(d => d.Type).ToList();
        int seq = 0; bool closed = false; string? closedAt = null; ReconciliationState? recon = null; string? reconInputVersions = null; string? clock = null;

        void Emit(string type, string at, params (string key, JsonNode? value)[] data)
        {
            var e = new JsonObject { ["seq"] = ++seq, ["type"] = type, ["at"] = at };
            foreach (var (k, v) in data) e[k] = v;
            events.Add(e);
        }
        void Notify(string at, string role, string template, string about, string reason)
        {
            notifications.Add(new Notification(seq + 1, at, role, template, about, reason));
            Emit("NotificationQueued", at, ("role", role), ("template", template), ("about", about), ("reason", reason));
        }
        void Reject(string at, string cmd, string? type, string rule, string reason)
        {
            rejected.Add(new CommandOutcome(seq + 1, at, cmd, type, rule, reason));
            Emit("CommandRejected", at, ("cmd", cmd), ("document", type), ("rule", rule), ("reason", reason));
        }
        void Ignore(string at, string cmd, string? type, string rule, string reason)
        {
            ignored.Add(new CommandOutcome(seq + 1, at, cmd, type, rule, reason));
            Emit("CommandIgnored", at, ("cmd", cmd), ("document", type), ("rule", rule), ("reason", reason));
        }
        string IntegrationKey(string type, int version) => $"{dossierId}|{type}|v{version}";

        void CheckSla(string at)
        {
            var today = Numeric.DayNumber(at);
            if (today is null) return;
            foreach (var t in order)
            {
                var d = docs[t];
                if (d.ReceivedAt is null || d.SlaBreached || d.Status is "APPROVED" or "INTEGRATED") continue;
                var start = Numeric.DayNumber(d.ReceivedAt); var sla = byType[d.Type].SlaDays;
                if (start is not null && today - start > sla)
                {
                    d.SlaBreached = true;
                    var days = (int)(today.Value - start.Value);
                    Emit("SlaBreached", at, ("document", d.Type), ("role", d.Role), ("days", days), ("slaDays", sla), ("version", d.Version), ("rule", "F10"));
                    Notify(at, d.Role, "SLA_BREACH", d.Type, $"{days} days since receipt, SLA {sla}");
                }
            }
        }

        void RunReconciliation(string at)
        {
            var g = def.Reconciliation.Group;
            if (!g.All(t => docs[t].Payload is not null && docs[t].Missing is null)) return;
            var versions = string.Join(",", g.Select(t => $"{t}@{docs[t].Version}"));
            if (reconInputVersions == versions) return;
            reconInputVersions = versions;
            var bundle = new Bundle
            {
                Invoice = docs["COMMERCIAL_INVOICE"].Payload!.Deserialize<Invoice>(Json.Options),
                PackingList = docs["PACKING_LIST"].Payload!.Deserialize<PackingList>(Json.Options),
                BillOfLading = docs["BILL_OF_LADING"].Payload!.Deserialize<BillOfLading>(Json.Options),
            };
            var report = Reconciler.Reconcile(bundle);
            var findings = report.Findings.Select(f => $"{f.Rule}|{f.Key}").ToList();
            recon = new ReconciliationState(at, report.Status, report.Summary.BLOCKER, report.Summary.WARNING, findings, versions, null); // a re-run always clears any earlier acceptance
            Emit("ReconciliationRun", at, ("status", report.Status), ("blockers", report.Summary.BLOCKER), ("warnings", report.Summary.WARNING), ("findings", Arr(findings)), ("rule", "F07"));
            if (report.Status == "BLOCKED")
            {
                Emit("RoutedToCompliance", at, ("role", def.Reconciliation.ComplianceRole), ("findings", Arr(findings)), ("rule", "F07"));
                Notify(at, def.Reconciliation.ComplianceRole, "RECONCILIATION_BLOCKED", "RECONCILIATION", $"{report.Summary.BLOCKER} blocking finding(s): {string.Join(" ", findings)}");
            }
        }

        void TryClose(string at)
        {
            if (closed) return;
            var req = order.Select(t => docs[t]).Where(d => d.Required).ToList();
            if (req.Count > 0 && req.All(d => d.Status == "INTEGRATED"))
            {
                closed = true; closedAt = at;
                Emit("DossierClosed", at, ("documents", Arr(req.Select(d => d.Type))), ("rule", "F11"));
            }
        }

        foreach (var node in commands ?? new JsonArray())
        {
            if (node is not JsonObject c) continue;
            var cmd = Str(c["cmd"]) ?? ""; var type = Str(c["type"]); var rawAt = c["at"];
            var at = Str(rawAt) ?? "";
            if (Numeric.DayNumber(at) is null) { Reject(at, cmd, type, "F16", $"command has no valid ISO date 'at' ({(rawAt is null ? "undefined" : rawAt.ToJsonString().Trim('"'))})"); continue; }
            if (clock is not null && Numeric.DayNumber(at) < Numeric.DayNumber(clock)) { Reject(at, cmd, type, "F17", $"command dated {at} is before the dossier clock {clock}"); continue; }
            clock = at;
            if (closed) { Reject(at, cmd, type, "F11", $"dossier closed on {closedAt}"); continue; }
            CheckSla(at);
            switch (cmd)
            {
                case "RECEIVE":
                {
                    if (type is null || !byType.TryGetValue(type, out var spec)) { Reject(at, cmd, type, "F15", $"unknown document type {type ?? "undefined"}"); break; }
                    var d = docs[type];
                    int? version = c["version"] is JsonValue vv && vv.TryGetValue<int>(out var vi) ? vi : null;
                    if (version is null || version < 1) { Reject(at, cmd, type, "F03", $"version must be a positive integer ({(c["version"] is null ? "undefined" : c["version"]!.ToJsonString().Trim('"'))})"); break; }
                    var sha = Str(c["sha"]);
                    if (d.Sha is not null && !string.IsNullOrEmpty(sha) && sha == d.Sha) { Ignore(at, cmd, type, "F02", $"same sha {sha} already received as v{d.Version}"); break; }
                    if (d.Version is not null && version <= d.Version) { Reject(at, cmd, type, "F03", $"version {version} is not above current v{d.Version}"); break; }
                    if (d.Version is not null)
                    {
                        var pending = integration.FirstOrDefault(i => i.Document == d.Type && i.Status == "QUEUED");
                        if (pending is not null) { pending.Status = "SUPERSEDED"; Emit("IntegrationCancelled", at, ("document", d.Type), ("key", pending.Key), ("rule", "F03")); }
                        Emit("DocumentSuperseded", at, ("document", d.Type), ("oldVersion", d.Version), ("newVersion", version), ("previousStatus", d.Status), ("rule", "F03"));
                    }
                    d.Version = version; d.Sha = sha; d.ReceivedAt = at; d.Payload = c["payload"] as JsonObject ?? new JsonObject(); d.IntegrationKey = null; d.SlaBreached = false;
                    Emit("DocumentReceived", at, ("document", d.Type), ("version", version), ("sha", d.Sha));
                    var present = new JsonObject(); var missing = new List<string>();
                    foreach (var f in spec.Fields)
                    {
                        var v = d.Payload[f];
                        var ok = v is JsonArray arr ? arr.Count > 0 : v is JsonObject || (v is JsonValue && v.ToString().Trim().Length > 0);
                        if (ok) present[f] = v!.DeepClone(); else missing.Add(f);
                    }
                    d.Fields = present; d.Missing = missing.Count > 0 ? missing : null;
                    if (missing.Count > 0)
                    {
                        d.Status = "EXTRACTION_FAILED";
                        Emit("ExtractionFailed", at, ("document", d.Type), ("missing", Arr(missing)), ("rule", "F04"));
                        Notify(at, d.Role, "EXTRACTION_FAILED", d.Type, $"missing: {string.Join(", ", missing)}");
                    }
                    else
                    {
                        d.Status = "AWAITING_APPROVAL";
                        Emit("ExtractionSucceeded", at, ("document", d.Type), ("fields", Arr(spec.Fields.Where(f => present.ContainsKey(f)))));
                        Emit("Routed", at, ("document", d.Type), ("role", d.Role));
                        Notify(at, d.Role, "ACTION_REQUIRED", d.Type, $"v{version} awaiting your approval");
                    }
                    if (def.Reconciliation.Group.Contains(d.Type)) RunReconciliation(at);
                    break;
                }
                case "APPROVE":
                case "REJECT":
                {
                    if (type is null || !byType.TryGetValue(type, out var spec)) { Reject(at, cmd, type, "F15", $"unknown document type {type ?? "undefined"}"); break; }
                    var d = docs[type]; var role = Str(c["role"]);
                    if (role != d.Role) { Reject(at, cmd, type, "F01", $"{role ?? "no role"} may not act on {d.Type}; assigned role is {d.Role}"); break; }
                    if (d.Status == "MISSING") { Reject(at, cmd, type, "F04", $"{d.Type} has not been received"); break; }
                    if (cmd == "REJECT")
                    {
                        var reason = Str(c["reason"]);
                        if (string.IsNullOrWhiteSpace(reason)) { Reject(at, cmd, type, "F14", "rejection requires a reason"); break; }
                        if (d.Status == "INTEGRATED") { Reject(at, cmd, type, "F03", $"{d.Type} v{d.Version} is already integrated; a new version is required"); break; }
                        var pending = integration.FirstOrDefault(i => i.Document == d.Type && i.Status == "QUEUED");
                        if (pending is not null) { pending.Status = "CANCELLED"; Emit("IntegrationCancelled", at, ("document", d.Type), ("key", pending.Key), ("rule", "F05")); }
                        d.Status = "REJECTED"; d.IntegrationKey = null;
                        Emit("ApprovalRejected", at, ("document", d.Type), ("version", d.Version), ("role", role), ("reason", reason));
                        Notify(at, def.IntakeRole, "DOCUMENT_REJECTED", d.Type, $"{role}: {reason} — resubmit as v{d.Version + 1}");
                        break;
                    }
                    if (d.Status == "EXTRACTION_FAILED") { Reject(at, cmd, type, "F04", $"{d.Type} is missing {string.Join(", ", d.Missing!)}"); break; }
                    if (d.Status is "APPROVED" or "INTEGRATED") { Ignore(at, cmd, type, "F05", $"{d.Type} v{d.Version} already {d.Status.ToLowerInvariant()}"); break; }
                    if (d.Status == "REJECTED") { Reject(at, cmd, type, "F03", $"{d.Type} v{d.Version} was rejected; a new version is required"); break; }
                    if (spec.RequiresApproved is not null)
                    {
                        var notYet = spec.RequiresApproved.Where(t => docs[t].Status is not ("APPROVED" or "INTEGRATED")).ToList();
                        if (notYet.Count > 0) { Reject(at, cmd, type, "F08", $"{d.Type} requires approved {string.Join(", ", notYet)}"); break; }
                    }
                    if (spec.Gate == "RECONCILIATION")
                    {
                        if (recon is null) { Reject(at, cmd, type, "F07", $"reconciliation has not run yet (needs {string.Join(", ", def.Reconciliation.Group)})"); break; }
                        if (recon.Status == "BLOCKED") { Reject(at, cmd, type, "F07", $"reconciliation BLOCKED: {string.Join(" ", recon.Findings)}"); break; }
                        if (recon.Status == "REVIEW" && def.Reconciliation.ReviewNeedsSignoff && recon.AcceptedBy is null)
                        {
                            var acceptReason = (Str(c["reason"]) ?? "").Trim();
                            var accept = c["acceptWarnings"] is JsonValue av && av.TryGetValue<bool>(out var ab) && ab;
                            if (!accept || acceptReason.Length == 0) { Reject(at, cmd, type, "F18", $"reconciliation REVIEW ({recon.Warnings} warning(s): {string.Join(" ", recon.Findings)}) — approval needs acceptWarnings: true and a reason"); break; }
                            recon = recon with { AcceptedBy = new WarningsAcceptance(role!, at, acceptReason, recon.Findings.ToList()) };
                            Emit("ReconciliationWarningsAccepted", at, ("role", role), ("reason", acceptReason), ("findings", Arr(recon.Findings)), ("rule", "F18"));
                        }
                    }
                    if (spec.Check == "INSURANCE_COVERS_INVOICE")
                    {
                        var inv = docs["COMMERCIAL_INVOICE"];
                        if (inv.Payload is null || inv.Missing is not null) { Reject(at, cmd, type, "F09", "invoice must be received and extracted before insurance can be approved"); break; }
                        var coverRaw = Str(d.Payload!["coveredValue"]); var totalRaw = Str(inv.Payload["total"]);
                        var cover = Numeric.ToMinor(coverRaw, Scale.Money); var total = Numeric.ToMinor(totalRaw, Scale.Money);
                        if (cover is null || total is null) { Reject(at, cmd, type, "F09", $"coveredValue ({coverRaw ?? "undefined"}) or invoice total ({totalRaw ?? "undefined"}) is not a number"); break; }
                        var cc = Numeric.NormKey(Str(d.Payload["currency"])); var ic = Numeric.NormKey(Str(inv.Payload["currency"]));
                        if (cc != ic) { Reject(at, cmd, type, "F09", $"insurance currency {cc} ≠ invoice currency {ic}"); break; }
                        if (cover < total) { Reject(at, cmd, type, "F09", $"cover {coverRaw} < invoice total {totalRaw}"); break; }
                    }
                    d.Status = "APPROVED";
                    Emit("ApprovalGranted", at, ("document", d.Type), ("version", d.Version), ("role", role));
                    var key = IntegrationKey(d.Type, d.Version!.Value);
                    d.IntegrationKey = key;
                    var rec = new IntegrationRecord { Seq = seq + 1, At = at, Document = d.Type, Version = d.Version.Value, Key = key, Adapter = def.Integration.Adapter, Target = $"{def.Integration.Schema}.STG_{d.Type}", Fields = (JsonObject)d.Fields!.DeepClone() };
                    integration.Add(rec);
                    Emit("IntegrationQueued", at, ("document", d.Type), ("key", key), ("adapter", rec.Adapter), ("target", rec.Target), ("rule", "F05"));
                    break;
                }
                case "INTEGRATION_ACK":
                {
                    var key = Str(c["key"]);
                    var rec = integration.FirstOrDefault(i => i.Key == key);
                    if (rec is null) { Reject(at, cmd, type, "F06", $"unknown integration key {key ?? "undefined"}"); break; }
                    if (rec.Status == "ACKED") { Ignore(at, cmd, type, "F06", $"key {key} already acknowledged on {rec.AckedAt}"); break; }
                    if (rec.Status != "QUEUED") { Reject(at, cmd, type, "F06", $"key {key} is {rec.Status.ToLowerInvariant()} (superseded by a newer version or cancelled by a rejection)"); break; }
                    rec.Status = "ACKED"; rec.AckedAt = at;
                    var d = docs[rec.Document];
                    if (d.IntegrationKey == key) d.Status = "INTEGRATED";
                    Emit("IntegrationAcked", at, ("document", rec.Document), ("key", key));
                    TryClose(at);
                    break;
                }
                case "TICK":
                    Emit("Tick", at);
                    break;
                default:
                    Reject(at, cmd, type, "F16", $"unknown command {cmd}");
                    break;
            }
        }

        var documents = new Dictionary<string, DocumentState>();
        foreach (var t in order)
        {
            var d = docs[t];
            documents[t] = new DocumentState(d.Role, d.Required, d.Status, d.Version, d.ReceivedAt, d.Missing, d.IntegrationKey, d.SlaBreached);
        }
        var required = order.Select(t => docs[t]).Where(d => d.Required).ToList();
        var progress = new Progress(required.Count, required.Count(d => d.Status == "INTEGRATED"), required.Count(d => d.Status == "AWAITING_APPROVAL"), required.Count(d => d.Status == "MISSING"));
        return new FlowReport(Version, dossierId, def.Id, closed ? "CLOSED" : "OPEN", closedAt, progress, recon, documents, integration, notifications, rejected, ignored, events);
    }

    /// <summary>Scalar JSON node → its text (strings raw, numbers/bools as JSON text); null for null/absent/non-scalar.</summary>
    private static string? Str(JsonNode? n) => n is JsonValue v ? (v.TryGetValue<string>(out var s) ? s : v.ToJsonString()) : null;

    private static JsonArray Arr(IEnumerable<string> items) => new(items.Select(i => (JsonNode?)JsonValue.Create(i)).ToArray());
}
