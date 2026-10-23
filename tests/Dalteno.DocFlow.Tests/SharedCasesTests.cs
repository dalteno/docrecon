using System.Text.Json;
using System.Text.Json.Nodes;
using Dalteno.DocRecon;
using Xunit;

namespace Dalteno.DocFlow.Tests;

/// <summary>Parity gate for the workflow engine: hand-written expectation summary + structural equality with the JS golden report.</summary>
public sealed class SharedCasesTests
{
    private static readonly string CasesDir = Path.Combine(AppContext.BaseDirectory, "cases-docflow");

    public static IEnumerable<object[]> CaseIds() =>
        Directory.GetFiles(CasesDir, "*.json").Select(f => Path.GetFileNameWithoutExtension(f)).OrderBy(x => x, StringComparer.Ordinal).Select(x => new object[] { x! });

    private static JsonObject Load(string id) => (JsonObject)JsonNode.Parse(File.ReadAllText(Path.Combine(CasesDir, id + ".json")))!;

    /// <summary>Same summary as web/tests/docflow.test.mjs → summarize().</summary>
    private static JsonObject Summarize(FlowReport r)
    {
        static string Key(CommandOutcome o) => $"{o.Rule}|{o.Type ?? o.Cmd}";
        return new JsonObject
        {
            ["status"] = r.Status,
            ["documents"] = new JsonObject(r.Documents.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)kv.Value.Status))),
            ["reconciliation"] = r.Reconciliation?.Status,
            ["rejected"] = new JsonArray(r.Rejected.Select(Key).OrderBy(x => x, StringComparer.Ordinal).Select(x => (JsonNode?)x).ToArray()),
            ["ignored"] = new JsonArray(r.Ignored.Select(Key).OrderBy(x => x, StringComparer.Ordinal).Select(x => (JsonNode?)x).ToArray()),
            ["slaBreached"] = new JsonArray(r.Documents.Where(kv => kv.Value.SlaBreached).Select(kv => kv.Key).OrderBy(x => x, StringComparer.Ordinal).Select(x => (JsonNode?)x).ToArray()),
            ["slaBreaches"] = r.Events.Count(e => (string?)e["type"] == "SlaBreached"),
            ["notifications"] = r.Notifications.Count,
            ["integrationQueued"] = r.Integration.Count,
            ["integrationAcked"] = r.Integration.Count(i => i.Status == "ACKED"),
        };
    }

    /// <summary>Recursively sort object keys so two structurally equal documents serialise identically.</summary>
    internal static JsonNode? Canon(JsonNode? n) => n switch
    {
        JsonObject o => new JsonObject(o.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => KeyValuePair.Create(kv.Key, Canon(kv.Value)))),
        JsonArray a => new JsonArray(a.Select(Canon).ToArray()),
        null => null,
        _ => n.DeepClone(),
    };

    [Fact]
    public void AtLeastFortyCases() => Assert.True(CaseIds().Count() >= 40);

    [Theory]
    [MemberData(nameof(CaseIds))]
    public void ExpectationSummaryMatches(string id)
    {
        var c = Load(id);
        var report = Engine.Run(c["dossier"] as JsonObject, c["commands"] as JsonArray);
        var expected = Canon(c["expect"])!.ToJsonString(Json.Options);
        var actual = Canon(Summarize(report))!.ToJsonString(Json.Options);
        Assert.Equal(expected, actual);
        // F13: one notification per hand-off event
        var handoffs = report.Events.Count(e => ((string?)e["type"]) is "Routed" or "ApprovalRejected" or "ExtractionFailed" or "RoutedToCompliance" or "SlaBreached");
        Assert.Equal(handoffs, report.Notifications.Count);
        for (var i = 0; i < report.Events.Count; i++) Assert.Equal(i + 1, (int)report.Events[i]["seq"]!);
    }

    [Theory]
    [MemberData(nameof(CaseIds))]
    public void GoldenParityWithJs(string id)
    {
        var goldenPath = Path.Combine(CasesDir, "golden", id + ".report.json");
        if (!File.Exists(goldenPath)) return;
        var c = Load(id);
        var report = Engine.Run(c["dossier"] as JsonObject, c["commands"] as JsonArray);
        var mine = Canon(JsonSerializer.SerializeToNode(report, Json.Options))!.ToJsonString(Json.Options);
        var golden = Canon(JsonNode.Parse(File.ReadAllText(goldenPath)))!.ToJsonString(Json.Options);
        Assert.Equal(golden, mine);
    }

    [Fact]
    public void Deterministic()
    {
        var c = Load("D40_late_approvals_full_dossier");
        var a = JsonSerializer.Serialize(Engine.Run(c["dossier"] as JsonObject, c["commands"] as JsonArray), Json.Options);
        var c2 = Load("D40_late_approvals_full_dossier");
        var b = JsonSerializer.Serialize(Engine.Run(c2["dossier"] as JsonObject, c2["commands"] as JsonArray), Json.Options);
        Assert.Equal(a, b);
    }

    [Fact]
    public void InputNotMutated()
    {
        var c = Load("D40_late_approvals_full_dossier");
        var before = c["commands"]!.ToJsonString();
        Engine.Run(c["dossier"] as JsonObject, c["commands"] as JsonArray);
        Assert.Equal(before, c["commands"]!.ToJsonString());
    }

    [Fact]
    public void CatalogueAndDefinitionAreStable()
    {
        Assert.Equal(18, FlowRules.All.Count);
        Assert.Equal(18, FlowRules.All.Select(r => r.Id).Distinct().Count());
        Assert.Equal(7, DossierDefinition.Default.Documents.Count);
        Assert.Equal(6, DossierDefinition.Default.Documents.Count(d => d.Required));
    }

    [Fact]
    public void NullInputsProduceAnOpenEmptyDossier()
    {
        var r = Engine.Run(null, null);
        Assert.Equal("OPEN", r.Status);
        Assert.Empty(r.Events);
        Assert.All(r.Documents.Values, d => Assert.Equal("MISSING", d.Status));
    }

    [Fact]
    public void F18_ReviewStopsTheGatedApproval_AcceptanceIsRecorded_RerunClearsIt()
    {
        // The flow must STOP on REVIEW, not merely "not be PASS" (external review, 23 Oct). Mirrors docflow.test.mjs.
        var c = JsonNode.Parse(File.ReadAllText(Path.Combine(CasesDir, "D44_review_accepted_with_reason.json")))!.AsObject();
        var dossier = c["dossier"] as JsonObject; var commands = (c["commands"] as JsonArray)!;
        var r1 = Engine.Run(JsonNode.Parse(dossier!.ToJsonString()) as JsonObject, JsonNode.Parse(commands.ToJsonString()) as JsonArray);
        Assert.Equal("REVIEW", r1.Reconciliation!.Status);
        Assert.Equal("APPROVED", r1.Documents["CUSTOMS_ENTRY"].Status);
        Assert.NotNull(r1.Reconciliation.AcceptedBy);
        Assert.Equal("CUSTOMS_BROKER", r1.Reconciliation.AcceptedBy!.Role);
        Assert.Single(r1.Events, e => (string?)e["type"] == "ReconciliationWarningsAccepted");

        // same commands without the acceptance flag → F18, document stays AWAITING_APPROVAL
        var stripped = JsonNode.Parse(commands.ToJsonString())!.AsArray();
        foreach (var n in stripped) if (n is JsonObject o && (string?)o["cmd"] == "APPROVE" && (string?)o["type"] == "CUSTOMS_ENTRY") { o.Remove("acceptWarnings"); o.Remove("reason"); }
        var r2 = Engine.Run(JsonNode.Parse(dossier.ToJsonString()) as JsonObject, stripped);
        Assert.Equal("AWAITING_APPROVAL", r2.Documents["CUSTOMS_ENTRY"].Status);
        Assert.Contains(r2.Rejected, x => x.Rule == "F18");

        // a new BL version re-runs reconciliation and the acceptance is gone
        var extended = JsonNode.Parse(commands.ToJsonString())!.AsArray();
        var bl = extended.First(n => n is JsonObject o && (string?)o["cmd"] == "RECEIVE" && (string?)o["type"] == "BILL_OF_LADING")!.AsObject();
        var bl2 = JsonNode.Parse(bl.ToJsonString())!.AsObject(); bl2["version"] = 2; bl2["sha"] = "sha-bl-v2"; bl2["at"] = "2026-03-12";
        extended.Add(bl2);
        var r3 = Engine.Run(JsonNode.Parse(dossier.ToJsonString()) as JsonObject, extended);
        Assert.Null(r3.Reconciliation!.AcceptedBy);
    }
}
