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
        Assert.Equal(17, FlowRules.All.Count);
        Assert.Equal(17, FlowRules.All.Select(r => r.Id).Distinct().Count());
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
}
