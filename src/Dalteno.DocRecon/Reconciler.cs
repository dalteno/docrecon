using System.Numerics;
using static Dalteno.DocRecon.Numeric;

namespace Dalteno.DocRecon;

/// <summary>
/// Deterministic reconciliation of Commercial Invoice ↔ Packing List ↔ Bill of Lading.
/// No I/O, no clock, no randomness: same bundle + same options ⇒ same report.
/// Mirrors web/docrecon.js rule for rule; the shared cases under /cases are the parity gate.
/// </summary>
public static class Reconciler
{
    /// <summary>Engine version (reported in every <see cref="Report"/>).</summary>
    public const string Version = "1.0.0";

    private sealed class InvAgg { public BigInteger? Qty; public BigInteger? Price; public BigInteger? Total; public string Hs = ""; public string Unit = ""; public bool DupFlagged; }
    private sealed class PlAgg { public BigInteger? Qty; public BigInteger? Net; public BigInteger? Gross; public BigInteger? Pk; public string Hs = ""; public string Unit = ""; }

    /// <summary>Reconcile a bundle with default options.</summary>
    public static Report Reconcile(Bundle? bundle) => Reconcile(bundle, ReconcileOptions.Default);

    /// <summary>Reconcile a bundle.</summary>
    /// <param name="bundle">Invoice, packing list and bill of lading (any may be null → R21).</param>
    /// <param name="options">Tolerances and vocabularies.</param>
    /// <returns>Report with findings ordered by rule id, then key.</returns>
    public static Report Reconcile(Bundle? bundle, ReconcileOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        var opt = options;
        var findings = new List<Finding>();
        void Add(string ruleId, string key, string field, string? expected, string? actual, string reason, params string[] documents)
        {
            var rule = RuleCatalogue.Get(ruleId);
            findings.Add(new Finding(rule.Id, rule.Code, rule.Severity, key, field, expected, actual, reason, documents));
        }

        var inv = bundle?.Invoice; var pl = bundle?.PackingList; var bl = bundle?.BillOfLading;

        // R21 structural requirements — other rules skip what is absent (never crash, never guess)
        if (inv is null) Add("R21", "invoice", "invoice", "document", "absent", "Commercial invoice is required.", "invoice");
        if (pl is null) Add("R21", "packingList", "packingList", "document", "absent", "Packing list is required.", "packingList");
        if (bl is null) Add("R21", "billOfLading", "billOfLading", "document", "absent", "Bill of lading is required.", "billOfLading");
        bool Req(object? doc, string name, string field, Func<bool> present)
        {
            if (doc is null) return false;
            var ok = present();
            if (!ok) Add("R21", $"{name}.{field}", field, "present", "absent", $"{name}.{field} is required.", name);
            return ok;
        }
        static bool Has(string? v) => v is not null && v.Trim().Length > 0;
        static bool Given(string? v) => v is { Length: > 0 }; // JS truthiness: "" is absent, " " is present
        var invNo = Req(inv, "invoice", "number", () => Has(inv!.Number));
        var invCur = Req(inv, "invoice", "currency", () => Has(inv!.Currency));
        var invLines = Req(inv, "invoice", "lines", () => inv!.Lines is { Count: > 0 });
        var invTotal = Req(inv, "invoice", "total", () => Has(inv!.Total));
        var plNo = Req(pl, "packingList", "number", () => Has(pl!.Number));
        var plLines = Req(pl, "packingList", "lines", () => pl!.Lines is { Count: > 0 });
        Req(bl, "billOfLading", "number", () => Has(bl!.Number));

        // ── per-line validation + aggregation per SKU ──
        var invBySku = new Dictionary<string, InvAgg>(); var invOrder = new List<string>();
        var plBySku = new Dictionary<string, PlAgg>(); var plOrder = new List<string>();
        void NonPositive(string name, int idx, string sku, string field, BigInteger? minor)
        {
            if (minor is not null && minor.Value <= 0)
            {
                var scale = field == "qty" ? Scale.Qty : field is "unitPrice" or "lineTotal" ? Scale.Money : Scale.Kg;
                Add("R16", $"{name}:{sku}:{field}", field, "> 0", FromMinor(minor, scale), $"{name} line {idx + 1} ({sku}) has a non-positive {field}.", name);
            }
        }
        static bool HsGiven(string? hs) => hs is not null && hs.Length > 0;

        if (invLines)
        {
            for (var i = 0; i < inv!.Lines!.Count; i++)
            {
                var ln = inv.Lines[i] ?? new InvoiceLine(); // a null / non-object line is a line with nothing on it (JS parity)
                var sku = NormKey(ln.Sku);
                if (sku.Length == 0) { Add("R21", $"invoice.lines[{i}].sku", "sku", "present", "absent", $"Invoice line {i + 1} has no SKU.", "invoice"); continue; }
                var qty = ToMinor(ln.Qty, Scale.Qty); var price = ToMinor(ln.UnitPrice, Scale.Money); var total = ToMinor(ln.LineTotal, Scale.Money);
                NonPositive("invoice", i, sku, "qty", qty); NonPositive("invoice", i, sku, "unitPrice", price);
                if (qty is null) Add("R21", $"invoice:{sku}:qty", "qty", "number", ln.Qty ?? "absent", $"Invoice line {sku}: qty is not a number.", "invoice");
                if (price is null) Add("R21", $"invoice:{sku}:unitPrice", "unitPrice", "number", ln.UnitPrice ?? "absent", $"Invoice line {sku}: unitPrice is not a number.", "invoice");
                if (total is null) Add("R21", $"invoice:{sku}:lineTotal", "lineTotal", "number", ln.LineTotal ?? "absent", $"Invoice line {sku}: lineTotal is not a number.", "invoice");
                if (qty is not null && price is not null && total is not null)
                {
                    var calc = MulQtyPrice(qty.Value, price.Value);
                    var diff = BigInteger.Abs(calc - total.Value);
                    if (diff > opt.AmountToleranceMinor)
                        Add("R06", sku, "lineTotal", FromMinor(calc, Scale.Money), FromMinor(total, Scale.Money), $"{FromMinor(qty, Scale.Qty)} × {FromMinor(price, Scale.Money)} = {FromMinor(calc, Scale.Money)}, invoice says {FromMinor(total, Scale.Money)}.", "invoice");
                }
                if (invCur && Given(ln.Currency) && NormKey(ln.Currency) != NormKey(inv.Currency))
                    Add("R08", sku, "currency", NormKey(inv.Currency), NormKey(ln.Currency), $"Line {sku} is priced in {NormKey(ln.Currency)} but the invoice currency is {NormKey(inv.Currency)}.", "invoice");
                var hs = NormHs(ln.HsCode);
                if (HsGiven(ln.HsCode) && !IsValidHs(hs))
                    Add("R13", $"invoice:{sku}", "hsCode", "6–10 digits", ln.HsCode, $"Invoice line {sku}: HS code \"{ln.HsCode}\" is not 6–10 digits.", "invoice");
                if (invBySku.TryGetValue(sku, out var agg))
                {
                    if ((price is not null && agg.Price is not null && price != agg.Price) || (hs.Length > 0 && agg.Hs.Length > 0 && hs != agg.Hs))
                    {
                        if (!agg.DupFlagged)
                        {
                            Add("R15", sku, "sku", $"one price/HS for {sku}", $"{FromMinor(agg.Price, Scale.Money) ?? "null"}/{(agg.Hs.Length > 0 ? agg.Hs : "-")} vs {FromMinor(price, Scale.Money) ?? "null"}/{(hs.Length > 0 ? hs : "-")}", $"SKU {sku} appears more than once on the invoice with conflicting unit price or HS code.", "invoice");
                            agg.DupFlagged = true;
                        }
                    }
                    agg.Qty = Sum(agg.Qty, qty); agg.Total = Sum(agg.Total, total);
                }
                else { invBySku[sku] = new InvAgg { Qty = qty, Price = price, Total = total, Hs = hs, Unit = NormKey(ln.Unit) }; invOrder.Add(sku); }
            }
        }
        if (plLines)
        {
            for (var i = 0; i < pl!.Lines!.Count; i++)
            {
                var ln = pl.Lines[i] ?? new PackingLine();
                var sku = NormKey(ln.Sku);
                if (sku.Length == 0) { Add("R21", $"packingList.lines[{i}].sku", "sku", "present", "absent", $"Packing line {i + 1} has no SKU.", "packingList"); continue; }
                var qty = ToMinor(ln.Qty, Scale.Qty); var net = ToMinor(ln.NetKg, Scale.Kg); var gross = ToMinor(ln.GrossKg, Scale.Kg); var pk = ToMinor(ln.Packages, Scale.Unit);
                NonPositive("packingList", i, sku, "qty", qty); NonPositive("packingList", i, sku, "netKg", net); NonPositive("packingList", i, sku, "grossKg", gross);
                if (pk is not null && pk.Value <= 0) Add("R16", $"packingList:{sku}:packages", "packages", "> 0", FromMinor(pk, Scale.Unit), $"Packing line {i + 1} ({sku}) has a non-positive package count.", "packingList");
                if (qty is null) Add("R21", $"packingList:{sku}:qty", "qty", "number", ln.Qty ?? "absent", $"Packing line {sku}: qty is not a number.", "packingList");
                if (net is not null && gross is not null && net.Value > gross.Value)
                    Add("R10", sku, "netKg", $"≤ gross {FromMinor(gross, Scale.Kg)}", FromMinor(net, Scale.Kg), $"Packing line {sku}: net {FromMinor(net, Scale.Kg)} kg exceeds gross {FromMinor(gross, Scale.Kg)} kg.", "packingList");
                var hs = NormHs(ln.HsCode);
                if (HsGiven(ln.HsCode) && !IsValidHs(hs))
                    Add("R13", $"packingList:{sku}", "hsCode", "6–10 digits", ln.HsCode, $"Packing line {sku}: HS code \"{ln.HsCode}\" is not 6–10 digits.", "packingList");
                if (plBySku.TryGetValue(sku, out var agg))
                {
                    agg.Qty = Sum(agg.Qty, qty); agg.Net = Sum(agg.Net, net); agg.Gross = Sum(agg.Gross, gross); agg.Pk = Sum(agg.Pk, pk);
                    if (agg.Hs.Length == 0) agg.Hs = hs;
                }
                else { plBySku[sku] = new PlAgg { Qty = qty, Net = net, Gross = gross, Pk = pk, Hs = hs, Unit = NormKey(ln.Unit) }; plOrder.Add(sku); }
            }
        }

        // ── cross-document line rules ──
        if (invLines && plLines)
        {
            foreach (var sku in invOrder)
            {
                var a = invBySku[sku];
                if (!plBySku.TryGetValue(sku, out var b)) { Add("R03", sku, "sku", "present on packing list", "absent", $"Invoiced SKU {sku} is not on the packing list.", "invoice", "packingList"); continue; }
                if (a.Qty is not null && b.Qty is not null && ExceedsTolerance(a.Qty.Value, b.Qty.Value, opt.QtyToleranceBp))
                    Add("R05", sku, "qty", FromMinor(a.Qty, Scale.Qty), FromMinor(b.Qty, Scale.Qty), $"SKU {sku}: invoiced {FromMinor(a.Qty, Scale.Qty)}, packed {FromMinor(b.Qty, Scale.Qty)}.", "invoice", "packingList");
                if (a.Unit.Length > 0 && b.Unit.Length > 0 && a.Unit != b.Unit)
                    Add("R19", sku, "unit", a.Unit, b.Unit, $"SKU {sku}: invoice unit {a.Unit}, packing unit {b.Unit}.", "invoice", "packingList");
                if (a.Hs.Length > 0 && b.Hs.Length > 0 && a.Hs != b.Hs)
                    Add("R14", sku, "hsCode", a.Hs, b.Hs, $"SKU {sku}: HS {a.Hs} on invoice, {b.Hs} on packing list.", "invoice", "packingList");
            }
            foreach (var sku in plOrder)
                if (!invBySku.ContainsKey(sku)) Add("R04", sku, "sku", "present on invoice", "absent", $"Packed SKU {sku} is not on the invoice.", "invoice", "packingList");
        }

        // ── invoice totals ──
        if (invLines && invTotal)
        {
            BigInteger sumLines = 0; var complete = true;
            foreach (var a in invBySku.Values) { if (a.Total is null) { complete = false; break; } sumLines += a.Total.Value; }
            var total = ToMinor(inv!.Total, Scale.Money);
            if (total is null) Add("R21", "invoice.total", "total", "number", inv.Total, "Invoice total is not a number.", "invoice");
            else if (complete)
            {
                var diff = BigInteger.Abs(sumLines - total.Value);
                if (diff > opt.AmountToleranceMinor)
                    Add("R07", "invoice", "total", FromMinor(sumLines, Scale.Money), FromMinor(total, Scale.Money), $"Line totals sum to {FromMinor(sumLines, Scale.Money)}, invoice total is {FromMinor(total, Scale.Money)}.", "invoice");
            }
        }
        if (inv is not null && Given(inv.Incoterm) && !opt.KnownIncoterms.Contains(NormKey(inv.Incoterm)))
            Add("R18", "invoice", "incoterm", string.Join('/', opt.KnownIncoterms), inv.Incoterm, $"Incoterm \"{inv.Incoterm}\" is not an Incoterms 2020 code.", "invoice");

        // ── packing list totals vs its lines ──
        BigInteger? plPk = null, plNet = null, plGross = null;
        if (plLines)
        {
            BigInteger sPk = 0, sNet = 0, sGross = 0; bool cPk = true, cNet = true, cGross = true;
            foreach (var b in plBySku.Values)
            {
                if (b.Pk is null) cPk = false; else sPk += b.Pk.Value;
                if (b.Net is null) cNet = false; else sNet += b.Net.Value;
                if (b.Gross is null) cGross = false; else sGross += b.Gross.Value;
            }
            BigInteger? Chk(string field, string? declared, BigInteger s, bool complete, int scale)
            {
                var d = ToMinor(declared, scale);
                if (d is null) return complete ? s : null;
                if (complete && d.Value != s)
                    Add("R20", field, field, FromMinor(s, scale), FromMinor(d, scale), $"Packing list declares {field} {FromMinor(d, scale)}, lines sum to {FromMinor(s, scale)}.", "packingList");
                return d;
            }
            plPk = Chk("totalPackages", pl!.TotalPackages, sPk, cPk, Scale.Unit);
            plNet = Chk("totalNetKg", pl.TotalNetKg, sNet, cNet, Scale.Kg);
            plGross = Chk("totalGrossKg", pl.TotalGrossKg, sGross, cGross, Scale.Kg);
            if (plNet is not null && plGross is not null && plNet.Value > plGross.Value)
                Add("R10", "TOTAL", "totalNetKg", $"≤ gross {FromMinor(plGross, Scale.Kg)}", FromMinor(plNet, Scale.Kg), $"Packing list total net {FromMinor(plNet, Scale.Kg)} kg exceeds total gross {FromMinor(plGross, Scale.Kg)} kg.", "packingList");
        }

        // ── references ──
        if (pl is not null && invNo && plNo)
        {
            var r = NormKey(pl.InvoiceRef);
            if (r.Length == 0) Add("R21", "packingList.invoiceRef", "invoiceRef", "present", "absent", "Packing list must reference an invoice number.", "packingList");
            else if (r != NormKey(inv!.Number)) Add("R01", "invoiceRef", "invoiceRef", NormKey(inv.Number), r, $"Packing list references invoice {r}, invoice number is {NormKey(inv.Number)}.", "invoice", "packingList");
        }
        if (pl is not null && bl is not null)
        {
            var a = NormKey(pl.ShipmentRef); var b = NormKey(bl.ShipmentRef);
            if (a.Length == 0 || b.Length == 0) Add("R21", "shipmentRef", "shipmentRef", "present on both", $"{(a.Length > 0 ? a : "absent")} / {(b.Length > 0 ? b : "absent")}", "Shipment reference must be present on packing list and bill of lading.", "packingList", "billOfLading");
            else if (a != b) Add("R02", "shipmentRef", "shipmentRef", a, b, $"Packing list shipment ref {a}, bill of lading shipment ref {b}.", "packingList", "billOfLading");
        }

        // ── BL vs packing list physicals ──
        if (bl is not null && plLines)
        {
            var blGross = ToMinor(bl.GrossKg, Scale.Kg); var blPk = ToMinor(bl.Packages, Scale.Unit);
            if (blGross is not null && blGross.Value <= 0) Add("R16", "billOfLading:grossKg", "grossKg", "> 0", FromMinor(blGross, Scale.Kg), "Bill of lading gross weight is non-positive.", "billOfLading");
            if (blPk is not null && blPk.Value <= 0) Add("R16", "billOfLading:packages", "packages", "> 0", FromMinor(blPk, Scale.Unit), "Bill of lading package count is non-positive.", "billOfLading");
            if (blGross is not null && plGross is not null && blGross.Value > 0 && plGross.Value > 0 && ExceedsTolerance(blGross.Value, plGross.Value, opt.WeightToleranceBp))
                Add("R09", "grossKg", "grossKg", FromMinor(plGross, Scale.Kg), FromMinor(blGross, Scale.Kg), $"BL gross {FromMinor(blGross, Scale.Kg)} kg vs packing {FromMinor(plGross, Scale.Kg)} kg exceeds {(opt.WeightToleranceBp / 100.0).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)} % tolerance.", "packingList", "billOfLading");
            if (blPk is not null && plPk is not null && blPk.Value > 0 && plPk.Value > 0 && ExceedsTolerance(blPk.Value, plPk.Value, opt.PackageToleranceBp))
                Add("R11", "packages", "packages", FromMinor(plPk, Scale.Unit), FromMinor(blPk, Scale.Unit), $"BL declares {blPk} packages, packing list {plPk}.", "packingList", "billOfLading");
        }

        // ── parties ──
        if (inv is not null && bl is not null && Given(inv.Buyer) && Given(bl.Consignee))
        {
            var a = NormParty(inv.Buyer, opt.LegalSuffixes); var b = NormParty(bl.Consignee, opt.LegalSuffixes);
            if (a != b) Add("R17", "consignee", "consignee", inv.Buyer, bl.Consignee, $"BL consignee \"{bl.Consignee}\" does not match invoice buyer \"{inv.Buyer}\" after normalisation ({a} ≠ {b}).", "invoice", "billOfLading");
        }

        // ── dates ──
        var di = inv is null ? null : DayNumber(inv.Date);
        var dp = pl is null ? null : DayNumber(pl.Date);
        var db = bl is null ? null : DayNumber(bl.Date);
        if (inv is not null && Given(inv.Date) && di is null) Add("R21", "invoice.date", "date", "YYYY-MM-DD", inv.Date, "Invoice date is not a valid ISO date.", "invoice");
        if (pl is not null && Given(pl.Date) && dp is null) Add("R21", "packingList.date", "date", "YYYY-MM-DD", pl.Date, "Packing list date is not a valid ISO date.", "packingList");
        if (bl is not null && Given(bl.Date) && db is null) Add("R21", "billOfLading.date", "date", "YYYY-MM-DD", bl.Date, "Bill of lading date is not a valid ISO date.", "billOfLading");
        if (di is not null && dp is not null && di > dp) Add("R12", "invoice>packing", "date", "invoice ≤ packing", $"{inv!.Date} > {pl!.Date}", $"Invoice ({inv.Date}) is dated after the packing list ({pl.Date}).", "invoice", "packingList");
        if (dp is not null && db is not null && dp > db) Add("R12", "packing>bl", "date", "packing ≤ shipped on board", $"{pl!.Date} > {bl!.Date}", $"Packing list ({pl.Date}) is dated after shipped-on-board ({bl.Date}).", "packingList", "billOfLading");
        if (di is not null && db is not null && db - di > opt.MaxDocumentSpanDays) Add("R12", "span", "date", $"≤ {opt.MaxDocumentSpanDays} days", $"{db - di} days", $"{db - di} days between invoice and shipped-on-board exceeds {opt.MaxDocumentSpanDays}.", "invoice", "billOfLading");

        // deterministic order: rule id, then key (ordinal — same as JS string comparison)
        var ordered = findings.OrderBy(f => f.Rule, StringComparer.Ordinal).ThenBy(f => f.Key, StringComparer.Ordinal).ToList();
        var summary = new Summary(ordered.Count(f => f.Severity == Severity.BLOCKER), ordered.Count(f => f.Severity == Severity.WARNING), ordered.Count(f => f.Severity == Severity.INFO));
        var status = summary.BLOCKER > 0 ? "BLOCKED" : summary.WARNING > 0 ? "REVIEW" : "PASS";
        return new Report(Version, status, RuleCatalogue.All.Count, summary, ordered);
    }

    private static BigInteger? Sum(BigInteger? a, BigInteger? b) => a is null || b is null ? null : a.Value + b.Value;
}
