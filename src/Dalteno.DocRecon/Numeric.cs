using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.RegularExpressions;

namespace Dalteno.DocRecon;

/// <summary>Scales for integer arithmetic (ADR-0002): money in cents, quantities and kilograms in thousandths.</summary>
public static class Scale
{
    /// <summary>Money: 2 decimals.</summary>
    public const int Money = 100;
    /// <summary>Quantity: 3 decimals.</summary>
    public const int Qty = 1000;
    /// <summary>Weight: 3 decimals (grams).</summary>
    public const int Kg = 1000;
    /// <summary>Counts: integers.</summary>
    public const int Unit = 1;
}

/// <summary>Pure numeric and normalisation helpers, bit-for-bit equivalent to web/docrecon.js.</summary>
public static partial class Numeric
{
    [GeneratedRegex(@"^[-+]?(\d+(\.\d*)?|\.\d+)$")]
    private static partial Regex DecimalPattern();

    [GeneratedRegex(@"^[-+]?\d{1,3}(,\d{3})+(\.\d*)?$")]
    private static partial Regex EnglishGrouping();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();

    [GeneratedRegex(@"[.,;:'""()&/\\-]+")]
    private static partial Regex PartyPunctuation();

    [GeneratedRegex(@"[.\s-]")]
    private static partial Regex HsSeparators();

    [GeneratedRegex(@"^\d{6,10}$")]
    private static partial Regex HsDigits();

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}$")]
    private static partial Regex IsoDate();

    /// <summary>
    /// Parse a decimal text into integer minor units, rounding half away from zero on the first dropped digit.
    /// Thousands separators (",") are removed. Returns null for absent or non-numeric input.
    /// </summary>
    /// <param name="value">Raw text, e.g. "1,200.50".</param>
    /// <param name="scale">100 for money, 1000 for qty/kg, 1 for counts.</param>
    public static BigInteger? ToMinor(string? value, int scale)
    {
        if (value is null) return null;
        var raw = value.Trim();
        // Commas only as English thousands separators ("1,200.50"); "1.200,00" / "1,5" → null → R21 (ADR-0002).
        if (raw.Contains(',') && !EnglishGrouping().IsMatch(raw)) return null;
        var s = raw.Replace(",", "");
        if (s.Length == 0 || !DecimalPattern().IsMatch(s)) return null;
        var neg = s.StartsWith('-');
        var body = s.TrimStart('-', '+');
        var dot = body.IndexOf('.');
        var ip = dot < 0 ? body : body[..dot];
        var fp = dot < 0 ? "" : body[(dot + 1)..];
        var digits = scale.ToString(CultureInfo.InvariantCulture).Length - 1;
        var frac = (fp + new string('0', digits + 1))[..(digits + 1)];
        var minor = BigInteger.Parse(ip.Length == 0 ? "0" : ip, CultureInfo.InvariantCulture) * scale
                    + (digits == 0 ? BigInteger.Zero : BigInteger.Parse(frac[..digits], CultureInfo.InvariantCulture));
        if (frac[digits] - '0' >= 5) minor += 1;
        return neg ? -minor : minor;
    }

    /// <summary>Format minor units back to decimal text ("-0.05", "12").</summary>
    public static string? FromMinor(BigInteger? minor, int scale)
    {
        if (minor is null) return null;
        var digits = scale.ToString(CultureInfo.InvariantCulture).Length - 1;
        var m = minor.Value;
        var neg = m < 0;
        var abs = BigInteger.Abs(m);
        var ip = BigInteger.Divide(abs, scale);
        var fp = BigInteger.Remainder(abs, scale).ToString(CultureInfo.InvariantCulture).PadLeft(digits, '0');
        var sb = new StringBuilder();
        if (neg) sb.Append('-');
        sb.Append(ip.ToString(CultureInfo.InvariantCulture));
        if (digits > 0) sb.Append('.').Append(fp);
        return sb.ToString();
    }

    /// <summary>qty(QTY scale) × price(MONEY scale) ÷ QTY → money minor units, half away from zero.</summary>
    public static BigInteger MulQtyPrice(BigInteger qtyMinor, BigInteger priceMinor)
    {
        var num = qtyMinor * priceMinor;
        var den = new BigInteger(Scale.Qty);
        var q = BigInteger.Divide(num, den); // truncates toward zero, like BigInt in JS
        var rem = BigInteger.Abs(BigInteger.Remainder(num, den));
        if (rem * 2 >= den) return q + (num < 0 ? -1 : 1);
        return q;
    }

    /// <summary>|a − b| × 10000 &gt; bp × max(|a|,|b|).</summary>
    public static bool ExceedsTolerance(BigInteger a, BigInteger b, int bp)
    {
        var diff = BigInteger.Abs(a - b);
        var baseValue = BigInteger.Max(BigInteger.Abs(a), BigInteger.Abs(b));
        return diff * 10000 > new BigInteger(bp) * baseValue;
    }

    /// <summary>Trim, collapse whitespace, uppercase (invariant). Null → "".</summary>
    public static string NormKey(string? s) => s is null ? "" : Whitespace().Replace(s.Trim(), " ").ToUpperInvariant();

    /// <summary>Party-name normalisation: NormKey, punctuation → space, drop trailing legal suffixes (never to empty).</summary>
    public static string NormParty(string? s, IReadOnlyList<string> suffixes)
    {
        var tokens = PartyPunctuation().Replace(NormKey(s), " ").Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        while (tokens.Count > 1 && suffixes.Contains(tokens[^1])) tokens.RemoveAt(tokens.Count - 1);
        return string.Join(' ', tokens);
    }

    /// <summary>Strip dots, spaces and dashes from an HS code.</summary>
    public static string NormHs(string? s) => s is null ? "" : HsSeparators().Replace(s, "");

    /// <summary>True when the normalised HS code is 6–10 digits.</summary>
    public static bool IsValidHs(string normalised) => HsDigits().IsMatch(normalised);

    /// <summary>ISO "YYYY-MM-DD" → day number (days since 1970-01-01, proleptic Gregorian), or null when invalid.</summary>
    public static long? DayNumber(string? iso)
    {
        if (iso is null || !IsoDate().IsMatch(iso)) return null;
        var y = int.Parse(iso[..4], CultureInfo.InvariantCulture);
        var m = int.Parse(iso[5..7], CultureInfo.InvariantCulture);
        var d = int.Parse(iso[8..10], CultureInfo.InvariantCulture);
        if (m < 1 || m > 12 || d < 1) return null;
        var leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        int[] dim = { 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
        if (d > dim[m - 1]) return null;
        long yy = m <= 2 ? y - 1 : y;
        var era = FloorDiv(yy, 400);
        var yoe = yy - era * 400;
        var doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
        var doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }

    private static long FloorDiv(long a, long b) => a >= 0 ? a / b : -((-a + b - 1) / b);
}
