using System.Numerics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace Dalteno.DocRecon.Tests;

/// <summary>One shared case file under /cases.</summary>
public sealed class CaseFile
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public bool Adversarial { get; set; }
    public string? Note { get; set; }
    public ReconcileOptions? Options { get; set; }
    public Bundle? Bundle { get; set; }
    public List<string> Expect { get; set; } = new();
}

/// <summary>
/// Parity gate: every shared case must (1) produce exactly the hand-written expectation set and
/// (2) reproduce the JS golden report structurally (every field of every finding).
/// </summary>
public sealed class SharedCasesTests
{
    private static readonly string CasesDir = Path.Combine(AppContext.BaseDirectory, "cases");

    public static IEnumerable<object[]> CaseIds() =>
        Directory.GetFiles(CasesDir, "*.json").Select(f => Path.GetFileNameWithoutExtension(f)).OrderBy(x => x, StringComparer.Ordinal).Select(x => new object[] { x });

    private static CaseFile Load(string id) =>
        JsonSerializer.Deserialize<CaseFile>(File.ReadAllText(Path.Combine(CasesDir, id + ".json")), Json.Options)
        ?? throw new InvalidOperationException(id);

    [Fact]
    public void AtLeastFortyCasesExist() => Assert.True(CaseIds().Count() >= 40);

    [Theory]
    [MemberData(nameof(CaseIds))]
    public void ExpectationSetMatches(string id)
    {
        var c = Load(id);
        var report = Reconciler.Reconcile(c.Bundle, c.Options ?? ReconcileOptions.Default);
        var got = report.Findings.Select(f => $"{f.Rule}|{f.Key}").OrderBy(x => x, StringComparer.Ordinal).ToList();
        var expected = c.Expect.OrderBy(x => x, StringComparer.Ordinal).ToList();
        Assert.Equal(expected, got);
        foreach (var f in report.Findings)
        {
            Assert.False(string.IsNullOrWhiteSpace(f.Reason));
            Assert.False(string.IsNullOrWhiteSpace(f.Field));
            Assert.NotEmpty(f.Documents);
        }
        var status = report.Summary.BLOCKER > 0 ? "BLOCKED" : report.Summary.WARNING > 0 ? "REVIEW" : "PASS";
        Assert.Equal(status, report.Status);
    }

    [Theory]
    [MemberData(nameof(CaseIds))]
    public void GoldenReportParityWithJs(string id)
    {
        var goldenPath = Path.Combine(CasesDir, "golden", id + ".report.json");
        if (!File.Exists(goldenPath)) return; // golden files are optional locally, mandatory in CI (see workflow)
        var c = Load(id);
        var report = Reconciler.Reconcile(c.Bundle, c.Options ?? ReconcileOptions.Default);
        var mine = JsonNode.Parse(JsonSerializer.Serialize(report, Json.Options))!.ToJsonString(Json.Options);
        var golden = JsonNode.Parse(File.ReadAllText(goldenPath))!.ToJsonString(Json.Options);
        Assert.Equal(golden, mine);
    }

    [Fact]
    public void Deterministic_SameInputSameOutput()
    {
        var c = Load("C50_everything_wrong");
        var a = JsonSerializer.Serialize(Reconciler.Reconcile(c.Bundle), Json.Options);
        var b = JsonSerializer.Serialize(Reconciler.Reconcile(Load("C50_everything_wrong").Bundle), Json.Options);
        Assert.Equal(a, b);
    }

    [Fact]
    public void InputIsNeverMutated()
    {
        var c = Load("C50_everything_wrong");
        var before = JsonSerializer.Serialize(c.Bundle, Json.Options);
        Reconciler.Reconcile(c.Bundle);
        Assert.Equal(before, JsonSerializer.Serialize(c.Bundle, Json.Options));
    }

    [Fact]
    public void NullBundleReportsThreeMissingDocuments()
    {
        var r = Reconciler.Reconcile(null);
        Assert.Equal("BLOCKED", r.Status);
        Assert.Equal(3, r.Findings.Count);
        Assert.All(r.Findings, f => Assert.Equal("R21", f.Rule));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("5")]
    [InlineData("\"x\"")]
    [InlineData("[]")]
    [InlineData("true")]
    public void NonObjectLineEntriesNeverThrow(string badElement)
    {
        // JS parity: a null / non-object line is a line with nothing on it → R21 for that line's SKU, no exception.
        var json = File.ReadAllText(Path.Combine(CasesDir, "C00_clean.json"));
        var root = JsonNode.Parse(json)!.AsObject();
        var bundle = root["bundle"]!.AsObject();
        bundle["invoice"]!["lines"]!.AsArray()[0] = JsonNode.Parse(badElement);
        bundle["packingList"]!["lines"]!.AsArray()[1] = JsonNode.Parse(badElement);
        var b = JsonSerializer.Deserialize<Bundle>(bundle.ToJsonString(), Json.Options)!;
        var report = Reconciler.Reconcile(b, ReconcileOptions.Default);
        Assert.Contains(report.Findings, x => x.Rule == "R21" && x.Key == "invoice.lines[0].sku");
        Assert.Contains(report.Findings, x => x.Rule == "R21" && x.Key == "packingList.lines[1].sku");
    }
}

/// <summary>Helper-level tests mirroring web/tests/cases.test.mjs.</summary>
public sealed class NumericTests
{
    [Theory]
    [InlineData("1200.00", 100, "120000")]
    [InlineData("0.015", 100, "2")]
    [InlineData("-0.015", 100, "-2")]
    [InlineData("1,200.5", 100, "120050")]
    [InlineData("12", 1, "12")]
    [InlineData("12.6", 1, "13")]
    public void ToMinorRoundsHalfAwayFromZero(string input, int scale, string expected)
        => Assert.Equal(BigInteger.Parse(expected), Numeric.ToMinor(input, scale));

    [Theory]
    [InlineData("abc")]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("1.2.3")]
    [InlineData("1.200,00")]
    [InlineData("1,5")]
    [InlineData("12,34,567")]
    [InlineData(null)]
    public void ToMinorRejectsNonNumeric(string? input) => Assert.Null(Numeric.ToMinor(input, 100));

    [Fact]
    public void FromMinorFormats()
    {
        Assert.Equal("-0.05", Numeric.FromMinor(new BigInteger(-5), 100));
        Assert.Equal("12", Numeric.FromMinor(new BigInteger(12), 1));
        Assert.Equal("1840.000", Numeric.FromMinor(new BigInteger(1840000), 1000));
        Assert.Null(Numeric.FromMinor(null, 100));
    }

    [Theory]
    [InlineData(3000, 10, 30)]   // 3 × 0.10 = 0.30
    [InlineData(1500, 1, 2)]     // 1.5 × 0.01 = 0.015 → 0.02
    [InlineData(-1500, 1, -2)]
    [InlineData(2500, 1, 3)]     // 0.025 → 0.03
    public void MulQtyPriceHalfAwayFromZero(long qty, long price, long expected)
        => Assert.Equal(new BigInteger(expected), Numeric.MulQtyPrice(qty, price));

    [Theory]
    [InlineData(2029800, 1990000, 200, false)]
    [InlineData(2031000, 1990000, 200, true)]
    [InlineData(100, 100, 0, false)]
    [InlineData(101, 100, 0, true)]
    public void ExceedsToleranceUsesLargerBase(long a, long b, int bp, bool expected)
        => Assert.Equal(expected, Numeric.ExceedsTolerance(a, b, bp));

    [Theory]
    [InlineData("2026-02-30", false)]
    [InlineData("2028-02-29", true)]
    [InlineData("2027-02-29", false)]
    [InlineData("2026/03/01", false)]
    [InlineData("2026-13-01", false)]
    public void DayNumberValidatesCalendar(string iso, bool valid) => Assert.Equal(valid, Numeric.DayNumber(iso) is not null);

    [Fact]
    public void DayNumberDifferences()
    {
        Assert.Equal(7, Numeric.DayNumber("2026-03-09") - Numeric.DayNumber("2026-03-02"));
        Assert.Equal(365, Numeric.DayNumber("2026-03-01") - Numeric.DayNumber("2025-03-01"));
        Assert.Equal(0, Numeric.DayNumber("1970-01-01"));
    }

    [Fact]
    public void NormPartyStripsPunctuationAndOneTrailingSuffix()
    {
        Assert.Equal("RHEINWERK AUTOMATION", Numeric.NormParty("Rheinwerk Automation, GmbH.", ReconcileOptions.Default.LegalSuffixes));
        Assert.Equal("GMBH", Numeric.NormParty("GmbH", ReconcileOptions.Default.LegalSuffixes));
    }

    [Fact]
    public void RuleCatalogueIsStable()
    {
        Assert.Equal(21, RuleCatalogue.All.Count);
        Assert.Equal(21, RuleCatalogue.All.Select(r => r.Id).Distinct().Count());
    }
}
